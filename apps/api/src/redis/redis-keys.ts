/**
 * Every Redis key of the Bot Center starts with `bc:`. BullMQ uses its own prefix (`bull:`).
 * Add the keys of a new slice here, so that two slices cannot use the same key by accident.
 */
export const redisKeys = {
  apiKey: (prefix: string) => `bc:apikey:${prefix}`,
  apiKeyTouched: (keyId: string) => `bc:apikey-touched:${keyId}`,
  tenant: (tenantId: string) => `bc:tenant:${tenantId}`,
  quota: (name: string, subject: string, window: string) => `bc:quota:${name}:${subject}:${window}`,
  lock: (name: string) => `bc:lock:${name}`,
  inboundDedupe: (dedupeKey: string) => `bc:dedupe:inbound:${dedupeKey}`,
  /** The latest QR code and pairing code of an instance (connect flow). */
  connectCodes: (instanceId: string) => `bc:connect:codes:${instanceId}`,
  /** Pub/sub channel of the connect events of an instance (worker to the API SSE streams). */
  connectChannel: (instanceId: string) => `bc:connect:events:${instanceId}`,
  /** Hash of the open operational incidents (field: incident key, value: ISO open time). */
  incidents: () => 'bc:incidents',
  /** Send token bucket of an instance (messages slice, Lua script). */
  outboundBucket: (instanceId: string) => `bc:bucket:instance:${instanceId}`,
} as const;
