import { describe, expect, it } from 'vitest';
import { VALID_ENV } from '../../test/support/env';
import { EnvError, loadEnv } from './env';

describe('loadEnv', () => {
  it('applies the defaults', () => {
    const { NODE_ENV: _nodeEnv, LOG_LEVEL: _logLevel, ...required } = VALID_ENV;
    const env = loadEnv(required);
    expect(env).toMatchObject({
      NODE_ENV: 'development',
      ROLE: 'api',
      PORT: 3000,
      LOG_LEVEL: 'info',
      BODY_LIMIT_BYTES: 1024 * 1024,
      TRUST_PROXY: 'loopback,linklocal,uniquelocal',
      WORKER_METRICS_PORT: 9464,
      S3_FORCE_PATH_STYLE: false,
    });
    expect(env.ALERT_DISCORD_WEBHOOK_URL).toBeUndefined();
  });

  it('treats an empty optional value as missing and parses booleans and numbers', () => {
    const env = loadEnv({
      ...VALID_ENV,
      ALERT_DISCORD_WEBHOOK_URL: '',
      S3_FORCE_PATH_STYLE: 'true',
      PORT: '8080',
    });
    expect(env.ALERT_DISCORD_WEBHOOK_URL).toBeUndefined();
    expect(env.S3_FORCE_PATH_STYLE).toBe(true);
    expect(env.PORT).toBe(8080);
  });

  it('fails fast with the names of the bad variables and never their values', () => {
    const secret = 'short-secret-value';
    try {
      loadEnv({
        ...VALID_ENV,
        API_KEY_PEPPER: secret,
        DATA_ENCRYPTION_KEY: 'AAAA',
        REDIS_URL: undefined,
        ROLE: 'cron',
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(EnvError);
      const message = (error as EnvError).message;
      for (const name of ['API_KEY_PEPPER', 'DATA_ENCRYPTION_KEY', 'REDIS_URL', 'ROLE']) {
        expect(message).toContain(name);
      }
      expect(message).not.toContain(secret);
    }
  });

  it('accepts only an HTTPS Discord URL', () => {
    expect(() =>
      loadEnv({ ...VALID_ENV, ALERT_DISCORD_WEBHOOK_URL: 'http://discord.test/x' }),
    ).toThrow(EnvError);
  });
});
