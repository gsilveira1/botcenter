import { ProviderError } from '@botcenter/whatsapp-provider';
import type {
  ConnectResult,
  DownloadedMedia,
  ProviderConnectionState,
  ProviderEvent,
  ProviderWebhookNormalizer,
  SendMessageResult,
  WhatsAppProvider,
} from '@botcenter/whatsapp-provider';
import type { ProviderBindings } from './provider.tokens';

const MESSAGE = 'No WhatsApp provider is wired (see apps/api/src/provider/provider.factory.ts)';

function fail(): never {
  throw new ProviderError('unavailable', MESSAGE);
}

/**
 * The provider before the orchestrator wires the Evolution adapter. Each call throws
 * `ProviderError('unavailable')`, so `/health/ready` reports the provider as down and a send is retried.
 */
export class UnconfiguredProvider implements WhatsAppProvider {
  readonly name = 'unconfigured';

  createInstance(): Promise<void> {
    return Promise.reject(new ProviderError('unavailable', MESSAGE));
  }

  connect(): Promise<ConnectResult> {
    return Promise.reject(new ProviderError('unavailable', MESSAGE));
  }

  getConnectionState(): Promise<ProviderConnectionState> {
    return Promise.reject(new ProviderError('unavailable', MESSAGE));
  }

  logout(): Promise<void> {
    return Promise.reject(new ProviderError('unavailable', MESSAGE));
  }

  deleteInstance(): Promise<void> {
    return Promise.reject(new ProviderError('unavailable', MESSAGE));
  }

  sendMessage(): Promise<SendMessageResult> {
    return Promise.reject(new ProviderError('unavailable', MESSAGE));
  }

  downloadMedia(): Promise<DownloadedMedia> {
    return Promise.reject(new ProviderError('unavailable', MESSAGE));
  }

  ping(): Promise<void> {
    return Promise.reject(new ProviderError('unavailable', MESSAGE));
  }
}

export class UnconfiguredNormalizer implements ProviderWebhookNormalizer {
  normalize(): { events: ProviderEvent[]; ignored: number } {
    return fail();
  }
}

export function unconfiguredBindings(): ProviderBindings {
  return { provider: new UnconfiguredProvider(), normalizer: new UnconfiguredNormalizer() };
}
