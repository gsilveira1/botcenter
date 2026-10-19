/**
 * WhatsApp JID helpers. Baileys addresses a person as `<digits>@s.whatsapp.net` (phone number)
 * or as `<id>@lid` (a hidden "linked id" that is not a phone number).
 */

const PHONE_JID = /^(\d{6,20})(?::\d+)?@s\.whatsapp\.net$/;

export type JidKind = 'phone' | 'lid' | 'group' | 'broadcast' | 'newsletter' | 'other';

export function jidKind(jid: string): JidKind {
  if (PHONE_JID.test(jid)) return 'phone';
  if (jid.endsWith('@lid')) return 'lid';
  if (jid.endsWith('@g.us')) return 'group';
  if (jid.endsWith('@broadcast')) return 'broadcast';
  if (jid.endsWith('@newsletter')) return 'newsletter';
  return 'other';
}

/** Returns the E.164 digits of a phone JID (the device suffix `:12` is removed), or undefined. */
export function phoneFromJid(jid: string | null | undefined): string | undefined {
  if (!jid) return undefined;
  const match = PHONE_JID.exec(jid);
  return match?.[1];
}

/** The phone JID of E.164 digits. */
export function phoneToJid(phone: string): string {
  return `${phone}@s.whatsapp.net`;
}
