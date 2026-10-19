# Plano de Arquitetura: Servidor Evolution API para Bots de WhatsApp

Oct 18, 2026 · @gss

## Resumo

A recomendação é um único servidor (VPS de 4 vCPU e 8 GB) com Docker Compose, onde a Evolution API fica em rede privada e só o Bot Center, um gateway próprio, recebe tráfego de fora. O Bot Center autentica as APIs e serviços clientes, enfileira os envios, aplica limites por número e roda a state machine das conversas.

Objetivos e como o plano atende cada um:

| Objetivo | Decisão principal |
| --- | --- |
| Performance | Envio assíncrono por fila (resposta 202), Redis para cache e estado quente, um worker por tipo de trabalho |
| Baixo custo | Um VPS no início, Postgres e Redis no mesmo host, mídia em storage S3 sem custo de saída (Cloudflare R2), escala só quando a métrica pedir |
| Segurança | Evolution API nunca exposta, chaves por cliente com escopo e hash, webhooks assinados com HMAC, firewall fechado e backups cifrados |
| Uso por APIs e serviços | API REST versionada (`/v1`), idempotência por `Idempotency-Key`, eventos por webhook assinado |

Premissa: a stack segue a dos outros projetos (Node.js com NestJS, Prisma e PostgreSQL 16). Os valores de custo e de memória são estimativas para validar com teste de carga.

## Visão geral

&#91;embedded content: arquitetura da fase 1 · um VPS, seis containers\]

O tráfego dos clientes entra só pelo Bot Center; a Evolution conversa com o WhatsApp e avisa o Bot Center por um webhook interno, e os workers fazem todo o trabalho lento fora da requisição.

## Componentes e tecnologias

Cada componente roda como um container no mesmo host na fase 1, e todos menos o proxy ficam só na rede interna do Docker.

| Componente | Tecnologia | Papel | Exposto? |
| --- | --- | --- | --- |
| Proxy de borda | Caddy 2 (TLS automático) atrás do Cloudflare | TLS, HTTP/2, limite de tamanho de corpo, só encaminha para o Bot Center | Sim, porta 443 |
| Bot Center API | NestJS 11 com adaptador Fastify | Autenticação dos clientes, cadastro de instâncias e bots, entrada de mensagens, saída de eventos | Via proxy |
| Bot Center workers | Mesmo código, processo separado (`ROLE=worker`) | Envio para a Evolution, processamento de eventos recebidos, state machine, entrega de webhooks | Não |
| Evolution API | Imagem oficial v2.x com tag fixa | Sessões do WhatsApp (Baileys ou Cloud API oficial), envio e recebimento | Não |
| PostgreSQL 16 | Um cluster, dois bancos: `evolution` e `botcenter` | Dados da Evolution e do Bot Center (estado das conversas, auditoria, outbox) | Não |
| Redis 7 | Um container com AOF ligado | Cache da Evolution, filas BullMQ, rate limit, locks e estado quente das conversas | Não |
| Storage de mídia | Cloudflare R2 (S3) | Arquivos de mídia enviados e recebidos | URLs assinadas com validade curta |

Escolhas que valem registrar:

- **BullMQ no Redis para as filas**, e não pg-boss: o volume de mensagens é alto e curto, e o Redis já existe para a Evolution. pg-boss segue bom para jobs agendados de baixo volume (limpeza, relatórios).
- **Gateway próprio na frente da Evolution**: a Evolution tem só uma chave global e tokens por instância, sem escopos, cotas ou auditoria por cliente. O Bot Center cobre isso e isola os clientes de mudanças na API da Evolution.
- **Provedor abstraído**: o Bot Center fala com uma interface `WhatsAppProvider`. A Evolution com Baileys é a primeira implementação; a WhatsApp Cloud API oficial (pela própria Evolution ou direto) entra para números críticos sem trocar o contrato dos clientes.
- **Gravação mínima na Evolution**: desligar as flags `DATABASE_SAVE_DATA_*` que o Bot Center não usa (histórico, contatos, chats) reduz disco e I/O. O Bot Center guarda só o que precisa.

## Fluxos

### Envio de mensagem (cliente para WhatsApp)

1. O serviço cliente chama `POST /v1/messages` com a chave de API e um `Idempotency-Key`.
2. O Bot Center valida a chave, o escopo e a cota do cliente, e grava a mensagem com status `queued`.
3. O Bot Center responde `202 Accepted` com o `id` da mensagem. O cliente não espera o WhatsApp.
4. Um worker pega o job da fila da instância e pede um token ao rate limiter da instância no Redis.
5. Sem token, o job volta para a fila com atraso. Com token, o worker chama a Evolution na rede interna.
6. O worker grava o resultado (`sent` ou `failed` com o motivo) e publica o evento para o cliente.
7. As confirmações de entrega e leitura chegam depois pela Evolution e mudam o status para `delivered` ou `read`.

### Recebimento de mensagem (WhatsApp para bot)

1. A Evolution envia o evento `messages.upsert` para o webhook interno do Bot Center, com um segredo no header.
2. O Bot Center checa o segredo, descarta duplicados pelo id da mensagem do WhatsApp (chave no Redis com TTL de 24 h) e enfileira o evento.
3. O Bot Center responde 200 logo em seguida, para a Evolution não acumular eventos.
4. Um worker processa os eventos de uma mesma conversa em ordem, com um lock por conversa no Redis.
5. O worker carrega o estado da conversa, aplica a transição e grava o novo estado e as ações na mesma transação (padrão outbox).
6. As ações geram envios (fluxo acima) e webhooks para o serviço dono do bot.

### State machine das conversas

- Cada bot tem uma definição versionada em JSON: estados, transições, condições (texto, botão, regex, chamada a serviço externo) e ações (enviar mensagem, chamar webhook, mudar variável, passar para humano).
- Cada conversa é a chave `(instância, contato)` e guarda o estado atual, a versão da definição, as variáveis e um contador de versão para controle otimista.
- Uma conversa fica na versão da definição com que começou. Uma nova versão vale só para conversas novas, para não quebrar fluxos em andamento.
- Timeouts de estado (por exemplo, "sem resposta em 30 min") viram jobs com atraso no BullMQ, com id determinístico para cancelar quando a conversa avança.
- O estado quente fica no Redis com TTL; o Postgres é a fonte da verdade. Se o Redis cair, o worker lê do Postgres e segue mais lento.

## Performance

O ganho principal vem de tirar o WhatsApp do caminho da requisição: o cliente recebe 202 em poucos milissegundos e os workers absorvem picos pela fila.

- **Filas por tipo**: `outbound` (envios), `inbound` (eventos recebidos), `webhooks` (entrega aos clientes) e `timers` (timeouts). Um pico de webhooks lentos não atrasa os envios.
- **Rate limit por instância**: token bucket em script Lua no Redis, com taxa configurável por número. Isso protege contra ban e evita enviar rajadas para a Evolution.
- **Prioridade**: respostas a uma mensagem do usuário têm prioridade sobre envios em massa, pela opção `priority` do BullMQ.
- **Ordem por conversa**: lock curto por conversa no Redis, e não um worker por conversa. Conversas diferentes rodam em paralelo.
- **Banco**: índices em `(instance_id, contact_id)` e em `(status, created_at)`; PgBouncer em modo transaction quando houver mais de um processo de API; particionar a tabela de mensagens por mês quando passar de dezenas de milhões de linhas.
- **Retenção curta**: payloads brutos de eventos ficam 7 dias e depois saem por job. Isso mantém índices pequenos e backups rápidos.
- **Node.js**: Fastify em vez de Express, logs em JSON com pino em modo assíncrono, keep-alive HTTP para a Evolution, `--max-old-space-size` ajustado ao limite do container.
- **Teste de carga antes de produção**: k6 contra `POST /v1/messages` com a Evolution em modo de teste, para medir latência p95 da API, vazão dos workers e memória por instância conectada.

## Baixo custo

A fase 1 custa por volta de 10 a 15 dólares por mês, quase tudo o VPS. Os preços abaixo são aproximados, de memória, e precisam de conferência no site de cada fornecedor antes da compra.

Com o volume baixo previsto no início (só o PersonalLife conectado), um Hetzner CX22 (2 vCPU, 4 GB, cerca de US$ 5 por mês) basta para começar. Passar para o CX32 é um redimensionamento com poucos minutos de parada, feito quando os gatilhos abaixo dispararem.

| Item | Escolha | Custo aproximado por mês |
| --- | --- | --- |
| Servidor | Hetzner Cloud CX32 (4 vCPU x86, 8 GB, 80 GB NVMe), região mais próxima dos usuários | US$ 8 a 9 |
| Snapshots do servidor | Backup automático do Hetzner (20% do servidor) | US$ 2 |
| Backup do banco e mídia | Cloudflare R2, até 10 GB sem custo e sem taxa de saída | US$ 0 a 2 |
| DNS, TLS, WAF básico | Cloudflare plano Free | US$ 0 |
| Logs, métricas, alertas | Grafana Cloud Free e Uptime Kuma no próprio host | US$ 0 |

Regras para manter o custo baixo:

- **Um host até a métrica pedir mais**. Os gatilhos para crescer são: CPU acima de 70% por 15 min nos picos, memória acima de 80%, ou atraso da fila `outbound` acima de 30 s.
- **Limites de memória por container** no Compose, para um processo não derrubar o host. Uma divisão inicial para 8 GB: Evolution 3 GB, Postgres 2 GB, Redis 512 MB, API 512 MB, workers 1 GB, folga para o sistema.
- **A memória por número conectado na Evolution é o fator que mais pesa**. O teste de carga mede esse valor e define quantos números cabem por host.
- **Sem serviços gerenciados na fase 1**. Postgres e Redis gerenciados custam mais que o próprio VPS; eles entram quando a operação justificar.
- **Fly.io como alternativa**, se a ideia for manter o padrão dos outros projetos. O custo sobe, porque cada processo e o volume do Postgres viram itens separados.

## Segurança

A regra central é que a Evolution API nunca recebe tráfego da internet: quem tem a chave global da Evolution controla todos os números, então só o Bot Center conhece essa chave.

### Rede e host

- Firewall do provedor com entrada só na porta 443, e só vinda dos IPs do Cloudflare. SSH só por Tailscale ou WireGuard, com chave e sem senha.
- Evolution, Postgres e Redis só na rede interna do Docker, sem `ports:` no Compose.
- Atualizações automáticas de segurança do sistema (`unattended-upgrades`) e fail2ban.
- Containers sem root, com `read_only: true` onde der, `no-new-privileges` e sem acesso ao socket do Docker.
- Imagens com tag fixa e digest; Renovate ou Dependabot abre PR para cada versão nova, e Trivy varre as imagens no CI.

### Autenticação e autorização

- Cada serviço cliente recebe uma chave própria, com prefixo visível (por exemplo, `bc_live_`) e segredo guardado só como hash SHA-256 com pepper.
- Cada chave tem escopos (`messages:send`, `instances:manage`, `bots:write`, `events:read`) e fica presa a um tenant e a um conjunto de instâncias.
- Rotação sem parada: duas chaves ativas por cliente durante a troca. Revogação imediata pelo cache no Redis.
- Opcional para clientes internos: lista de IPs permitidos por chave, ou mTLS pelo Cloudflare.
- Rate limit e cota por chave, além do limite por instância, para um cliente não esgotar os números dos outros.

### Segredos

- Segredos em arquivo `.env` com permissão 600 fora do repositório, ou SOPS com age no repositório de infraestrutura. Nunca em imagem nem em log.
- `AUTHENTICATION_API_KEY` da Evolution, senha do Postgres e segredo do webhook interno com 32 bytes aleatórios cada.

### Dados e LGPD

- Telefone e conteúdo de mensagens são dados pessoais. Retenção curta por padrão (payload bruto 7 dias, mensagens 90 dias, configurável por tenant) e job de expurgo.
- Disco cifrado no provedor e backups cifrados com restic antes de sair do host.
- Auditoria de ações administrativas (criar instância, ler QR code, trocar chave) em tabela só de inserção.
- Logs sem conteúdo de mensagem e com telefone mascarado.

### Risco de ban do WhatsApp

- A conexão Baileys não é oficial. O WhatsApp pode banir um número por volume alto, envio sem opt-in ou padrão de robô.
- Mitigações: rate limit por número, aquecimento gradual de números novos, atraso de digitação nas respostas, só responder ou enviar para quem deu opt-in.
- Para números de negócio críticos, usar a WhatsApp Cloud API oficial pela mesma interface `WhatsAppProvider`.

## API para serviços clientes

O contrato é REST com JSON, versionado em `/v1`, descrito em OpenAPI 3.1 e gerado a partir de schemas Zod, para os clientes gerarem SDKs.

| Método e rota | Escopo | O que faz |
| --- | --- | --- |
| `POST /v1/messages` | `messages:send` | Enfileira texto, mídia, botões ou lista; responde 202 com `id` |
| `GET /v1/messages/{id}` | `messages:send` | Status: `queued`, `sent`, `delivered`, `read`, `failed` |
| `POST /v1/instances` | `instances:manage` | Cria uma instância para um dono externo (ver Cadastro de números por API) |
| `POST /v1/instances/{id}/connect` | `instances:manage` | Abre a conexão (QR code ou código de pareamento) e devolve um `connect_token`; ação auditada |
| `GET /v1/instances/{id}` | `instances:manage` | Estado da conexão e limites |
| `PUT /v1/bots/{id}` | `bots:write` | Publica uma nova versão da definição da state machine |
| `GET /v1/conversations/{id}` | `bots:write` | Estado atual, variáveis e histórico de transições |
| `POST /v1/conversations/{id}/handoff` | `bots:write` | Passa a conversa para atendimento humano ou devolve ao bot |
| `POST /v1/webhooks` | `events:read` | Cadastra URL e tipos de evento a receber |

Regras do contrato:

- **Idempotência**: toda escrita aceita `Idempotency-Key`. A chave fica 24 h; a mesma chave com o mesmo corpo devolve a resposta original, e com corpo diferente devolve 409.
- **Erros**: formato RFC 9457 (`application/problem+json`) com `type`, `title`, `detail` e um `code` estável.
- **Limites**: headers `RateLimit-Limit`, `RateLimit-Remaining` e `Retry-After` em respostas 429.
- **Eventos de saída**: `message.received`, `message.status`, `conversation.transitioned`, `instance.status`. Cada entrega tem `id` único, header `Webhook-Signature` com HMAC-SHA256 de `timestamp.corpo` e header `Webhook-Timestamp`; o cliente recusa eventos com mais de 5 min.
- **Entrega de eventos**: at-least-once com retentativa exponencial (por exemplo, 1 min, 5 min, 30 min, 2 h, 6 h) e fila de mensagens mortas com reenvio manual pela API.
- **Paginação** por cursor em todas as listas.

## Cadastro de números por API

Qualquer produto cliente, como o PersonalLife, deixa o seu usuário final conectar o próprio número sem falar com a Evolution: o produto chama o Bot Center, e o Bot Center devolve o QR code ou um código de pareamento.

| Conceito | O que é | Exemplo |
| --- | --- | --- |
| Tenant | O produto cliente, dono das chaves de API e do webhook | PersonalLife |
| Dono externo (`external_ref`) | O usuário final do produto, um id opaco que o produto define | O id do treinador no PersonalLife |
| Instância | Um número de WhatsApp conectado, sempre de um tenant e de um dono externo | O celular do treinador |

### Fluxo de conexão

1. O treinador clica em "Conectar WhatsApp" no PersonalLife.
2. O backend do PersonalLife chama `POST /v1/instances` com `external_ref`, `consent_at` e um `Idempotency-Key`. Se o dono já tem instância, a API devolve a mesma (um número por dono, por padrão).
3. O backend chama `POST /v1/instances/{id}/connect` com `method` igual a `qrcode` ou `pairing_code` (este com o telefone). O Bot Center devolve um `connect_token` de uso único, válido por 10 min.
4. O frontend do PersonalLife abre `GET /v1/connect/{connect_token}/events` (Server-Sent Events) e mostra o QR code ou o código de 8 caracteres. Cada QR novo chega pelo mesmo canal. O token só vale para essa conexão, então a chave de API do produto nunca vai para o navegador.
5. O treinador escaneia o QR no computador, ou digita o código no app do WhatsApp em Aparelhos conectados. O código é o caminho para quem só tem o celular, porque ninguém escaneia um QR na própria tela.
6. A Evolution confirma a conexão. O Bot Center muda a instância para `connected`, fecha o canal e envia `instance.status` por webhook ao PersonalLife.
7. Dali em diante, o PersonalLife envia com `POST /v1/messages` e o `instance_id`. O Bot Center recusa com 403 uma instância de outro tenant.

### Ciclo de vida da instância

- Estados: `created`, `connecting`, `connected`, `disconnected` e `logged_out`. Cada mudança gera o evento `instance.status` com o `external_ref`.
- `disconnected` reconecta sozinho, porque a sessão fica salva. `logged_out` (o treinador removeu o aparelho no celular) exige um novo fluxo de conexão.
- `DELETE /v1/instances/{id}` desconecta e apaga a sessão. O produto chama quando o treinador sai ou cancela.

### Regras

- **Consentimento**: o produto registra o aceite do treinador (termos e aviso de risco de ban) antes de chamar a API e envia `consent_at`. O Bot Center grava isso na auditoria.
- **Cotas por tenant**: máximo de instâncias e de mensagens por dia, configuráveis por tenant.
- **Isolamento**: toda consulta filtra por `tenant_id`; `GET /v1/instances?external_ref=` ajuda o produto a montar a tela dele.
- **Webhook por tenant**: um endereço por produto, com o `external_ref` em cada evento, para o produto achar o treinador sem tabela extra.
- **Nome na Evolution**: um id interno opaco (`inst_<uuid>`), nunca o telefone ou o nome do treinador.
- **Provedor**: para o número pessoal do treinador, o caminho é a conexão Baileys. A Cloud API oficial exige cadastrar cada número na Meta e fica fora da fase 1.

## Observabilidade, backup e operação

O alerta que mais importa é "instância desconectada", porque um número fora do ar para todos os bots dele sem nenhum erro visível para o cliente.

- **Métricas** (Prometheus no Bot Center, enviadas ao Grafana Cloud): latência p95 da API, tamanho e atraso de cada fila, taxa de `failed` por instância, instâncias conectadas, tokens negados pelo rate limit, entregas de webhook com falha.
- **Alertas** para Discord ou Telegram: instância desconectada por mais de 2 min, fila `outbound` com atraso acima de 30 s, taxa de falha de envio acima de 5% em 10 min, disco acima de 80%, backup do dia sem sucesso.
- **Logs** em JSON para stdout, coletados pelo Grafana Alloy, com `request_id`, `tenant_id` e `instance_id` em cada linha.
- **Health checks**: `/health/live` e `/health/ready` (Postgres, Redis e Evolution) no Bot Center, usados pelo Compose e pelo Uptime Kuma.
- **Backup do Postgres**: `pg_dump` diário cifrado com restic para o R2, retenção de 7 diários e 4 semanais. Quando a perda de até 24 h deixar de ser aceitável, passar para WAL contínuo com pgBackRest ou WAL-G.
- **Teste de restauração** mensal em um host temporário. Um backup sem teste de restauração não conta.
- **Sessões do WhatsApp** ficam no banco da Evolution, então o backup do Postgres também salva as conexões e evita ler QR code de novo depois de uma restauração.
- **Deploy** com Kamal ou `docker compose pull && up -d` por CI, com migração antes da troca. Workers param com graceful shutdown: terminam o job atual e devolvem o resto à fila.
- **Atualizar a Evolution** primeiro em um ambiente de teste com um número de teste, porque mudanças no Baileys podem quebrar conexões.

## Roadmap e riscos

&#91;embedded content: roadmap · 3 fases com portão de saída\]

Na fase 3, o Bot Center guarda em qual host cada número vive e roteia os envios para ele, porque uma sessão do WhatsApp não pode rodar em dois hosts ao mesmo tempo.

| Risco | Impacto | Mitigação |
| --- | --- | --- |
| Ban de número na conexão Baileys | Alto: o bot para naquele número | Rate limit, aquecimento, opt-in, Cloud API oficial para números críticos |
| Mudança no WhatsApp quebra o Baileys ou a Evolution | Alto: todos os números Baileys caem | Tag fixa, ambiente de teste, alerta de instância desconectada, provedor abstraído |
| Host único fora do ar | Médio: envios ficam parados | Filas persistentes no Redis com AOF, snapshot diário, restauração testada; segundo host na fase 3 |
| Perda de evento entre Evolution e Bot Center | Médio: mensagem sem resposta | Webhook só enfileira e responde, deduplicação por id; RabbitMQ na fase 3 se a perda aparecer nas métricas |
| Vazamento de chave de cliente | Médio: envio em nome do cliente | Escopos, hash, revogação imediata, lista de IPs, auditoria |

Respostas de 18/10/2026: o volume inicial é baixo, com só o PersonalLife conectado, e o cadastro de números é um fluxo por API para os produtos clientes (seção Cadastro de números por API).
