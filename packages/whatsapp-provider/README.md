# @botcenter/whatsapp-provider

This package contains the `WhatsAppProvider` interface and its first implementation for Evolution API v2.3.7 (Baileys channel).
It also contains the normalizer of the Evolution webhooks and the fakes for tests.
Only this package knows the URLs and the payloads of the Evolution API.

## Public API

### `EvolutionProvider` (`@botcenter/whatsapp-provider`)

```ts
const provider = new EvolutionProvider({
  baseUrl: 'http://evolution:8080', // private network only
  apiKey: env.EVOLUTION_API_KEY, // the global AUTHENTICATION_API_KEY
  logger: pinoLogger, // optional: debug/info/warn/error(fields, message)
  timeouts: { requestMs: 10_000, connectMs: 20_000, sendMs: 30_000, mediaMs: 60_000 }, // optional
  interactiveFallback: 'text', // optional: 'text' (default) or 'native'
  rejectCalls: false, // optional
  // fetch / dispatcher: optional. The default is the undici fetch with a keep-alive Agent.
});
await provider.close(); // at the graceful shutdown
```

| Method               | Evolution route                                                  | Result                                                                                                                                              |
| -------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createInstance`     | `POST /instance/create`                                          | 403 "already in use" is a success. The adapter then calls `POST /webhook/set/{name}` and `POST /settings/set/{name}`, so a new secret takes effect. |
| `connect`            | `GET /instance/connect/{name}` (`?number=` for a pairing code)   | The QR code, the pairing code, or `alreadyConnected: true`. The QR code can also come later in the `qrcode.updated` webhook.                        |
| `getConnectionState` | `GET /instance/connectionState/{name}`                           | `open` is `connected`, `connecting` is `connecting`, `refused` is `logged_out`, and `close` is `disconnected`.                                      |
| `logout`             | `DELETE /instance/logout/{name}`                                 | 400 "is not connected" is a success.                                                                                                                |
| `deleteInstance`     | `DELETE /instance/delete/{name}`                                 | 404 is a success.                                                                                                                                   |
| `sendMessage`        | `POST /message/sendText`, `sendMedia`, `sendButtons`, `sendList` | `providerMessageId` is `key.id` of the answer.                                                                                                      |
| `downloadMedia`      | `POST /chat/getBase64FromMediaMessage/{name}`                    | The bytes, the MIME type, and the file name.                                                                                                        |
| `ping`               | `GET /instance/fetchInstances?instanceName=botcenter-ping`       | 200 or 404 is a success.                                                                                                                            |

Error codes (`ProviderError.code`):

| Condition                                                                                     | Code                                           |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Network error, timeout, HTTP 5xx, 408, or 429                                                 | `unavailable`                                  |
| HTTP 404 "instance does not exist"                                                            | `not_found`                                    |
| A send fails (400, 5xx, or timeout) and the state check gives a state that is not `connected` | `not_connected`                                |
| A send answers 400 with `exists: false`                                                       | `invalid_recipient`                            |
| All other 4xx (also 401 for a wrong API key, and 404 for an unknown route)                    | `rejected`                                     |
| A send answers 2xx without `key.id`                                                           | `rejected` (no retry, so no duplicate message) |

The error messages contain the operation, the HTTP status, and the code only.
The log fields contain the Evolution error text with masked digits, and the adapter removes the message content from it.
The API key is never in a message or a log field.

### `EvolutionWebhookNormalizer` (`@botcenter/whatsapp-provider`)

`normalize(body)` returns `{ events, ignored }`. It throws `ProviderError` with the code `rejected` for an invalid body.

| Evolution event                                        | Result                                                                                                                       |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `qrcode.updated`                                       | `qrcode.updated`. The "QR code limit reached" variant is ignored.                                                            |
| `connection.update` `open`                             | `connection.updated` `connected`, with `phone` from `wuid`                                                                   |
| `connection.update` `connecting`                       | `connection.updated` `connecting`                                                                                            |
| `connection.update` `close` with 401, 402, 403, or 406 | `connection.updated` `logged_out` (Evolution deletes the session)                                                            |
| `connection.update` `close` with an other code         | `connection.updated` `disconnected`                                                                                          |
| `connection.update` `refused`                          | `connection.updated` `logged_out`, reason `qrcode_limit_reached`                                                             |
| `messages.upsert`                                      | `message.received`: text, button reply, list reply, media, or `unsupported`                                                  |
| `messages.update` of a sent message                    | `message.status`: `SERVER_ACK` is `sent`, `DELIVERY_ACK` is `delivered`, `READ` and `PLAYED` are `read`, `ERROR` is `failed` |
| `send.message` and all other events                    | ignored                                                                                                                      |

The normalizer ignores these messages: `fromMe`, groups (`@g.us`), broadcasts, newsletters, reactions, poll votes, and protocol messages.
It also ignores a `@lid` chat without a phone JID, because a reply to it is not possible.

Dedupe keys:

- `message.received:{instance}:{key.id}`
- `message.status:{instance}:{key.id}:{status}`
- `connection.updated:{instance}:{state}:{statusReason}:{date_time}`
- `qrcode.updated:{instance}:{sha256 of the QR code and the pairing code}`

`occurredAt` is `messageTimestamp` for messages. For the other events, it is `date_time`, then the clock.

### Test helpers (`@botcenter/whatsapp-provider/testing`)

`FakeEvolutionServer` is an HTTP server on a random port. It answers like Evolution 2.3.7 for the routes above.

```ts
const fake = await FakeEvolutionServer.start({ apiKey: 'k', autoStatus: 'delivered' });
const provider = new EvolutionProvider({ baseUrl: fake.url, apiKey: 'k' });
await provider.createInstance({ name, webhookUrl, webhookSecret });
await fake.emitConnected(name, '5511912345678');
await fake.emitInboundText(name, { from: '5511987654321', text: 'Oi' });
fake.failNext({ route: '/message/sendText', status: 503 }); // or delayMs, hang, dropConnection, times
await fake.close();
```

- Options: `apiKey`, `host`, `port`, `autoWebhooks` (default true), `autoStatus`, `maxRecordedCalls`, `webhookTimeoutMs`, `onWebhookError`.
- Inspection: `calls`, `callsTo(route, method?)`, `clearCalls()`, `deliveries`, `instance(name)`, `flushWebhooks()`.
- Control: `failNext(rule)`, `clearFailures()`, `setState(name, state, phone?)`, `addInvalidRecipient(phone)`, `setMedia(name, id, media)`.
- Webhooks: `emitQrcode`, `emitConnecting`, `emitConnected`, `emitDisconnected`, `emitLoggedOut`, `emitRefused`, `emitInboundText`, `emitButtonReply`, `emitListReply`, `emitInboundMedia`, `emitStatus`, `emitRaw`.
- Another process can control the fake with `POST /__fake/instances/{name}` and the body `{ "action": "connected", "phone": "..." }`. Other actions: `inbound_text` (`from`, `text`), `status` (`messageId`, `status`), and `logged_out`.
- To run the fake as a process (Compose, k6), run `pnpm --filter @botcenter/whatsapp-provider fake-evolution`. Set `FAKE_EVOLUTION_API_KEY`, and optionally `FAKE_EVOLUTION_PORT`, `FAKE_EVOLUTION_HOST`, and `FAKE_EVOLUTION_AUTO_STATUS`.

`FakeWhatsAppProvider` is an in-memory `WhatsAppProvider` with no HTTP. It has `sent`, `calls`, `failNext(method, code)`, `setState`, `addInvalidRecipient`, `setMedia`, and `reset`.

## Evolution facts (verified)

The source is the tag `2.3.7` of `https://github.com/EvolutionAPI/evolution-api` (commit `cd800f2`, Baileys `7.0.0-rc.9`).
The integration test and a manual capture with the real image confirmed the facts marked "recorded".

| Fact                                                                                                                                                                                                                                 | Source                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| The routes, the guard order, and the error shape `{ status, error, response: { message } }` (recorded)                                                                                                                               | `src/api/routes/*.router.ts`, `src/api/guards/*.ts`, `src/main.ts`, `src/exceptions/*` |
| A second create answers 403 `This name "<name>" is already in use.` (recorded)                                                                                                                                                       | `src/api/guards/instance.guard.ts`                                                     |
| A send without a session answers 500 `Cannot read properties of undefined (reading 'onWhatsApp')`. During the connect flow, Evolution holds the send for about 60 s, then answers 500 `(reading 'find')` (recorded).                 | `whatsapp.baileys.service.ts` (`sendMessageWithTyping`, `whatsappNumber`)              |
| A number without WhatsApp answers 400 with `[{ jid, exists: false, number }]`                                                                                                                                                        | `sendMessageWithTyping`                                                                |
| `delay` shows "composing" for the delay, then "paused", then sends. A call to `/chat/sendPresence` is not necessary.                                                                                                                 | `sendMessageWithTyping`                                                                |
| `connect` waits 2 s and answers the QR code object `{ pairingCode, code, base64, count }` (recorded). The pairing code has 8 characters (recorded).                                                                                  | `instance.controller.ts` (`connectToWhatsapp`)                                         |
| Evolution sends `connection.update` `close` only for 401, 403, 402, and 406, and then deletes the session (recorded for 401). For the other codes, it reconnects and sends `connecting`.                                             | `connectionUpdate`                                                                     |
| Logout of a closed instance answers 400 `... is not connected` (recorded).                                                                                                                                                           | `instance.controller.ts` (`logout`)                                                    |
| `GET /` calls `https://web.whatsapp.com/sw.js` on each request.                                                                                                                                                                      | `src/api/routes/index.router.ts`, `src/utils/fetchLatestWaWebVersion.ts`               |
| The webhook body is `{ event, instance, data, destination, date_time, sender, server_url, apikey }` (recorded). Evolution sends the custom headers of the instance.                                                                  | `src/api/integrations/event/webhook/webhook.controller.ts`                             |
| Evolution retries a failed webhook up to 10 times with an exponential delay. It does not retry 400, 401, 403, 404, or 422.                                                                                                           | `webhook.controller.ts` (`retryWebhookRequest`)                                        |
| `date_time` is the local time of the container with a `Z` suffix. The image sets `TZ=America/Sao_Paulo`.                                                                                                                             | `src/api/services/channel.service.ts`, `Dockerfile`                                    |
| `messages.upsert`: Evolution changes `extendedTextMessage` to `conversation`, and `documentWithCaptionMessage` to `documentMessage`. For a `@lid` chat, it puts `remoteJidAlt` (the phone JID) in `remoteJid` when Baileys gives it. | `prepareMessage`, `messages.upsert` handler                                            |
| Edits and deletes are `protocolMessage` and go to `messages.edited`, not to `messages.upsert`.                                                                                                                                       | `messages.upsert` handler                                                              |
| `getBase64FromMediaMessage` with only `key.id` reads the message from the `Message` table. Without the row, it answers 400 `Message not found` (recorded).                                                                           | `getBase64FromMediaMessage`, `getMessage`                                              |
| A `quoted` with only `key.id` also reads the `Message` table. Without the row, Evolution sends the message without a quote.                                                                                                          | `sendMessageWithTyping`                                                                |
| When `DATABASE_SAVE_DATA_NEW_MESSAGE=true`, Evolution sends `messages.update` only for messages in its `Message` table. The sent messages are in it.                                                                                 | `messages.update` handler                                                              |
| Buttons use `interactiveMessage` with `nativeFlowMessage` (`quick_reply`) in `viewOnceMessage`. Lists use `listMessage` with `listType: 2`. Evolution does not add the `biz` node.                                                   | `buttonMessage`, `listMessage`, `sendMessage`                                          |

## Interactive messages

The default `interactiveFallback` is `text`. The adapter sends `buttons` and `list` content as a numbered text menu.
The reason: Evolution 2.3.7 sends native buttons and lists through Baileys without the `biz` node.
Many WhatsApp clients do not show these messages, and a test without a real phone cannot prove that they work.
With `text`, the reply of the user is a `text` event (for example `1` or `Mensal`), not a `button_reply` event.
With `native`, the normalizer maps `buttonsResponseMessage`, `templateButtonReplyMessage`, `interactiveResponseMessage`, and `listResponseMessage` to `button_reply` and `list_reply`.

## Evolution environment (for `infra/`)

The image copies `.env.example` of the repository to `.env`. That file turns on all the `DATABASE_SAVE_DATA_*` flags, telemetry, and verbose logs.
So set each value below explicitly.

| Variable                                                                                                                                                                              | Value                                                                     | Reason                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `TZ`                                                                                                                                                                                  | `UTC`                                                                     | `date_time` of the webhooks is then correct.                              |
| `SERVER_URL`                                                                                                                                                                          | `http://evolution:8080`                                                   | Internal URL.                                                             |
| `SERVER_DISABLE_MANAGER`, `SERVER_DISABLE_DOCS`                                                                                                                                       | `true`                                                                    | No UI on the private network.                                             |
| `AUTHENTICATION_API_KEY`                                                                                                                                                              | 32 random bytes                                                           | The global key. Only the Bot Center has it.                               |
| `AUTHENTICATION_EXPOSE_IN_FETCH_INSTANCES`                                                                                                                                            | `false`                                                                   | The webhook body then has `apikey: null`.                                 |
| `DATABASE_PROVIDER`                                                                                                                                                                   | `postgresql`                                                              |                                                                           |
| `DATABASE_CONNECTION_URI`                                                                                                                                                             | `postgresql://evolution:<password>@postgres:5432/evolution?schema=public` | The `evolution` database.                                                 |
| `DATABASE_CONNECTION_CLIENT_NAME`                                                                                                                                                     | `botcenter`                                                               | Evolution loads only the instances of this client name.                   |
| `DATABASE_SAVE_DATA_INSTANCE`                                                                                                                                                         | `true`                                                                    | Required: instances and WhatsApp sessions in Postgres (backup, restart).  |
| `DATABASE_SAVE_DATA_NEW_MESSAGE`                                                                                                                                                      | `true`                                                                    | Required for `downloadMedia` and `quoted`. See the open problems.         |
| `DATABASE_SAVE_MESSAGE_UPDATE`, `DATABASE_SAVE_DATA_CONTACTS`, `DATABASE_SAVE_DATA_CHATS`, `DATABASE_SAVE_DATA_HISTORIC`, `DATABASE_SAVE_DATA_LABELS`, `DATABASE_SAVE_IS_ON_WHATSAPP` | `false`                                                                   | Fewer writes. The Bot Center does not use the data.                       |
| `CACHE_REDIS_ENABLED`                                                                                                                                                                 | `true`                                                                    |                                                                           |
| `CACHE_REDIS_URI`                                                                                                                                                                     | `redis://redis:6379/1`                                                    | A database number that BullMQ does not use.                               |
| `CACHE_REDIS_PREFIX_KEY`                                                                                                                                                              | `evolution`                                                               |                                                                           |
| `CACHE_REDIS_SAVE_INSTANCES`                                                                                                                                                          | `false`                                                                   | When `true`, the sessions go to Redis, not Postgres.                      |
| `CACHE_LOCAL_ENABLED`                                                                                                                                                                 | `false`                                                                   |                                                                           |
| `DEL_INSTANCE`                                                                                                                                                                        | `false`                                                                   | Evolution must not delete instances on its own.                           |
| `WEBHOOK_GLOBAL_ENABLED`                                                                                                                                                              | `false`                                                                   | Each instance has its webhook with the secret header.                     |
| `WEBSOCKET_ENABLED`                                                                                                                                                                   | `false`                                                                   |                                                                           |
| `TELEMETRY_ENABLED`                                                                                                                                                                   | `false`                                                                   | Otherwise each request sends the route to `log.evolution-api.com`.        |
| `LOG_LEVEL`                                                                                                                                                                           | `ERROR,WARN,INFO`                                                         | `WEBHOOKS` and `VERBOSE` write message content to the log.                |
| `LOG_BAILEYS`                                                                                                                                                                         | `error`                                                                   |                                                                           |
| `LOG_COLOR`                                                                                                                                                                           | `false`                                                                   | JSON log collectors.                                                      |
| `QRCODE_LIMIT`                                                                                                                                                                        | `30`                                                                      | The default. After this number of QR codes, the instance sends `refused`. |

For the readiness check of the container, use `GET /instance/fetchInstances` without the key (answer 401). Do not use `GET /`.

The internal webhook route of the API must answer 401 for a wrong secret and 400 for a body that the normalizer rejects. Evolution does not retry these codes.

## Limitations

- `getConnectionState` cannot tell `logged_out` from `disconnected`: Evolution reports `close` for the two. The `connection.update` webhook can tell them.
- If an instance is in the QR code flow, `connect` with `pairing_code` returns the current QR code without a pairing code. Call `logout`, then `connect` again.
- A send that times out on a connected instance is `unavailable` (retryable). The message can be on WhatsApp already, so a retry can send it two times.
- Evolution never deletes the rows of its `Message` table. A maintenance job must delete the old rows (LGPD).

## Fixtures

`fixtures/evolution-2.3.7/` has the payloads for the contract tests.

- Recorded from the real image (2026-10-19): `api/root.200`, `api/fetch-instances.*`, `api/create-instance.*`, `api/connection-state.200-close`, `api/connection-state.200-connecting`, `api/connection-state.404-missing`, `api/connect.200-qrcode`, `api/connect.200-pairing-code`, `api/send-text.500-*`, `api/send-text.404-missing`, `api/send-media.500-closed`, `api/logout.*`, `api/delete.200`, `api/get-base64.400-message-not-found`, `api/route.404-missing`, `api/webhook-set.201`, `api/settings-set.201`, `webhooks/connection-update.connecting`, `webhooks/connection-update.close-401`, `webhooks/qrcode-updated`, `webhooks/qrcode-updated.pairing-code`.
- Built from the source (these events need a real phone): all other files.

## Tests

- `pnpm test`: unit and contract tests (no Docker).
- `pnpm test:int`: the real `evoapicloud/evolution-api:v2.3.7` image with PostgreSQL 16 and Redis 7 (Testcontainers). It takes about 20 s when the images are local. The QR code test needs internet access from Docker.
