import {
  type ConnectInput,
  type ConnectResult,
  type CreateInstanceInput,
  type DownloadedMedia,
  ProviderError,
  type ProviderErrorCode,
  type ProviderConnectionState,
  type ProviderInstanceName,
  type SendMessageInput,
  type SendMessageResult,
  type WhatsAppProvider,
} from '../types.js';
import { fakePairingCode, fakeQrcode, newMessageId } from './evolution-payloads.js';

/**
 * An in-memory `WhatsAppProvider` for unit tests. It has no HTTP and no timers.
 * It follows the same rules as `EvolutionProvider`: an idempotent create, a delete of a missing
 * instance is not an error, and a send needs the state `connected`.
 */

export type FakeProviderMethod = Exclude<keyof WhatsAppProvider, 'name'>;

export interface FakeProviderInstance {
  name: ProviderInstanceName;
  state: ProviderConnectionState;
  webhookUrl: string;
  webhookSecret: string;
}

export interface FakeProviderSend {
  instanceName: ProviderInstanceName;
  input: SendMessageInput;
  providerMessageId: string;
  at: Date;
}

export interface FakeProviderCall {
  method: FakeProviderMethod;
  args: unknown[];
}

interface Failure {
  method: FakeProviderMethod | '*';
  error: ProviderError;
  times: number;
}

export class FakeWhatsAppProvider implements WhatsAppProvider {
  readonly name = 'fake';
  readonly instances = new Map<ProviderInstanceName, FakeProviderInstance>();
  readonly sent: FakeProviderSend[] = [];
  readonly calls: FakeProviderCall[] = [];
  private readonly invalid = new Set<string>();
  private readonly media = new Map<string, DownloadedMedia>();
  private readonly failures: Failure[] = [];

  /** The next call of `method` (or of any method with `*`) throws this error. */
  failNext(
    method: FakeProviderMethod | '*',
    error: ProviderError | ProviderErrorCode,
    times = 1,
  ): void {
    const providerError =
      error instanceof ProviderError
        ? error
        : new ProviderError(error, `Fake provider failure (${error})`);
    this.failures.push({ method, error: providerError, times });
  }

  setState(name: ProviderInstanceName, state: ProviderConnectionState): void {
    this.require(name).state = state;
  }

  addInvalidRecipient(phone: string): void {
    this.invalid.add(phone);
  }

  setMedia(name: ProviderInstanceName, providerMessageId: string, media: DownloadedMedia): void {
    this.media.set(`${name}:${providerMessageId}`, media);
  }

  /** The sends of one instance, in order. */
  sentTo(name: ProviderInstanceName): FakeProviderSend[] {
    return this.sent.filter((send) => send.instanceName === name);
  }

  reset(): void {
    this.instances.clear();
    this.sent.length = 0;
    this.calls.length = 0;
    this.invalid.clear();
    this.media.clear();
    this.failures.length = 0;
  }

  async createInstance(input: CreateInstanceInput): Promise<void> {
    this.enter('createInstance', [input]);
    const existing = this.instances.get(input.name);
    if (existing) {
      existing.webhookUrl = input.webhookUrl;
      existing.webhookSecret = input.webhookSecret;
      return;
    }
    this.instances.set(input.name, {
      name: input.name,
      state: 'disconnected',
      webhookUrl: input.webhookUrl,
      webhookSecret: input.webhookSecret,
    });
  }

  async connect(name: ProviderInstanceName, input: ConnectInput): Promise<ConnectResult> {
    this.enter('connect', [name, input]);
    const instance = this.require(name);
    if (instance.state === 'connected') return { alreadyConnected: true };
    instance.state = 'connecting';
    const qr = fakeQrcode();
    const result: ConnectResult = {
      alreadyConnected: false,
      qrcode: qr.code,
      qrcodeBase64: qr.base64,
    };
    if (input.method === 'pairing_code') result.pairingCode = fakePairingCode();
    return result;
  }

  async getConnectionState(name: ProviderInstanceName): Promise<ProviderConnectionState> {
    this.enter('getConnectionState', [name]);
    return this.require(name).state;
  }

  async logout(name: ProviderInstanceName): Promise<void> {
    this.enter('logout', [name]);
    // Like Evolution: after a logout the state is `close`, which the adapter reports as `disconnected`.
    this.require(name).state = 'disconnected';
  }

  async deleteInstance(name: ProviderInstanceName): Promise<void> {
    this.enter('deleteInstance', [name]);
    this.instances.delete(name);
  }

  async sendMessage(
    name: ProviderInstanceName,
    input: SendMessageInput,
  ): Promise<SendMessageResult> {
    this.enter('sendMessage', [name, input]);
    const instance = this.require(name);
    if (instance.state !== 'connected') {
      throw new ProviderError('not_connected', 'Fake provider: the instance is not connected');
    }
    if (this.invalid.has(input.to)) {
      throw new ProviderError(
        'invalid_recipient',
        'Fake provider: the number is not on WhatsApp',
        400,
      );
    }
    const providerMessageId = newMessageId();
    this.sent.push({ instanceName: name, input, providerMessageId, at: new Date() });
    return { providerMessageId };
  }

  async downloadMedia(
    name: ProviderInstanceName,
    providerMessageId: string,
  ): Promise<DownloadedMedia> {
    this.enter('downloadMedia', [name, providerMessageId]);
    this.require(name);
    const media = this.media.get(`${name}:${providerMessageId}`);
    if (!media) throw new ProviderError('rejected', 'Fake provider: the message has no media', 400);
    return media;
  }

  async ping(): Promise<void> {
    this.enter('ping', []);
  }

  private enter(method: FakeProviderMethod, args: unknown[]): void {
    this.calls.push({ method, args });
    const index = this.failures.findIndex(
      (failure) => failure.method === method || failure.method === '*',
    );
    if (index < 0) return;
    const failure = this.failures[index]!;
    failure.times -= 1;
    if (failure.times <= 0) this.failures.splice(index, 1);
    throw failure.error;
  }

  private require(name: ProviderInstanceName): FakeProviderInstance {
    const instance = this.instances.get(name);
    if (!instance)
      throw new ProviderError('not_found', 'Fake provider: the instance does not exist', 404);
    return instance;
  }
}
