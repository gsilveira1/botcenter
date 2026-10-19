import type { MediaType } from '@botcenter/contracts';
import type { InboundContent } from '../types.js';

/**
 * Converts the Baileys `message` object of a `messages.upsert` webhook to `InboundContent`.
 * Returns `null` for a message that the Bot Center must ignore (reactions, poll votes, protocol messages).
 */

type Json = Record<string, unknown>;

/** Containers that hold the real message in `<wrapper>.message`. */
const WRAPPERS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
] as const;

/** Keys that are metadata, not content. Evolution adds `base64`, `mediaUrl`, and `speechToText`. */
const METADATA_KEYS = new Set([
  'messageContextInfo',
  'senderKeyDistributionMessage',
  'base64',
  'mediaUrl',
  'speechToText',
]);

/** Message types that are not a user message for a bot. */
const IGNORED_TYPES = new Set([
  'protocolMessage',
  'reactionMessage',
  'encReactionMessage',
  'pollUpdateMessage',
  'keepInChatMessage',
  'pinInChatMessage',
  'editedMessage',
]);

const MEDIA_TYPES: Record<string, { mediaType: MediaType; defaultMime: string }> = {
  imageMessage: { mediaType: 'image', defaultMime: 'image/jpeg' },
  stickerMessage: { mediaType: 'image', defaultMime: 'image/webp' },
  videoMessage: { mediaType: 'video', defaultMime: 'video/mp4' },
  ptvMessage: { mediaType: 'video', defaultMime: 'video/mp4' },
  audioMessage: { mediaType: 'audio', defaultMime: 'audio/ogg' },
  documentMessage: { mediaType: 'document', defaultMime: 'application/octet-stream' },
};

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function unwrap(message: Json): Json {
  let current = message;
  for (let depth = 0; depth < 5; depth += 1) {
    const wrapper = WRAPPERS.find((key) => isObject(current[key]));
    if (!wrapper) return current;
    const inner = (current[wrapper] as Json).message;
    if (!isObject(inner)) return current;
    current = inner;
  }
  return current;
}

function contentType(message: Json): string | undefined {
  return Object.keys(message).find((key) => !METADATA_KEYS.has(key) && message[key] != null);
}

function parseNativeFlowId(paramsJson: unknown): string | undefined {
  if (typeof paramsJson !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(paramsJson);
    return isObject(parsed) ? str(parsed.id) : undefined;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function mapReply(type: string, body: Json): InboundContent | undefined {
  switch (type) {
    case 'buttonsResponseMessage': {
      const id = str(body.selectedButtonId);
      return id
        ? { type: 'button_reply', buttonId: id, text: str(body.selectedDisplayText) ?? '' }
        : undefined;
    }
    case 'templateButtonReplyMessage': {
      const id = str(body.selectedId);
      return id
        ? { type: 'button_reply', buttonId: id, text: str(body.selectedDisplayText) ?? '' }
        : undefined;
    }
    case 'interactiveResponseMessage': {
      const flow = isObject(body.nativeFlowResponseMessage) ? body.nativeFlowResponseMessage : {};
      const id = parseNativeFlowId(flow.paramsJson);
      const text = isObject(body.body) ? (str(body.body.text) ?? '') : '';
      return id ? { type: 'button_reply', buttonId: id, text } : undefined;
    }
    case 'listResponseMessage': {
      const reply = isObject(body.singleSelectReply) ? body.singleSelectReply : {};
      const id = str(reply.selectedRowId);
      return id ? { type: 'list_reply', rowId: id, text: str(body.title) ?? '' } : undefined;
    }
    default:
      return undefined;
  }
}

export function mapInboundContent(rawMessage: Json | null | undefined): InboundContent | null {
  if (!rawMessage) return { type: 'unsupported', providerType: 'empty' };
  const message = unwrap(rawMessage);
  const type = contentType(message);
  if (!type) return { type: 'unsupported', providerType: 'empty' };
  if (IGNORED_TYPES.has(type)) return null;

  const body = message[type];
  if (type === 'conversation' && typeof body === 'string') return { type: 'text', text: body };
  if (!isObject(body)) return { type: 'unsupported', providerType: type };
  if (type === 'extendedTextMessage') return { type: 'text', text: str(body.text) ?? '' };

  const media = MEDIA_TYPES[type];
  if (media) {
    const content: InboundContent = {
      type: 'media',
      mediaType: media.mediaType,
      mimeType: str(body.mimetype)?.split(';')[0]?.trim() ?? media.defaultMime,
    };
    const caption = str(body.caption);
    const fileName = str(body.fileName);
    if (caption) content.caption = caption;
    if (fileName) content.fileName = fileName;
    return content;
  }

  return mapReply(type, body) ?? { type: 'unsupported', providerType: type };
}
