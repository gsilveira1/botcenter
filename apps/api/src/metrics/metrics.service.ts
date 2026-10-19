import { Inject, Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { CounterConfiguration, GaugeConfiguration, HistogramConfiguration } from 'prom-client';
import { ENV } from '../config/env';
import type { AppEnv } from '../config/env';
import { getLogger } from '../logging/logger';

/** A function that updates gauges before a scrape (for example, queue sizes read from Redis). */
export type MetricsCollector = () => Promise<void>;

const COLLECTOR_TIMEOUT_MS = 3_000;

/**
 * The Prometheus registry of the process. The metric names are fixed: the alert rules and the dashboard
 * of `infra/` use them. Other slices update the shared metrics below, or add a metric with
 * `counter()`, `gauge()`, or `histogram()` (the same name returns the same metric).
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();
  private readonly collectors: MetricsCollector[] = [];
  private readonly logger = getLogger('metrics');

  /** HTTP latency of the API (`route` is the route template, for example `/v1/messages/:id`). */
  readonly httpRequestDuration: Histogram<'method' | 'route' | 'status_code'>;
  /** Instances by status. The API process sets it from the database at each scrape. */
  readonly instances: Gauge<'status'>;
  /** Age in seconds of the oldest waiting job of each queue. The API process sets it at each scrape. */
  readonly queueDelay: Gauge<'queue'>;
  /** Jobs of each queue by state (`waiting`, `active`, `delayed`, `failed`, `prioritized`). */
  readonly queueSize: Gauge<'queue' | 'state'>;
  /** Outbound and inbound messages by status (`queued`, `sent`, `delivered`, `read`, `failed`, `received`). */
  readonly messagesTotal: Counter<'status'>;
  /** Webhook delivery attempts by result (`succeeded`, `failed`, `dead`). */
  readonly webhookDeliveriesTotal: Counter<'result'>;
  /** Requests or sends refused by a rate limit (`scope`: `key` or `instance`). */
  readonly rateLimitDeniedTotal: Counter<'scope'>;
  /** Job runs by queue and result (`completed`, `failed`, `delayed`: moved back to wait, not an attempt; also `RetryLaterError`). */
  readonly jobsTotal: Counter<'queue' | 'result'>;
  readonly jobDuration: Histogram<'queue'>;
  /** Events of the provider webhook (`enqueued`, `duplicate`, `ignored`, `rejected`, `unhandled`). */
  readonly inboundEventsTotal: Counter<'result'>;
  /** Requests to an `@Internal()` route that the guard refused (`public_address`, `wrong_secret`). */
  readonly internalRefusedTotal: Counter<'reason'>;

  constructor(@Inject(ENV) env: AppEnv) {
    this.registry.setDefaultLabels({ role: env.ROLE });
    collectDefaultMetrics({ register: this.registry });

    this.httpRequestDuration = this.histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request latency of the API',
      labelNames: ['method', 'route', 'status_code'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    });
    this.instances = this.gauge({
      name: 'botcenter_instances',
      help: 'Instances (not deleted) by status',
      labelNames: ['status'],
    });
    this.queueDelay = this.gauge({
      name: 'botcenter_queue_delay_seconds',
      help: 'Age of the oldest waiting job of the queue',
      labelNames: ['queue'],
    });
    this.queueSize = this.gauge({
      name: 'botcenter_queue_size',
      help: 'Jobs of the queue by state',
      labelNames: ['queue', 'state'],
    });
    this.messagesTotal = this.counter({
      name: 'botcenter_messages_total',
      help: 'Messages by status change',
      labelNames: ['status'],
    });
    this.webhookDeliveriesTotal = this.counter({
      name: 'botcenter_webhook_deliveries_total',
      help: 'Webhook delivery attempts by result',
      labelNames: ['result'],
    });
    this.rateLimitDeniedTotal = this.counter({
      name: 'botcenter_rate_limit_denied_total',
      help: 'Requests or sends refused by a rate limit',
      labelNames: ['scope'],
    });
    this.jobsTotal = this.counter({
      name: 'botcenter_jobs_total',
      help: 'Queue jobs that ended, by result',
      labelNames: ['queue', 'result'],
    });
    this.jobDuration = this.histogram({
      name: 'botcenter_job_duration_seconds',
      help: 'Processing time of a queue job',
      labelNames: ['queue'],
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
    });
    this.inboundEventsTotal = this.counter({
      name: 'botcenter_inbound_events_total',
      help: 'Events of the provider webhook by result',
      labelNames: ['result'],
    });
    this.internalRefusedTotal = this.counter({
      name: 'botcenter_internal_refused_total',
      help: 'Requests to an internal route refused by the guard',
      labelNames: ['reason'],
    });
  }

  counter<L extends string>(config: CounterConfiguration<L>): Counter<L> {
    return (
      (this.registry.getSingleMetric(config.name) as Counter<L> | undefined) ??
      new Counter({ ...config, registers: [this.registry] })
    );
  }

  gauge<L extends string>(config: GaugeConfiguration<L>): Gauge<L> {
    return (
      (this.registry.getSingleMetric(config.name) as Gauge<L> | undefined) ??
      new Gauge({ ...config, registers: [this.registry] })
    );
  }

  histogram<L extends string>(config: HistogramConfiguration<L>): Histogram<L> {
    return (
      (this.registry.getSingleMetric(config.name) as Histogram<L> | undefined) ??
      new Histogram({ ...config, registers: [this.registry] })
    );
  }

  /** Adds a function that runs before each scrape. A failed collector is logged; the scrape continues. */
  addCollector(collector: MetricsCollector): void {
    this.collectors.push(collector);
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  /** The text exposition of all the metrics, after the collectors ran. */
  async render(): Promise<string> {
    await Promise.all(this.collectors.map((collector) => this.runCollector(collector)));
    return this.registry.metrics();
  }

  private async runCollector(collector: MetricsCollector): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('metrics collector timed out')),
        COLLECTOR_TIMEOUT_MS,
      );
    });
    try {
      await Promise.race([collector(), timeout]);
    } catch (error) {
      this.logger.warn({ err: error }, 'metrics collector failed; the scrape uses the last values');
    } finally {
      clearTimeout(timer);
    }
  }
}
