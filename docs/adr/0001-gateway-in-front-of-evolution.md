# 0001. A Bot Center gateway in front of the Evolution API

- Status: Accepted (2026-10-18)
- Source: architecture, sections "Componentes e tecnologias" and "Segurança"

## Context

The Evolution API has one global key and one token for each instance. It has no scopes, no quotas, and no audit for each client. A person with the global key controls every WhatsApp number. The API of the Evolution changes between versions, and a change of Baileys can break the connections.

## Decision

The Bot Center API is the only entry for the client products. The Evolution API is only on the internal Docker network, with no port on the host and no route from the internet. Only the Bot Center knows the global key. The Bot Center talks to the provider through the `WhatsAppProvider` interface; the Evolution adapter is the first implementation.

## Consequences

- Each client gets its own API keys with scopes, quotas, rate limits, an instance list, and an audit log.
- An Evolution update changes only the provider package. The public contract (`/v1`) stays the same.
- The WhatsApp Cloud API can come later as a second provider behind the same interface.
- The Bot Center must operate one more service (the gateway and its workers), and a fault of the gateway stops every client.
