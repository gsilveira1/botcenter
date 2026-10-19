import { createHash } from 'node:crypto';

/**
 * A stable key for one contact in Redis keys and lock names. It is a hash of the phone number, so the
 * phone never appears in a Redis key, a lock name, or a log line about the lock.
 */
export function contactKey(contact: string): string {
  return createHash('sha256').update(contact).digest('hex').slice(0, 32);
}

/** The name of the lock for one conversation (`DistributedLockService`): instance + contact. */
export function conversationLockName(instanceId: string, contact: string): string {
  return `conversation:${instanceId}:${contactKey(contact)}`;
}
