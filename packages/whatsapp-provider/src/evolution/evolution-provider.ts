import { MEDIA_MAX_BYTES } from '@botcenter/contracts';
import type { Dispatcher } from 'undici';
import { consoleWarnLogger, type ProviderLogger } from '../logger.js';
import {
  type ConnectInput,
  type ConnectResult,
  type CreateInstanceInput,
  type DownloadedMedia,
  type DownloadMediaOptions,
  MediaTooLargeError,
  ProviderError,
  type ProviderConnectionState,
  type ProviderInstanceName,
  type SendMessageInput,
  type SendMessageResult,
  type WhatsAppProvider,
} from '../types.js';
import {
  type EvolutionCall,
  EvolutionHttp,
  type EvolutionResponse,
  errorMessages,
  type FetchLike,
  hasMessage,
  ResponseTooLargeError,
} from './http.js';
import {
  createInstanceBody,
  type InteractiveFallback,
  instanceSettings,
  sendRequest,
  webhookConfig,
} from './request-bodies.js';

export interface EvolutionTimeouts {
  /** Default time limit of a request (state, logout, delete, ping, create). */
  requestMs: number;
  /** `connect`: Evolution waits 2 s for the first QR code before it answers. */
  connectMs: number;
  /** One send. The adapter adds the typing delay to this value. */
  sendMs: number;
  /** One media download (Evolution downloads and decrypts the file first). */
  mediaMs: number;
}

export const DEFAULT_TIMEOUTS: EvolutionTimeouts = {
  requestMs: 10_000,
  connectMs: 20_000,
  sendMs: 30_000,
  mediaMs: 60_000,
};

export interface EvolutionProviderOptions {
  /** The base URL of the Evolution API on the private network, for example `http://evolution:8080`. */
  baseUrl: string;
  /** The global `AUTHENTICATION_API_KEY` of the Evolution API. It goes in the `apikey` header. */
  apiKey: string;
  timeouts?: Partial<EvolutionTimeouts>;
  /** A pino logger or another object with the same methods. The default writes warnings to stderr. */
  logger?: ProviderLogger;
  /** A custom fetch function (tests). When you give it, the adapter does not create an agent. */
  fetch?: FetchLike;
  /** A custom undici dispatcher for the default fetch. The default is a keep-alive `Agent`. */
  dispatcher?: Dispatcher;
  /**
   * How to send `buttons` and `list` content. `text` (default) sends a numbered text menu.
   * `native` uses `/message/sendButtons` and `/message/sendList`. See the README.
   */
  interactiveFallback?: InteractiveFallback;
  /** Reject the WhatsApp calls to the connected number. Default `false`: it is the personal phone of a person. */
  rejectCalls?: boolean;
}

/** The JSON envelope around the base64 text of a media answer (mime type, file name, size, key). */
const MEDIA_ENVELOPE_BYTES = 64 * 1024;

/**
 * The maximum size of a `getBase64FromMediaMessage` answer for a file of `maxBytes`: the base64 text
 * (4 characters for each 3 bytes) plus the JSON envelope. For 16 MiB, the limit is about 21.4 MiB.
 */
export function mediaResponseLimit(maxBytes: number): number {
  return Math.ceil(maxBytes / 3) * 4 + MEDIA_ENVELOPE_BYTES;
}

/** The name that `ping` asks for. It is never a real instance name (those are `inst_<uuid>`). */
export const PING_INSTANCE_NAME = 'botcenter-ping';

function instancePath(route: string, name: string): string {
  return `${route}/${encodeURIComponent(name)}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** The text values of a message (text, caption, titles), so that the log can remove them. */
function contentStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(contentStrings);
  if (isObject(value)) {
    return Object.entries(value)
      .filter(([key]) => key !== 'type' && key !== 'media_type' && key !== 'mime_type')
      .flatMap(([, item]) => contentStrings(item));
  }
  return [];
}

/** Maps the `state` of Evolution (`WAConnectionState` or `refused`) to the provider state. */
export function mapEvolutionState(state: unknown): ProviderConnectionState {
  switch (state) {
    case 'open':
      return 'connected';
    case 'connecting':
      return 'connecting';
    case 'refused':
      return 'logged_out';
    default:
      // `close`, and no state when the instance is not in the memory of Evolution.
      return 'disconnected';
  }
}

/**
 * `WhatsAppProvider` for Evolution API v2.3.7 with the Baileys channel (`WHATSAPP-BAILEYS`).
 * The routes and the response shapes come from the Evolution source at tag `2.3.7` (see the README).
 */
export class EvolutionProvider implements WhatsAppProvider {
  readonly name = 'evolution';
  private readonly http: EvolutionHttp;
  private readonly timeouts: EvolutionTimeouts;
  private readonly logger: ProviderLogger;
  private readonly fallback: InteractiveFallback;
  private readonly rejectCalls: boolean;

  constructor(options: EvolutionProviderOptions) {
    if (!options.baseUrl) throw new TypeError('EvolutionProvider: "baseUrl" is required');
    if (!options.apiKey) throw new TypeError('EvolutionProvider: "apiKey" is required');
    this.logger = options.logger ?? consoleWarnLogger;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
    this.fallback = options.interactiveFallback ?? 'text';
    this.rejectCalls = options.rejectCalls ?? false;
    this.http = new EvolutionHttp({
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      logger: this.logger,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.dispatcher ? { dispatcher: options.dispatcher } : {}),
    });
  }

  /** Closes the keep-alive connections. Call it at the graceful shutdown. */
  async close(): Promise<void> {
    await this.http.close();
  }

  async createInstance(input: CreateInstanceInput): Promise<void> {
    const call = this.call('createInstance', 'POST', '/instance/create', undefined, {
      body: createInstanceBody(input, this.rejectCalls),
    });
    const response = await this.http.call(call);
    if (response.status === 200 || response.status === 201) return;
    // `instanceLoggedGuard`: 403 `This name "<name>" is already in use.` The create is idempotent:
    // the adapter writes the webhook and the settings again, so a changed secret takes effect.
    if (response.status === 403 && hasMessage(response.body, /already in use/i)) {
      this.logger.info(
        { instance_name: input.name },
        'Evolution instance exists; updating its config',
      );
      await this.expectOk(
        this.call('setWebhook', 'POST', '/webhook/set', input.name, {
          body: { webhook: webhookConfig(input) },
        }),
      );
      await this.expectOk(
        this.call('setSettings', 'POST', '/settings/set', input.name, {
          body: instanceSettings(this.rejectCalls),
        }),
      );
      return;
    }
    throw this.http.fail(call, response);
  }

  async connect(name: ProviderInstanceName, input: ConnectInput): Promise<ConnectResult> {
    const query =
      input.method === 'pairing_code' ? `?number=${encodeURIComponent(input.phone)}` : '';
    const call = this.call('connect', 'GET', '/instance/connect', name, {
      query,
      timeoutMs: this.timeouts.connectMs,
    });
    const response = await this.expectOk(call);
    const body = response.body;
    if (!isObject(body)) throw this.http.fail(call, response, 'unavailable');
    // `connectToWhatsapp` catches its own errors and answers 200 `{ error: true, message }`.
    if (body.error === true) throw this.http.fail(call, response, 'unavailable');
    // State `open`: Evolution answers with `connectionState`: `{ instance: { instanceName, state } }`.
    if (isObject(body.instance) && body.instance.state === 'open')
      return { alreadyConnected: true };
    // State `connecting` or `close`: the QR code object `{ pairingCode, code, base64, count }`.
    // An other state: `{ instance: { instanceName, status }, qrcode: { ... } }`.
    const qr = isObject(body.qrcode) ? body.qrcode : body;
    const result: ConnectResult = { alreadyConnected: false };
    const base64 = optionalString(qr.base64);
    const code = optionalString(qr.code);
    const pairingCode = optionalString(qr.pairingCode);
    if (base64) result.qrcodeBase64 = base64;
    if (code) result.qrcode = code;
    if (pairingCode) result.pairingCode = pairingCode;
    return result;
  }

  async getConnectionState(name: ProviderInstanceName): Promise<ProviderConnectionState> {
    const response = await this.expectOk(
      this.call('getConnectionState', 'GET', '/instance/connectionState', name),
    );
    const instance = isObject(response.body) ? response.body.instance : undefined;
    return mapEvolutionState(isObject(instance) ? instance.state : undefined);
  }

  async logout(name: ProviderInstanceName): Promise<void> {
    const call = this.call('logout', 'DELETE', '/instance/logout', name);
    const response = await this.http.call(call);
    if (response.status === 200) return;
    // 400 `The "<name>" instance is not connected`: the session is already closed.
    if (response.status === 400 && hasMessage(response.body, /is not connected/i)) return;
    throw this.http.fail(call, response);
  }

  async deleteInstance(name: ProviderInstanceName): Promise<void> {
    const call = this.call('deleteInstance', 'DELETE', '/instance/delete', name);
    const response = await this.http.call(call);
    if (response.status === 200 || response.status === 404) return;
    throw this.http.fail(call, response);
  }

  async ping(): Promise<void> {
    // `GET /` calls web.whatsapp.com on each request, so it is not a readiness check. This route checks
    // the API key and answers from memory: 404 `Instance "botcenter-ping" not found`.
    const call = this.call('ping', 'GET', '/instance/fetchInstances', undefined, {
      query: `?instanceName=${PING_INSTANCE_NAME}`,
    });
    const response = await this.http.call(call);
    if (response.status === 200 || response.status === 404) return;
    throw this.http.fail(call, response);
  }

  async sendMessage(
    name: ProviderInstanceName,
    input: SendMessageInput,
  ): Promise<SendMessageResult> {
    const request = sendRequest(input, this.fallback);
    const call = this.call('sendMessage', 'POST', `/message/${request.route}`, name, {
      body: request.body,
      timeoutMs: this.timeouts.sendMs + Math.max(0, input.typingDelayMs ?? 0),
    });
    call.redact = contentStrings(input.content);
    let response: EvolutionResponse;
    try {
      response = await this.http.call(call);
    } catch (error) {
      // While the instance connects, Evolution holds the send for about 60 s. A timeout is then
      // `not_connected` when the state check confirms it.
      if (error instanceof ProviderError && (await this.isNotConnected(name))) {
        throw new ProviderError(
          'not_connected',
          `Evolution ${call.operation} failed (not_connected)`,
          undefined,
          {
            cause: error,
          },
        );
      }
      throw error;
    }
    if (response.status === 200 || response.status === 201) {
      const key = isObject(response.body) ? response.body.key : undefined;
      const id = isObject(key) ? optionalString(key.id) : undefined;
      // The message can be on WhatsApp already, so this error is not retryable (no duplicate sends).
      if (!id) throw this.http.fail(call, response, 'rejected');
      return { providerMessageId: id };
    }
    throw await this.sendError(name, call, response);
  }

  async downloadMedia(
    name: ProviderInstanceName,
    providerMessageId: string,
    options: DownloadMediaOptions = {},
  ): Promise<DownloadedMedia> {
    const maxBytes = options.maxBytes ?? MEDIA_MAX_BYTES;
    // Evolution reads the message from its `Message` table (`DATABASE_SAVE_DATA_NEW_MESSAGE=true`).
    // The answer is read as a stream with a hard limit (ARCH-03, SEC-02): a large file never is
    // completely in memory.
    const call = this.call('downloadMedia', 'POST', '/chat/getBase64FromMediaMessage', name, {
      body: { message: { key: { id: providerMessageId } }, convertToMp4: false },
      timeoutMs: this.timeouts.mediaMs,
      maxResponseBytes: mediaResponseLimit(maxBytes),
    });
    let response: EvolutionResponse;
    try {
      response = await this.expectOk(call);
    } catch (error) {
      if (error instanceof ResponseTooLargeError) throw new MediaTooLargeError(maxBytes);
      throw error;
    }
    const body = response.body;
    const base64 = isObject(body) ? optionalString(body.base64) : undefined;
    if (!isObject(body) || !base64) throw this.http.fail(call, response, 'rejected');
    // 4 base64 characters give at most 3 bytes: check the size before the decode.
    if (Math.floor((base64.length * 3) / 4) - 2 > maxBytes) throw new MediaTooLargeError(maxBytes);
    const data = Buffer.from(base64, 'base64');
    if (data.length > maxBytes) throw new MediaTooLargeError(maxBytes);
    const media: DownloadedMedia = {
      data,
      mimeType: optionalString(body.mimetype) ?? 'application/octet-stream',
    };
    const fileName = optionalString(body.fileName);
    if (fileName) media.fileName = fileName;
    return media;
  }

  /**
   * Evolution answers 400 or 500 for most send errors, also when the instance is not connected.
   * The adapter asks for the state to tell `not_connected` from the other errors.
   */
  private async sendError(
    name: ProviderInstanceName,
    call: EvolutionCall,
    response: EvolutionResponse,
  ): Promise<ProviderError> {
    // `sendMessageWithTyping`: 400 with `[{ jid, exists: false, number }]` for a number without WhatsApp.
    const notOnWhatsApp = errorMessages(response.body).some(
      (item) => isObject(item) && item.exists === false,
    );
    if (response.status === 400 && notOnWhatsApp) {
      return this.http.fail(call, response, 'invalid_recipient');
    }
    // Not connected: 500 `Cannot read properties of undefined (reading 'onWhatsApp')` (closed) or
    // 500 `... (reading 'find')` (connecting), as the integration test shows.
    if ((response.status === 400 || response.status >= 500) && (await this.isNotConnected(name))) {
      return this.http.fail(call, response, 'not_connected');
    }
    return this.http.fail(call, response);
  }

  /** True when the state check succeeds and the state is not `connected`. */
  private async isNotConnected(name: ProviderInstanceName): Promise<boolean> {
    try {
      return (await this.getConnectionState(name)) !== 'connected';
    } catch (error) {
      if (error instanceof ProviderError) {
        this.logger.warn(
          { instance_name: name, provider_error_code: error.code },
          'Evolution state check after a failed send failed',
        );
        return false;
      }
      throw error;
    }
  }

  private async expectOk(call: EvolutionCall): Promise<EvolutionResponse> {
    const response = await this.http.call(call);
    if (response.status >= 200 && response.status < 300) return response;
    throw this.http.fail(call, response);
  }

  private call(
    operation: string,
    method: EvolutionCall['method'],
    route: string,
    instanceName: ProviderInstanceName | undefined,
    extra: { body?: unknown; query?: string; timeoutMs?: number; maxResponseBytes?: number } = {},
  ): EvolutionCall {
    const path = instanceName === undefined ? route : instancePath(route, instanceName);
    const call: EvolutionCall = {
      operation,
      method,
      route,
      path: `${path}${extra.query ?? ''}`,
      timeoutMs: extra.timeoutMs ?? this.timeouts.requestMs,
    };
    if (instanceName !== undefined) call.instanceName = instanceName;
    if (extra.body !== undefined) call.body = extra.body;
    if (extra.maxResponseBytes !== undefined) call.maxResponseBytes = extra.maxResponseBytes;
    return call;
  }
}
