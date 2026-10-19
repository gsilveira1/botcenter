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
  /** Hot state of one conversation. `contactKey` is a hash of the contact phone, never the phone. */
  conversation: (instanceId: string, contactKey: string) =>
    `bc:conversation:${instanceId}:${contactKey}`,
} as const;
