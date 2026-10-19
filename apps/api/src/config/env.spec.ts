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

  it('gives the Evolution adapter defaults: the text menu fallback and the adapter time limits', () => {
    const env = loadEnv(VALID_ENV);
    expect(env).toMatchObject({
      EVOLUTION_INTERACTIVE_FALLBACK: 'text',
      EVOLUTION_REQUEST_TIMEOUT_MS: 10_000,
      EVOLUTION_CONNECT_TIMEOUT_MS: 20_000,
      EVOLUTION_SEND_TIMEOUT_MS: 30_000,
      EVOLUTION_MEDIA_TIMEOUT_MS: 60_000,
    });
  });

  it('accepts the native interactive messages and refuses an unknown fallback', () => {
    expect(
      loadEnv({ ...VALID_ENV, EVOLUTION_INTERACTIVE_FALLBACK: 'native' })
        .EVOLUTION_INTERACTIVE_FALLBACK,
    ).toBe('native');
    expect(() => loadEnv({ ...VALID_ENV, EVOLUTION_INTERACTIVE_FALLBACK: 'buttons' })).toThrow(
      /EVOLUTION_INTERACTIVE_FALLBACK/,
    );
    expect(() => loadEnv({ ...VALID_ENV, EVOLUTION_SEND_TIMEOUT_MS: '0' })).toThrow(
      /EVOLUTION_SEND_TIMEOUT_MS/,
    );
  });

  it('parses CONNECT_ALLOWED_ORIGINS as a list of origins and refuses a value with a path', () => {
    expect(loadEnv(VALID_ENV).CONNECT_ALLOWED_ORIGINS).toEqual([]);
    expect(
      loadEnv({
        ...VALID_ENV,
        CONNECT_ALLOWED_ORIGINS: ' https://app.example.com , http://localhost:5173,',
      }).CONNECT_ALLOWED_ORIGINS,
    ).toEqual(['https://app.example.com', 'http://localhost:5173']);
    expect(() =>
      loadEnv({ ...VALID_ENV, CONNECT_ALLOWED_ORIGINS: 'https://app.example.com/path' }),
    ).toThrow(/CONNECT_ALLOWED_ORIGINS/);
    expect(() => loadEnv({ ...VALID_ENV, CONNECT_ALLOWED_ORIGINS: 'not a url' })).toThrow(
      /CONNECT_ALLOWED_ORIGINS/,
    );
  });
});
