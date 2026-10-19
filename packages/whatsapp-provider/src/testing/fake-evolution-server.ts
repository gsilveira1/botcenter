import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { MediaType } from '@botcenter/contracts';
import {
  connectionData,
  createInstanceResponse,
  type EvolutionAckStatus,
  errorBody,
  fakePairingCode,
  fakeQrcode,
  newMessageId,
  qrcodeData,
  sentMessageRaw,
  updateData,
  upsertData,
  webhookEnvelope,
} from './evolution-payloads.js';

/**
 * An in-process HTTP server that answers like Evolution API v2.3.7 (Baileys channel) for the
 * routes of `EvolutionProvider`, records the calls, injects failures, and sends realistic webhooks.
 * No WhatsApp connection exists: the tests decide when a number connects or a message arrives.
 */

export type FakeEvolutionState = 'close' | 'connecting' | 'open';

export interface FakeWebhookConfig {
  url: string;
  headers: Record<string, string>;
  events: string[];
}

export interface FakeSentMessage {
  id: string;
  route: string;
  to: string;
  body: Record<string, unknown>;
  at: Date;
}

export interface FakeInstance {
  name: string;
  instanceId: string;
  state: FakeEvolutionState;
  /** The phone of the connected number, after `emitConnected`. */
  phone?: string;
  webhook?: FakeWebhookConfig;
  settings: Record<string, unknown>;
  qrcode?: { code: string; base64: string; pairingCode: string | null };
  sent: FakeSentMessage[];
}

export interface RecordedCall {
  method: string;
  /** The path without the query string. */
  path: string;
  /** The route without the instance name, for example `/message/sendText`. */
  route: string;
  instanceName?: string;
  query: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  at: Date;
}

export interface FailureRule {
  method?: string;
  /** A route (`/message/sendText`) or a pattern that the path must match. Default: every route. */
  route?: string | RegExp;
  /** The HTTP status to answer. Default 500. */
  status?: number;
  /** The body to answer. Default: an Evolution error body. */
  body?: unknown;
  /** Wait this time before the answer (or before the normal handling when `status` is not set). */
  delayMs?: number;
  /** Never answer. The client gets a timeout. */
  hang?: boolean;
  /** Close the socket without an answer. The client gets a network error. */
  dropConnection?: boolean;
  /** How many requests the rule applies to. Default 1. */
  times?: number;
}

export interface WebhookDelivery {
  url: string;
  event: string;
  body: Record<string, unknown>;
  /** The HTTP status of the webhook receiver, or undefined when the request failed. */
  status?: number;
  error?: string;
}

export interface FakeEvolutionServerOptions {
  /** The global API key (`apikey` header). Default `fake-evolution-key`. */
  apiKey?: string;
  host?: string;
  /** Default 0 (a random free port). */
  port?: number;
  /** Send `connection.update` and `qrcode.updated` on connect, and `connection.update` on logout. Default true. */
  autoWebhooks?: boolean;
  /** After each send, send `messages.update` webhooks up to this status. Default: none. */
  autoStatus?: 'sent' | 'delivered' | 'read';
  /** The maximum number of recorded calls (a load test makes many). Default 10 000. */
  maxRecordedCalls?: number;
  /** The time limit of one webhook request. Default 5 000 ms. */
  webhookTimeoutMs?: number;
  /** Called when an automatic webhook fails. Default: `console.warn`. */
  onWebhookError?: (delivery: WebhookDelivery) => void;
}

export interface InboundBase {
  from: string;
  id?: string;
  pushName?: string;
  timestamp?: Date;
}

const STATUS_ALIASES: Record<string, EvolutionAckStatus> = {
  sent: 'SERVER_ACK',
  delivered: 'DELIVERY_ACK',
  read: 'READ',
  failed: 'ERROR',
};
const AUTO_STATUS_SEQUENCE: EvolutionAckStatus[] = ['SERVER_ACK', 'DELIVERY_ACK', 'READ'];
const SEND_ROUTES = new Set(['sendText', 'sendMedia', 'sendButtons', 'sendList']);

class HttpAnswer {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {}
}

function digits(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\D/g, '') : '';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class FakeEvolutionServer {
  readonly apiKey: string;
  private readonly instances = new Map<string, FakeInstance>();
  private readonly media = new Map<string, { data: Buffer; mimeType: string; fileName?: string }>();
  private readonly invalidRecipients = new Set<string>();
  private readonly failures: FailureRule[] = [];
  private readonly recorded: RecordedCall[] = [];
  private readonly webhookDeliveries: WebhookDelivery[] = [];
  private readonly pending = new Set<Promise<unknown>>();
  private readonly hanging = new Set<ServerResponse>();
  private serverUrl = '';

  private constructor(
    private readonly server: Server,
    private readonly options: FakeEvolutionServerOptions,
  ) {
    this.apiKey = options.apiKey ?? 'fake-evolution-key';
  }

  static async start(options: FakeEvolutionServerOptions = {}): Promise<FakeEvolutionServer> {
    const server = createServer();
    const fake = new FakeEvolutionServer(server, options);
    server.on('request', (req: IncomingMessage, res: ServerResponse) => {
      fake.handle(req, res).catch((error: unknown) => {
        console.warn(`FakeEvolutionServer: request handling failed: ${String(error)}`);
        if (res.headersSent) res.destroy();
        else send(res, 500, errorBody(500, 'Fake server error'));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => resolve());
    });
    const address = server.address() as AddressInfo;
    const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
    fake.serverUrl = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${address.port}`;
    return fake;
  }

  /** The base URL for `EvolutionProvider` (`baseUrl`). */
  get url(): string {
    return this.serverUrl;
  }

  /** Stops the server. It waits for the automatic webhooks that are in progress. */
  async close(): Promise<void> {
    for (const res of this.hanging) res.destroy();
    this.hanging.clear();
    await Promise.allSettled([...this.pending]);
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  // ---------------------------------------------------------------------------
  // Inspection and control
  // ---------------------------------------------------------------------------

  get calls(): readonly RecordedCall[] {
    return this.recorded;
  }

  callsTo(route: string, method?: string): RecordedCall[] {
    return this.recorded.filter(
      (call) => call.route === route && (method === undefined || call.method === method),
    );
  }

  clearCalls(): void {
    this.recorded.length = 0;
  }

  /** The webhooks that the server sent (automatic and helper calls). */
  get deliveries(): readonly WebhookDelivery[] {
    return this.webhookDeliveries;
  }

  failNext(rule: FailureRule = {}): void {
    this.failures.push({ times: 1, ...rule });
  }

  clearFailures(): void {
    this.failures.length = 0;
  }

  instance(name: string): FakeInstance | undefined {
    return this.instances.get(name);
  }

  /** Changes the state without a webhook. */
  setState(name: string, state: FakeEvolutionState, phone?: string): void {
    const instance = this.require(name);
    instance.state = state;
    if (phone) instance.phone = phone;
  }

  /** Sends to this phone answer 400 `exists: false`, like a number without WhatsApp. */
  addInvalidRecipient(phone: string): void {
    this.invalidRecipients.add(digits(phone));
  }

  /** The media that `getBase64FromMediaMessage` returns for this message id. */
  setMedia(
    name: string,
    messageId: string,
    media: { data: Buffer; mimeType: string; fileName?: string },
  ): void {
    this.media.set(`${name}:${messageId}`, media);
  }

  /** Waits for the automatic webhooks that are in progress. */
  async flushWebhooks(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  // ---------------------------------------------------------------------------
  // Webhook helpers. Each one sends one webhook and returns the delivery.
  // ---------------------------------------------------------------------------

  async emitQrcode(
    name: string,
    options: { pairingCode?: string | null } = {},
  ): Promise<WebhookDelivery> {
    const instance = this.require(name);
    const qr = { ...fakeQrcode(), pairingCode: options.pairingCode ?? null };
    instance.qrcode = qr;
    if (instance.state === 'close') instance.state = 'connecting';
    return this.emit(instance, 'qrcode.updated', qrcodeData(name, qr));
  }

  async emitConnecting(name: string): Promise<WebhookDelivery> {
    const instance = this.require(name);
    instance.state = 'connecting';
    return this.emit(instance, 'connection.update', connectionData(name, 'connecting', 200));
  }

  async emitConnected(name: string, phone: string, profileName?: string): Promise<WebhookDelivery> {
    const instance = this.require(name);
    instance.state = 'open';
    instance.phone = digits(phone);
    delete instance.qrcode;
    const owner = profileName ? { phone: instance.phone, profileName } : { phone: instance.phone };
    return this.emit(instance, 'connection.update', connectionData(name, 'open', 200, owner));
  }

  /**
   * Sends `close` with a code that Evolution reconnects (default 428). Note: Evolution 2.3.7 does not
   * send this event for these codes; it reconnects and sends `connecting`. Use it for negative tests.
   */
  async emitDisconnected(name: string, statusReason = 428): Promise<WebhookDelivery> {
    const instance = this.require(name);
    instance.state = 'close';
    return this.emit(instance, 'connection.update', connectionData(name, 'close', statusReason));
  }

  /** Sends `close` with 401: the person removed the device on the phone. */
  async emitLoggedOut(name: string): Promise<WebhookDelivery> {
    const instance = this.require(name);
    instance.state = 'close';
    return this.emit(instance, 'connection.update', connectionData(name, 'close', 401));
  }

  /** Sends `refused`: the QR code limit was reached before a phone paired. */
  async emitRefused(name: string): Promise<WebhookDelivery> {
    const instance = this.require(name);
    instance.state = 'close';
    return this.emit(instance, 'connection.update', connectionData(name, 'refused', 428));
  }

  async emitInboundText(
    name: string,
    input: InboundBase & { text: string },
  ): Promise<WebhookDelivery> {
    return this.emitUpsert(name, { conversation: input.text }, 'conversation', input);
  }

  async emitButtonReply(
    name: string,
    input: InboundBase & { buttonId: string; title: string },
  ): Promise<WebhookDelivery> {
    const message = {
      buttonsResponseMessage: {
        selectedButtonId: input.buttonId,
        selectedDisplayText: input.title,
        type: 1,
      },
    };
    return this.emitUpsert(name, message, 'buttonsResponseMessage', input);
  }

  async emitListReply(
    name: string,
    input: InboundBase & { rowId: string; title: string },
  ): Promise<WebhookDelivery> {
    const message = {
      listResponseMessage: {
        title: input.title,
        listType: 1,
        singleSelectReply: { selectedRowId: input.rowId },
      },
    };
    return this.emitUpsert(name, message, 'listResponseMessage', input);
  }

  /** Sends a media message and stores `data` for `downloadMedia`. */
  async emitInboundMedia(
    name: string,
    input: InboundBase & {
      mediaType: MediaType;
      mimeType: string;
      caption?: string;
      fileName?: string;
      data?: Buffer;
    },
  ): Promise<WebhookDelivery> {
    const id = input.id ?? newMessageId();
    const content: Record<string, unknown> = {
      url: 'https://mmg.whatsapp.net/v/t62.7118-24/fake.enc',
      mimetype: input.mimeType,
      fileLength: { low: input.data?.length ?? 0, high: 0, unsigned: true },
      mediaKey: { '0': 1, '1': 2, '2': 3 },
      directPath: '/v/t62.7118-24/fake.enc',
    };
    if (input.caption) content.caption = input.caption;
    if (input.fileName) content.fileName = input.fileName;
    this.setMedia(name, id, {
      data: input.data ?? Buffer.from('fake-media'),
      mimeType: input.mimeType,
      ...(input.fileName ? { fileName: input.fileName } : {}),
    });
    const type = `${input.mediaType}Message`;
    return this.emitUpsert(name, { [type]: content }, type, { ...input, id });
  }

  /** Sends `messages.update` for a message that the connected number sent. */
  async emitStatus(
    name: string,
    input: {
      messageId: string;
      status: EvolutionAckStatus | 'sent' | 'delivered' | 'read' | 'failed';
      to?: string;
    },
  ): Promise<WebhookDelivery> {
    const instance = this.require(name);
    const status = STATUS_ALIASES[input.status] ?? (input.status as EvolutionAckStatus);
    const to = input.to ?? instance.sent.find((sent) => sent.id === input.messageId)?.to;
    return this.emit(
      instance,
      'messages.update',
      updateData(input.messageId, to, status, instance.instanceId),
    );
  }

  /** Sends any body to the webhook of the instance (for invalid payload tests). */
  async emitRaw(name: string, body: Record<string, unknown>): Promise<WebhookDelivery> {
    const instance = this.require(name);
    return this.post(instance, String(body.event ?? 'raw'), body);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private require(name: string): FakeInstance {
    const instance = this.instances.get(name);
    if (!instance) throw new Error(`FakeEvolutionServer: the instance "${name}" does not exist`);
    return instance;
  }

  private async emitUpsert(
    name: string,
    message: Record<string, unknown>,
    messageType: string,
    input: InboundBase,
  ): Promise<WebhookDelivery> {
    const instance = this.require(name);
    const data = upsertData(message, messageType, {
      from: digits(input.from),
      instanceId: instance.instanceId,
      ...(input.id ? { id: input.id } : {}),
      ...(input.pushName ? { pushName: input.pushName } : {}),
      ...(input.timestamp ? { timestamp: input.timestamp } : {}),
    });
    return this.emit(instance, 'messages.upsert', data);
  }

  private async emit(
    instance: FakeInstance,
    event: string,
    data: unknown,
  ): Promise<WebhookDelivery> {
    const eventName = event.replace(/\./g, '_').toUpperCase();
    if (!instance.webhook) {
      throw new Error(`FakeEvolutionServer: the instance "${instance.name}" has no webhook`);
    }
    if (!instance.webhook.events.includes(eventName)) {
      // Evolution does not send an event that the instance did not ask for.
      return { url: instance.webhook.url, event, body: {}, error: 'event not subscribed' };
    }
    const body = webhookEnvelope(event, instance.name, data, {
      destination: instance.webhook.url,
      serverUrl: this.serverUrl,
      ...(instance.phone ? { sender: `${instance.phone}@s.whatsapp.net` } : {}),
    });
    return this.post(instance, event, body);
  }

  private async post(
    instance: FakeInstance,
    event: string,
    body: Record<string, unknown>,
  ): Promise<WebhookDelivery> {
    const webhook = instance.webhook;
    if (!webhook)
      throw new Error(`FakeEvolutionServer: the instance "${instance.name}" has no webhook`);
    const delivery: WebhookDelivery = { url: webhook.url, event, body };
    try {
      const response = await fetch(webhook.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...webhook.headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.webhookTimeoutMs ?? 5_000),
      });
      await response.arrayBuffer();
      delivery.status = response.status;
    } catch (error) {
      delivery.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
    this.webhookDeliveries.push(delivery);
    return delivery;
  }

  /** Runs automatic webhooks in the background and reports each failure. */
  private background(task: () => Promise<WebhookDelivery | WebhookDelivery[]>): void {
    const promise = task()
      .then((result) => {
        for (const delivery of Array.isArray(result) ? result : [result]) {
          const failed = delivery.error !== undefined || (delivery.status ?? 0) >= 300;
          if (failed && delivery.error !== 'event not subscribed')
            this.reportWebhookError(delivery);
        }
      })
      .catch((error: unknown) => {
        this.reportWebhookError({
          url: '',
          event: 'unknown',
          body: {},
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => this.pending.delete(promise));
    this.pending.add(promise);
  }

  private reportWebhookError(delivery: WebhookDelivery): void {
    if (this.options.onWebhookError) {
      this.options.onWebhookError(delivery);
      return;
    }
    console.warn(
      `FakeEvolutionServer: webhook "${delivery.event}" failed (status ${delivery.status ?? 'none'}, ${delivery.error ?? 'no error'})`,
    );
  }

  private record(call: RecordedCall): void {
    const max = this.options.maxRecordedCalls ?? 10_000;
    this.recorded.push(call);
    if (this.recorded.length > max) this.recorded.splice(0, this.recorded.length - max);
  }

  private takeFailure(method: string, path: string, route: string): FailureRule | undefined {
    const index = this.failures.findIndex((rule) => {
      if (rule.method && rule.method.toUpperCase() !== method) return false;
      if (rule.route === undefined) return true;
      return typeof rule.route === 'string' ? rule.route === route : rule.route.test(path);
    });
    if (index < 0) return undefined;
    const rule = this.failures[index]!;
    rule.times = (rule.times ?? 1) - 1;
    if (rule.times <= 0) this.failures.splice(index, 1);
    return rule;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://fake');
    const method = (req.method ?? 'GET').toUpperCase();
    const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const routeSegments = segments.length >= 3 ? segments.slice(0, 2) : segments;
    const instanceName = segments.length >= 3 ? segments[2] : undefined;
    const route = `/${routeSegments.join('/')}`;
    let body: unknown;
    try {
      const raw = await readBody(req);
      body = raw.length > 0 ? (JSON.parse(raw) as unknown) : undefined;
    } catch (error) {
      if (error instanceof SyntaxError) {
        send(res, 400, errorBody(400, ['Invalid JSON body']));
        return;
      }
      throw error;
    }

    const call: RecordedCall = {
      method,
      path: url.pathname,
      route,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      body,
      at: new Date(),
    };
    if (instanceName !== undefined) call.instanceName = instanceName;
    this.record(call);

    const failure = this.takeFailure(method, url.pathname, route);
    if (failure) {
      if (failure.dropConnection) {
        req.socket.destroy();
        return;
      }
      if (failure.hang) {
        this.hanging.add(res);
        res.on('close', () => this.hanging.delete(res));
        return;
      }
      if (failure.delayMs) await new Promise((resolve) => setTimeout(resolve, failure.delayMs));
      if (failure.status !== undefined) {
        send(res, failure.status, failure.body ?? errorBody(failure.status, ['Injected failure']));
        return;
      }
    }

    try {
      const answer = this.route(method, route, instanceName, call, req.headers.apikey);
      send(res, answer.status, answer.body);
    } catch (error) {
      if (error instanceof HttpAnswer) {
        send(res, error.status, error.body);
        return;
      }
      send(res, 500, errorBody(500, error instanceof Error ? error.message : String(error)));
    }
  }

  private route(
    method: string,
    route: string,
    instanceName: string | undefined,
    call: RecordedCall,
    apikey: string | string[] | undefined,
  ): HttpAnswer {
    if (method === 'GET' && route === '/') {
      return new HttpAnswer(200, {
        status: 200,
        message: 'Welcome to the Evolution API, it is working!',
        version: '2.3.7',
        clientName: 'fake',
        documentation: 'https://doc.evolution-api.com',
        whatsappWebVersion: '2.3000.0',
      });
    }
    const instanceRoute = instanceName !== undefined && route !== '/__fake/instances';
    // Evolution checks that the instance exists before it checks the API key (`instanceExistsGuard`).
    if (instanceRoute && route !== '/instance/create') this.existing(instanceName);
    if (apikey !== this.apiKey) throw new HttpAnswer(401, errorBody(401, 'Unauthorized'));

    const body = isObject(call.body) ? call.body : {};
    switch (`${method} ${route}`) {
      case 'POST /instance/create':
        return this.create(body);
      case 'GET /instance/fetchInstances':
        return this.fetchInstances(call.query.instanceName);
      case 'GET /instance/connect':
        return this.connect(this.existing(instanceName), call.query.number);
      case 'GET /instance/connectionState': {
        const instance = this.existing(instanceName);
        return new HttpAnswer(200, {
          instance: { instanceName: instance.name, state: instance.state },
        });
      }
      case 'DELETE /instance/logout':
        return this.logout(this.existing(instanceName));
      case 'DELETE /instance/delete':
        this.instances.delete(this.existing(instanceName).name);
        return new HttpAnswer(200, {
          status: 'SUCCESS',
          error: false,
          response: { message: 'Instance deleted' },
        });
      case 'POST /webhook/set':
        return this.setWebhook(this.existing(instanceName), body);
      case 'POST /settings/set': {
        const instance = this.existing(instanceName);
        instance.settings = { ...body };
        return new HttpAnswer(201, {
          settings: { instanceName: instance.name, settings: instance.settings },
        });
      }
      case 'POST /chat/getBase64FromMediaMessage':
        return this.getBase64(this.existing(instanceName), body);
      default:
        break;
    }
    if (
      method === 'POST' &&
      route.startsWith('/message/') &&
      SEND_ROUTES.has(route.slice('/message/'.length))
    ) {
      return this.sendMessage(this.existing(instanceName), route.slice('/message/'.length), body);
    }
    if (method === 'POST' && route === '/__fake/instances' && instanceName !== undefined) {
      return this.control(this.existing(instanceName), call);
    }
    throw new HttpAnswer(404, errorBody(404, [`Cannot ${method} ${call.path}`]));
  }

  private existing(name: string | undefined): FakeInstance {
    const instance = name === undefined ? undefined : this.instances.get(name);
    if (!instance)
      throw new HttpAnswer(404, errorBody(404, [`The "${name}" instance does not exist`]));
    return instance;
  }

  private create(body: Record<string, unknown>): HttpAnswer {
    const name = body.instanceName;
    if (typeof name !== 'string' || name.length === 0) {
      throw new HttpAnswer(400, errorBody(400, ['The "instanceName" cannot be empty']));
    }
    if (this.instances.has(name)) {
      throw new HttpAnswer(403, errorBody(403, [`This name "${name}" is already in use.`]));
    }
    if (body.integration !== 'WHATSAPP-BAILEYS') {
      throw new HttpAnswer(400, errorBody(400, ['Invalid integration']));
    }
    const settings = {
      rejectCall: body.rejectCall === true,
      msgCall: typeof body.msgCall === 'string' ? body.msgCall : '',
      groupsIgnore: body.groupsIgnore === true,
      alwaysOnline: body.alwaysOnline === true,
      readMessages: body.readMessages === true,
      readStatus: body.readStatus === true,
      syncFullHistory: body.syncFullHistory === true,
      wavoipToken: '',
    };
    const instance: FakeInstance = {
      name,
      instanceId: randomUUID(),
      state: 'close',
      settings,
      sent: [],
    };
    if (isObject(body.webhook)) instance.webhook = toWebhook(body.webhook);
    this.instances.set(name, instance);
    return new HttpAnswer(201, createInstanceResponse(body, instance.instanceId, settings));
  }

  private fetchInstances(name: string | undefined): HttpAnswer {
    if (name !== undefined && !this.instances.has(name)) {
      throw new HttpAnswer(404, errorBody(404, [`Instance "${name}" not found`]));
    }
    const list = [...this.instances.values()]
      .filter((instance) => name === undefined || instance.name === name)
      .map((instance) => ({
        id: instance.instanceId,
        name: instance.name,
        connectionStatus: instance.state,
        ownerJid: instance.phone ? `${instance.phone}@s.whatsapp.net` : null,
        integration: 'WHATSAPP-BAILEYS',
      }));
    return new HttpAnswer(200, list);
  }

  private connect(instance: FakeInstance, number: string | undefined): HttpAnswer {
    if (instance.state === 'open') {
      return new HttpAnswer(200, { instance: { instanceName: instance.name, state: 'open' } });
    }
    if (instance.state === 'close') {
      instance.state = 'connecting';
      instance.qrcode = { ...fakeQrcode(), pairingCode: number ? fakePairingCode() : null };
      if (this.options.autoWebhooks !== false && instance.webhook) {
        const qr = instance.qrcode;
        this.background(async () => [
          await this.emit(
            instance,
            'connection.update',
            connectionData(instance.name, 'connecting', 200),
          ),
          await this.emit(instance, 'qrcode.updated', qrcodeData(instance.name, qr)),
        ]);
      }
    }
    const qr = instance.qrcode;
    return new HttpAnswer(200, {
      pairingCode: qr?.pairingCode ?? null,
      code: qr?.code,
      base64: qr?.base64,
      count: qr ? 1 : 0,
    });
  }

  private logout(instance: FakeInstance): HttpAnswer {
    if (instance.state === 'close') {
      throw new HttpAnswer(
        400,
        errorBody(400, [`The "${instance.name}" instance is not connected`]),
      );
    }
    instance.state = 'close';
    delete instance.qrcode;
    if (this.options.autoWebhooks !== false && instance.webhook) {
      this.background(() =>
        this.emit(instance, 'connection.update', connectionData(instance.name, 'close', 401)),
      );
    }
    return new HttpAnswer(200, {
      status: 'SUCCESS',
      error: false,
      response: { message: 'Instance logged out' },
    });
  }

  private setWebhook(instance: FakeInstance, body: Record<string, unknown>): HttpAnswer {
    const webhook = isObject(body.webhook) ? body.webhook : undefined;
    if (!webhook || typeof webhook.url !== 'string' || webhook.enabled === undefined) {
      throw new HttpAnswer(400, errorBody(400, ['requires property "webhook"']));
    }
    instance.webhook = toWebhook(webhook);
    return new HttpAnswer(201, {
      id: randomUUID(),
      url: instance.webhook.url,
      headers: instance.webhook.headers,
      enabled: true,
      events: instance.webhook.events,
      webhookByEvents: false,
      webhookBase64: false,
      instanceId: instance.instanceId,
    });
  }

  private sendMessage(
    instance: FakeInstance,
    kind: string,
    body: Record<string, unknown>,
  ): HttpAnswer {
    // The real answers for an instance without a WhatsApp session (see the recorded fixtures).
    if (instance.state === 'close') {
      throw new HttpAnswer(
        500,
        errorBody(500, "Cannot read properties of undefined (reading 'onWhatsApp')"),
      );
    }
    if (instance.state === 'connecting') {
      throw new HttpAnswer(
        500,
        errorBody(500, "Cannot read properties of undefined (reading 'find')"),
      );
    }
    const to = digits(body.number);
    if (!to) throw new HttpAnswer(400, errorBody(400, ['instance requires property "number"']));
    if (this.invalidRecipients.has(to)) {
      throw new HttpAnswer(
        400,
        errorBody(400, [{ jid: `${to}@s.whatsapp.net`, exists: false, number: to }]),
      );
    }
    const { message, messageType } = sentContent(kind, body);
    const id = newMessageId();
    instance.sent.push({ id, route: kind, to, body, at: new Date() });
    if (this.options.autoStatus && instance.webhook) {
      const last = AUTO_STATUS_SEQUENCE.indexOf(STATUS_ALIASES[this.options.autoStatus]!);
      this.background(async () => {
        const deliveries: WebhookDelivery[] = [];
        for (const status of AUTO_STATUS_SEQUENCE.slice(0, last + 1)) {
          deliveries.push(
            await this.emit(
              instance,
              'messages.update',
              updateData(id, to, status, instance.instanceId),
            ),
          );
        }
        return deliveries;
      });
    }
    return new HttpAnswer(201, sentMessageRaw(to, id, message, messageType, instance.instanceId));
  }

  private getBase64(instance: FakeInstance, body: Record<string, unknown>): HttpAnswer {
    const message = isObject(body.message) ? body.message : {};
    const key = isObject(message.key) ? message.key : {};
    const media =
      typeof key.id === 'string' ? this.media.get(`${instance.name}:${key.id}`) : undefined;
    if (!media) throw new HttpAnswer(400, errorBody(400, ['Message not found']));
    return new HttpAnswer(201, {
      mediaType: 'documentMessage',
      fileName: media.fileName ?? `${String(key.id)}.bin`,
      size: { fileLength: { low: media.data.length, high: 0, unsigned: true } },
      mimetype: media.mimeType,
      base64: media.data.toString('base64'),
      buffer: null,
    });
  }

  /**
   * Control routes for a fake that runs in another process (`fake-evolution` CLI, k6 load test):
   * `POST /__fake/instances/{name}` with `{ "action": "connected", "phone": "5511..." }`,
   * `{ "action": "inbound_text", "from": "...", "text": "..." }`, `{ "action": "logged_out" }`,
   * or `{ "action": "status", "messageId": "...", "status": "delivered" }`.
   */
  private control(instance: FakeInstance, call: RecordedCall): HttpAnswer {
    const body = isObject(call.body) ? call.body : {};
    const action = body.action;
    const run = (task: () => Promise<WebhookDelivery>) => {
      this.background(task);
      return new HttpAnswer(202, { accepted: true });
    };
    switch (action) {
      case 'connected':
        return run(() => this.emitConnected(instance.name, String(body.phone ?? '5511900000000')));
      case 'logged_out':
        return run(() => this.emitLoggedOut(instance.name));
      case 'inbound_text':
        return run(() =>
          this.emitInboundText(instance.name, {
            from: String(body.from ?? ''),
            text: String(body.text ?? ''),
          }),
        );
      case 'status':
        return run(() =>
          this.emitStatus(instance.name, {
            messageId: String(body.messageId ?? ''),
            status: String(body.status ?? 'delivered') as 'delivered',
          }),
        );
      default:
        throw new HttpAnswer(400, errorBody(400, [`Unknown action "${String(action)}"`]));
    }
  }
}

function toWebhook(webhook: Record<string, unknown>): FakeWebhookConfig {
  const headers = isObject(webhook.headers)
    ? Object.fromEntries(
        Object.entries(webhook.headers).map(([key, value]) => [key, String(value)]),
      )
    : {};
  const events = Array.isArray(webhook.events) ? webhook.events.map(String) : [];
  return { url: String(webhook.url), headers, events };
}

function sentContent(kind: string, body: Record<string, unknown>) {
  switch (kind) {
    case 'sendText':
      if (typeof body.text !== 'string' || body.text.trim().length === 0) {
        throw new HttpAnswer(400, errorBody(400, ['Text is required']));
      }
      return { message: { conversation: body.text }, messageType: 'conversation' };
    case 'sendMedia': {
      const mediatype = String(body.mediatype ?? '');
      if (typeof body.media !== 'string' || !/^https?:\/\/[^/]+\.[^/]+/.test(body.media)) {
        throw new HttpAnswer(400, errorBody(400, ['Owned media must be a url or base64']));
      }
      const content: Record<string, unknown> = {
        url: body.media,
        mimetype: body.mimetype ?? 'application/octet-stream',
      };
      if (body.caption) content.caption = body.caption;
      if (body.fileName) content.fileName = body.fileName;
      return { message: { [`${mediatype}Message`]: content }, messageType: `${mediatype}Message` };
    }
    case 'sendButtons':
      return {
        message: {
          viewOnceMessage: {
            message: { interactiveMessage: { body: { text: `*${String(body.title)}*` } } },
          },
        },
        messageType: 'viewOnceMessage',
      };
    default:
      return {
        message: {
          listMessage: {
            title: body.title,
            buttonText: body.buttonText,
            sections: body.sections,
            listType: 2,
          },
        },
        messageType: 'listMessage',
      };
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
