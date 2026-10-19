/**
 * Test helpers: `@botcenter/whatsapp-provider/testing`.
 * Do not import this subpath in production code.
 */
export {
  type FailureRule,
  type FakeEvolutionServerOptions,
  type FakeEvolutionState,
  type FakeInstance,
  type FakeSentMessage,
  type FakeWebhookConfig,
  FakeEvolutionServer,
  type InboundBase,
  type RecordedCall,
  type WebhookDelivery,
} from './testing/fake-evolution-server.js';
export {
  type FakeProviderCall,
  type FakeProviderInstance,
  type FakeProviderMethod,
  type FakeProviderSend,
  FakeWhatsAppProvider,
} from './testing/fake-whatsapp-provider.js';
export {
  connectionData,
  type EnvelopeOptions,
  type EvolutionAckStatus,
  newMessageId,
  updateData,
  upsertData,
  type UpsertOptions,
  webhookEnvelope,
} from './testing/evolution-payloads.js';
