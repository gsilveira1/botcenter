import type { MediaType, MessageReceivedData } from '@botcenter/contracts';
import type { InboundInput } from '@botcenter/engine';
import type { InboundContent } from '@botcenter/whatsapp-provider';

/**
 * Result of the media step of an inbound media message:
 * - `pending`: the worker did not store the file yet (the `message.received` event is not written);
 * - `stored`: the file is in the media bucket (`media_id`);
 * - `failed`: the download or the upload failed; the event went out without media;
 * - `too_large`: the file is larger than `MEDIA_MAX_BYTES`; the event went out without media.
 */
export type InboundMediaStatus = 'pending' | 'stored' | 'failed' | 'too_large';

/** The `content` JSON of an inbound `messages` row (snake case, like the public API). */
export type StoredInboundContent =
  | { type: 'text'; text: string }
  | { type: 'button_reply'; button_id: string; text: string }
  | { type: 'list_reply'; list_row_id: string; text: string }
  | {
      type: 'media';
      media_type: MediaType;
      mime_type: string;
      caption?: string;
      file_name?: string;
      media_status: InboundMediaStatus;
      media_id?: string;
    }
  | { type: 'unsupported'; provider_type: string };

/** The stored content of a normalized provider message. A media message starts as `pending`. */
export function toStoredContent(content: InboundContent): StoredInboundContent {
  switch (content.type) {
    case 'text':
      return { type: 'text', text: content.text };
    case 'button_reply':
      return { type: 'button_reply', button_id: content.buttonId, text: content.text };
    case 'list_reply':
      return { type: 'list_reply', list_row_id: content.rowId, text: content.text };
    case 'media':
      return {
        type: 'media',
        media_type: content.mediaType,
        mime_type: content.mimeType,
        ...(content.caption === undefined ? {} : { caption: content.caption }),
        ...(content.fileName === undefined ? {} : { file_name: content.fileName }),
        media_status: 'pending',
      };
    case 'unsupported':
      return { type: 'unsupported', provider_type: content.providerType };
  }
}

/** The engine input of a stored inbound row (the drain reads the rows, not the job payload). */
export function toEngineInput(content: StoredInboundContent): InboundInput {
  switch (content.type) {
    case 'text':
      return { type: 'text', text: content.text };
    case 'button_reply':
      return { type: 'button_reply', buttonId: content.button_id, text: content.text };
    case 'list_reply':
      return { type: 'list_reply', rowId: content.list_row_id, text: content.text };
    case 'media':
      return {
        type: 'media',
        mediaType: content.media_type,
        mimeType: content.mime_type,
        ...(content.caption === undefined ? {} : { caption: content.caption }),
        ...(content.file_name === undefined ? {} : { fileName: content.file_name }),
      };
    case 'unsupported':
      return { type: 'unsupported', providerType: content.provider_type };
  }
}

type EventContentFields = Pick<MessageReceivedData, 'type' | 'text' | 'button_id' | 'list_row_id'>;

/** The content fields of a `message.received` event. The `text` of a media message is its caption. */
export function eventContentFields(content: StoredInboundContent): EventContentFields {
  switch (content.type) {
    case 'text':
      return { type: 'text', text: content.text };
    case 'button_reply':
      return { type: 'button_reply', text: content.text, button_id: content.button_id };
    case 'list_reply':
      return { type: 'list_reply', text: content.text, list_row_id: content.list_row_id };
    case 'media':
      return content.caption === undefined
        ? { type: 'media' }
        : { type: 'media', text: content.caption };
    case 'unsupported':
      return { type: 'unsupported' };
  }
}
