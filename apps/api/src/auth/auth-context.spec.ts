import { describe, expect, it } from 'vitest';
import { currentLogContext, runWithLogContext } from '../logging/log-context';
import { allowsAllInstances, assertInstanceAllowed, auditActor } from './auth-context';
import type { AuthContext } from './auth-context';

const base: AuthContext = {
  tenantId: 't',
  keyId: 'k',
  keyPrefix: 'abc',
  scopes: ['messages:send'],
  instanceIds: [],
};

describe('assertInstanceAllowed', () => {
  it('allows every instance for an empty list and binds instance_id to the log context', () => {
    runWithLogContext({}, () => {
      assertInstanceAllowed(base, 'i-1');
      expect(currentLogContext()).toEqual({ instance_id: 'i-1' });
    });
    expect(allowsAllInstances(base)).toBe(true);
  });

  it('refuses an instance outside the list with 403 INSTANCE_NOT_ALLOWED', () => {
    const limited = { ...base, instanceIds: ['i-1'] };
    expect(() => assertInstanceAllowed(limited, 'i-1')).not.toThrow();
    expect(() => assertInstanceAllowed(limited, 'i-2')).toThrow(
      expect.objectContaining({ code: 'INSTANCE_NOT_ALLOWED', status: 403 }),
    );
  });

  it('auditActor names the key by its public prefix', () => {
    expect(auditActor(base)).toBe('api_key:abc');
  });
});
