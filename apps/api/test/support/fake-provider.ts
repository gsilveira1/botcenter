import { ProviderError } from '@botcenter/whatsapp-provider';
import type {
  ConnectInput,
  ConnectResult,
  CreateInstanceInput,
  DownloadedMedia,
  ProviderConnectionState,
  ProviderEvent,
  ProviderWebhookNormalizer,
  SendMessageInput,
  SendMessageResult,
  WhatsAppProvider,
} from '@botcenter/whatsapp-provider';

export interface ProviderCall {
  method: keyof WhatsAppProvider;
  args: unknown[];
}

/**
 * An in-memory `WhatsAppProvider` for tests. It records each call. Set `failNext` or `pingError` to
 * simulate provider errors.
 */
export class FakeWhatsAppProvider implements WhatsAppProvider {
  readonly name = 'fake';
  readonly calls: ProviderCall[] = [];
  readonly states = new Map<string, ProviderConnectionState>();
  /** The next call (except `ping`) throws this error once. */
  failNext: ProviderError | undefined;
  /** `ping()` throws this error while it is set. */
  pingError: ProviderError | undefined;
  private sequence = 0;

  private record(method: keyof WhatsAppProvider, ...args: unknown[]): void {
    this.calls.push({ method, args });
    const failure = this.failNext;
    if (failure) {
      this.failNext = undefined;
      throw failure;
    }
  }

  async createInstance(input: CreateInstanceInput): Promise<void> {
    this.record('createInstance', input);
    this.states.set(input.name, 'disconnected');
  }

  async connect(name: string, input: ConnectInput): Promise<ConnectResult> {
    this.record('connect', name, input);
    this.states.set(name, 'connecting');
    return input.method === 'pairing_code'
      ? { pairingCode: 'ABCD1234', alreadyConnected: false }
      : {
          qrcode: `qr-${name}`,
          qrcodeBase64: 'data:image/png;base64,AAAA',
          alreadyConnected: false,
        };
  }

  async getConnectionState(name: string): Promise<ProviderConnectionState> {
    this.record('getConnectionState', name);
    return this.states.get(name) ?? 'disconnected';
  }

  async logout(name: string): Promise<void> {
    this.record('logout', name);
    this.states.set(name, 'logged_out');
  }

  async deleteInstance(name: string): Promise<void> {
    this.record('deleteInstance', name);
    this.states.delete(name);
  }

  async sendMessage(name: string, input: SendMessageInput): Promise<SendMessageResult> {
    this.record('sendMessage', name, input);
    this.sequence += 1;
    return { providerMessageId: `fake-msg-${this.sequence}` };
  }

  async downloadMedia(name: string, providerMessageId: string): Promise<DownloadedMedia> {
    this.record('downloadMedia', name, providerMessageId);
    return { data: Buffer.from('fake-media'), mimeType: 'image/jpeg', fileName: 'fake.jpg' };
  }

  async ping(): Promise<void> {
    if (this.pingError) {
      throw this.pingError;
    }
  }
}

/** A provider event in the body of the fake webhook: `occurredAt` is an ISO string. */
export type FakeWebhookEvent = {
  [K in ProviderEvent['kind']]: Omit<Extract<ProviderEvent, { kind: K }>, 'occurredAt'> & {
    occurredAt: string;
  };
}[ProviderEvent['kind']];

type FakeMessageReceived = Extract<FakeWebhookEvent, { kind: 'message.received' }>;

/** Body format of the fake normalizer: `{ "events": [...], "ignored": 0 }`. */
export interface FakeWebhookBody {
  events: FakeWebhookEvent[];
  ignored?: number;
}

/**
 * A normalizer for tests: the body already contains the normalized events. A body without an `events`
 * array is rejected (`ProviderError('rejected')`), like an unknown Evolution payload.
 */
export class FakeWebhookNormalizer implements ProviderWebhookNormalizer {
  normalize(body: unknown): { events: ProviderEvent[]; ignored: number } {
    const candidate = body as Partial<FakeWebhookBody> | null;
    if (!candidate || !Array.isArray(candidate.events)) {
      throw new ProviderError('rejected', 'Unknown webhook body');
    }
    return {
      events: candidate.events.map(
        (event) => ({ ...event, occurredAt: new Date(event.occurredAt) }) as ProviderEvent,
      ),
      ignored: candidate.ignored ?? 0,
    };
  }
}

/** A `message.received` event for the fake webhook body. */
export function fakeMessageReceived(
  overrides: Partial<FakeMessageReceived> & { instanceName: string },
): FakeMessageReceived {
  const id = overrides.dedupeKey ?? `msg-${Math.random().toString(36).slice(2)}`;
  return {
    kind: 'message.received',
    dedupeKey: id,
    occurredAt: new Date().toISOString(),
    providerMessageId: id,
    from: '5511987654321',
    content: { type: 'text', text: 'hello' },
    ...overrides,
  };
}
