import type { ButtonsContent, ListContent } from '@botcenter/contracts';
import {
  type CreateInstanceInput,
  type SendMessageInput,
  WEBHOOK_SECRET_HEADER,
} from '../types.js';

/**
 * Request bodies of Evolution API v2.3.7. Sources: `src/api/dto/instance.dto.ts`,
 * `src/api/dto/sendMessage.dto.ts`, `src/validate/message.schema.ts`, and
 * `src/api/integrations/event/webhook/webhook.schema.ts`.
 */

/** The webhook events that the Bot Center uses. `SEND_MESSAGE` is not necessary (see the README). */
export const WEBHOOK_EVENTS = [
  'QRCODE_UPDATED',
  'CONNECTION_UPDATE',
  'MESSAGES_UPSERT',
  'MESSAGES_UPDATE',
] as const;

export const BAILEYS_INTEGRATION = 'WHATSAPP-BAILEYS';

/** How the adapter sends `buttons` and `list` content. See the README for the reason of the default. */
export type InteractiveFallback = 'text' | 'native';

export interface InstanceSettings {
  rejectCall: boolean;
  msgCall: string;
  groupsIgnore: boolean;
  alwaysOnline: boolean;
  readMessages: boolean;
  readStatus: boolean;
  syncFullHistory: boolean;
}

export function instanceSettings(rejectCalls: boolean): InstanceSettings {
  return {
    rejectCall: rejectCalls,
    msgCall: '',
    groupsIgnore: true,
    alwaysOnline: false,
    readMessages: false,
    readStatus: false,
    syncFullHistory: false,
  };
}

export function webhookConfig(input: CreateInstanceInput) {
  return {
    enabled: true,
    url: input.webhookUrl,
    byEvents: false,
    base64: false,
    headers: { [WEBHOOK_SECRET_HEADER]: input.webhookSecret },
    events: [...WEBHOOK_EVENTS],
  };
}

export function createInstanceBody(input: CreateInstanceInput, rejectCalls: boolean) {
  return {
    instanceName: input.name,
    integration: BAILEYS_INTEGRATION,
    qrcode: false,
    ...instanceSettings(rejectCalls),
    webhook: webhookConfig(input),
  };
}

/** Text that replaces a `buttons` message: the text, one numbered line for each button, the footer. */
export function buttonsAsText(content: ButtonsContent): string {
  const lines = content.buttons.map((button, index) => `${index + 1}. ${button.title}`);
  const parts = [content.text, lines.join('\n')];
  if (content.footer) parts.push(content.footer);
  return parts.join('\n\n');
}

/** Text that replaces a `list` message: the text, then each section with numbered rows (one sequence). */
export function listAsText(content: ListContent): string {
  let index = 0;
  const sections = content.sections.map((section) => {
    const rows = section.rows.map((row) => {
      index += 1;
      return row.description
        ? `${index}. ${row.title} - ${row.description}`
        : `${index}. ${row.title}`;
    });
    return [`*${section.title}*`, ...rows].join('\n');
  });
  return [content.text, ...sections].join('\n\n');
}

export interface SendRequest {
  /** The route prefix under `/message`. */
  route: 'sendText' | 'sendMedia' | 'sendButtons' | 'sendList';
  body: Record<string, unknown>;
}

function fileNameFromUrl(url: string): string {
  const last = new URL(url).pathname.split('/').filter(Boolean).pop();
  return last ? decodeURIComponent(last) : 'file';
}

/** Builds the route and the body of one send. Evolution shows "composing" for `delay` ms before the send. */
export function sendRequest(input: SendMessageInput, fallback: InteractiveFallback): SendRequest {
  const common: Record<string, unknown> = { number: input.to };
  if (input.typingDelayMs && input.typingDelayMs > 0)
    common.delay = Math.round(input.typingDelayMs);
  // Evolution finds the quoted message by id in its `Message` table (`DATABASE_SAVE_DATA_NEW_MESSAGE=true`).
  if (input.quotedProviderMessageId) common.quoted = { key: { id: input.quotedProviderMessageId } };

  const { content } = input;
  switch (content.type) {
    case 'text':
      return { route: 'sendText', body: { ...common, text: content.text } };
    case 'media': {
      const body: Record<string, unknown> = {
        ...common,
        mediatype: content.media_type,
        media: content.url,
      };
      if (content.mime_type) body.mimetype = content.mime_type;
      if (content.caption) body.caption = content.caption;
      // Evolution reads the document name from the URL with a regular expression that fails on some URLs.
      if (content.file_name) body.fileName = content.file_name;
      else if (content.media_type === 'document') body.fileName = fileNameFromUrl(content.url);
      return { route: 'sendMedia', body };
    }
    case 'buttons':
      if (fallback === 'text')
        return { route: 'sendText', body: { ...common, text: buttonsAsText(content) } };
      return {
        route: 'sendButtons',
        body: {
          ...common,
          title: content.text,
          ...(content.footer ? { footer: content.footer } : {}),
          buttons: content.buttons.map((button) => ({
            type: 'reply',
            displayText: button.title,
            id: button.id,
          })),
        },
      };
    case 'list':
      if (fallback === 'text')
        return { route: 'sendText', body: { ...common, text: listAsText(content) } };
      return {
        route: 'sendList',
        body: {
          ...common,
          title: content.text,
          // `footerText` is required by the Evolution schema. An empty string is valid.
          footerText: '',
          buttonText: content.button_text,
          sections: content.sections.map((section) => ({
            title: section.title,
            rows: section.rows.map((row) => ({
              title: row.title,
              rowId: row.id,
              // A row `description` must not be empty in the Evolution schema.
              ...(row.description ? { description: row.description } : {}),
            })),
          })),
        },
      };
  }
}
