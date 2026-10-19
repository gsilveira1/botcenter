import { z } from 'zod';

/** Identifier of a database row (UUID, version 7 in practice). */
export const Uuid = z.uuid();
export type Uuid = z.infer<typeof Uuid>;

/** ISO 8601 date and time. The API writes UTC (`Z`). Requests can use an offset. */
export const IsoDateTime = z.iso.datetime({ offset: true });
export type IsoDateTime = z.infer<typeof IsoDateTime>;

/**
 * Phone number in E.164 format without the `+` sign: digits only, 10 to 15 digits, no leading zero.
 * Example: `5511987654321`.
 */
export const PhoneNumber = z
  .string()
  .regex(/^[1-9]\d{9,14}$/, 'Must be an E.164 number without "+": 10 to 15 digits');
export type PhoneNumber = z.infer<typeof PhoneNumber>;

/** Phone number with the middle digits masked (`5511*****4321`). Logs and responses use it. */
export const MaskedPhoneNumber = z.string().regex(/^\d{2,6}\*+\d{2,4}$/);
export type MaskedPhoneNumber = z.infer<typeof MaskedPhoneNumber>;

/** Maximum length of a URL in a request. */
export const URL_MAX_LENGTH = 2048;

/**
 * HTTPS URL without user information. The schema normalizes the URL (lowercase scheme and host).
 * The API also applies an SSRF guard (private ranges) at request time and at delivery time.
 */
export const HttpsUrl = z
  .url({ protocol: /^https$/, normalize: true })
  .max(URL_MAX_LENGTH)
  .refine((value) => {
    // The format check above reports a malformed URL. Do not report it two times.
    if (!URL.canParse(value)) {
      return true;
    }
    const parsed = new URL(value);
    return parsed.username === '' && parsed.password === '';
  }, 'The URL must not contain a user name or a password');
export type HttpsUrl = z.infer<typeof HttpsUrl>;

/** Route parameter `{id}` for resources with a UUID. */
export const UuidParam = z.object({ id: Uuid });
export type UuidParam = z.infer<typeof UuidParam>;

/**
 * Identifier of a bot: a slug that the client chooses (`PUT /v1/bots/{id}`), unique in the tenant.
 * The database keeps a UUID primary key and this slug.
 */
export const BotId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'Must be a slug: a-z, 0-9, and "-"');
export type BotId = z.infer<typeof BotId>;
