import { Inject, Injectable } from '@nestjs/common';
import { Scope } from '@botcenter/contracts';
import { AppError } from '../common/errors/app-error';
import { addressMatcher } from '../common/http/network';
import { ENV } from '../config/env';
import type { AppEnv } from '../config/env';
import { getLogger } from '../logging/logger';
import { TenantsService } from '../services/tenants.service';
import { parseBearer, secretMatches } from './api-key';
import { ApiKeyService } from './api-key.service';
import type { AuthContext } from './auth-context';

export interface AuthenticatedKey {
  context: AuthContext;
  /** Requests per minute of the key (key value or tenant default). */
  rateLimitPerMinute: number;
}

const MATCHER_CACHE_MAX = 1_000;

function unauthenticated(): AppError {
  // One message for every failure, so that a caller cannot learn which part was wrong.
  return new AppError('UNAUTHENTICATED', 'A valid API key is required');
}

/**
 * Checks `Authorization: Bearer bc_live_<prefix>_<secret>`: format, prefix lookup (cache), constant-time
 * hash comparison, revocation, expiry, and the allowed IP list. Every failure is 401 `UNAUTHENTICATED`,
 * except a refused client address (403 `FORBIDDEN`).
 */
@Injectable()
export class ApiKeyAuthenticator {
  private readonly logger = getLogger('auth');
  private readonly matchers = new Map<string, (address: string | undefined) => boolean>();

  constructor(
    @Inject(ENV) private readonly env: AppEnv,
    private readonly keys: ApiKeyService,
    private readonly tenants: TenantsService,
  ) {}

  async authenticate(
    authorization: string | undefined,
    clientIp: string | undefined,
    now = new Date(),
  ): Promise<AuthenticatedKey> {
    const parsed = parseBearer(authorization);
    if (!parsed) {
      throw unauthenticated();
    }
    const record = await this.keys.findByPrefix(parsed.prefix);
    if (!record || !secretMatches(this.env.API_KEY_PEPPER, parsed.secret, record.secretHash)) {
      this.logger.warn(
        { key_prefix: parsed.prefix },
        'api key refused: unknown key or wrong secret',
      );
      throw unauthenticated();
    }
    if (record.revokedAt) {
      this.logger.warn({ key_prefix: record.prefix }, 'api key refused: revoked');
      throw unauthenticated();
    }
    if (record.expiresAt && new Date(record.expiresAt) <= now) {
      this.logger.warn({ key_prefix: record.prefix }, 'api key refused: expired');
      throw unauthenticated();
    }
    if (record.allowedIps.length > 0 && !this.matcherFor(record.id, record.allowedIps)(clientIp)) {
      this.logger.warn(
        { key_prefix: record.prefix, client_ip: clientIp },
        'api key refused: client address not allowed',
      );
      throw new AppError('FORBIDDEN', 'The client address is not allowed for this API key');
    }
    const tenant = await this.tenants.find(record.tenantId);
    if (!tenant) {
      this.logger.error(
        { key_prefix: record.prefix },
        'api key refused: the tenant does not exist',
      );
      throw unauthenticated();
    }
    this.keys.touch(record.id, now);
    return {
      context: {
        tenantId: record.tenantId,
        keyId: record.id,
        keyPrefix: record.prefix,
        scopes: record.scopes.filter((scope): scope is Scope => Scope.safeParse(scope).success),
        instanceIds: record.instanceIds,
      },
      rateLimitPerMinute: record.rateLimitPerMinute ?? tenant.rateLimitPerMinute,
    };
  }

  private matcherFor(keyId: string, allowedIps: string[]) {
    const cacheKey = `${keyId}:${allowedIps.join(',')}`;
    let matcher = this.matchers.get(cacheKey);
    if (!matcher) {
      if (this.matchers.size >= MATCHER_CACHE_MAX) {
        this.matchers.clear();
      }
      try {
        matcher = addressMatcher(allowedIps);
      } catch (error) {
        // A bad entry in the database: refuse every address (fail closed) and tell the operators.
        this.logger.error({ err: error, key_id: keyId }, 'api key has an invalid allowedIps entry');
        matcher = () => false;
      }
      this.matchers.set(cacheKey, matcher);
    }
    return matcher;
  }
}
