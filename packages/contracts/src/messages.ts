import { z } from 'zod';
import { HttpsUrl, IsoDateTime, MaskedPhoneNumber, PhoneNumber, Uuid } from './common.js';

// WhatsApp limits. The API refuses larger values, so that the provider does not cut the text.
export const TEXT_MAX_LENGTH = 4096;
export const CAPTION_MAX_LENGTH = 1024;
export const FILE_NAME_MAX_LENGTH = 255;
export const BUTTONS_TEXT_MAX_LENGTH = 1024;
export const BUTTONS_MIN = 1;
export const BUTTONS_MAX = 3;
export const BUTTON_ID_MAX_LENGTH = 256;
export const BUTTON_TITLE_MAX_LENGTH = 20;
export const FOOTER_MAX_LENGTH = 60;
export const LIST_TEXT_MAX_LENGTH = 4096;
export const LIST_BUTTON_TEXT_MAX_LENGTH = 20;
export const LIST_SECTIONS_MAX = 10;
export const LIST_SECTION_TITLE_MAX_LENGTH = 24;
export const LIST_ROWS_MAX = 10;
export const LIST_ROW_ID_MAX_LENGTH = 200;
export const LIST_ROW_TITLE_MAX_LENGTH = 24;
export const LIST_ROW_DESCRIPTION_MAX_LENGTH = 72;
/** Maximum size of an uploaded media file: 16 MiB. */
export const MEDIA_MAX_BYTES = 16 * 1024 * 1024;

export const MESSAGE_TYPES = ['text', 'media', 'buttons', 'list'] as const;
export const MessageType = z.enum(MESSAGE_TYPES);
export type MessageType = z.infer<typeof MessageType>;

export const MEDIA_TYPES = ['image', 'video', 'audio', 'document'] as const;
export const MediaType = z.enum(MEDIA_TYPES);
export type MediaType = z.infer<typeof MediaType>;

export const MESSAGE_PRIORITIES = ['reply', 'bulk'] as const;
/** `reply` (an answer to a user message) goes before `bulk` in the outbound queue. */
export const MessagePriority = z.enum(MESSAGE_PRIORITIES);
export type MessagePriority = z.infer<typeof MessagePriority>;

export const MESSAGE_STATUSES = ['queued', 'sent', 'delivered', 'read', 'failed'] as const;
export const MessageStatus = z.enum(MESSAGE_STATUSES);
export type MessageStatus = z.infer<typeof MessageStatus>;

const nonBlank = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => value.trim().length > 0, 'Must not be empty');

// ---------------------------------------------------------------------------
// Message content. The bot definition (`send_message` action) uses the same shapes.
// ---------------------------------------------------------------------------

export const textContentShape = {
  type: z.literal('text'),
  text: nonBlank(TEXT_MAX_LENGTH),
};

export const mediaContentShape = {
  type: z.literal('media'),
  media_type: MediaType,
  /** A file from `POST /v1/media`. Send `media_id` or `url`, not the two. */
  media_id: Uuid.optional(),
  /** A public HTTPS file. Send `media_id` or `url`, not the two. */
  url: HttpsUrl.optional(),
  caption: z.string().max(CAPTION_MAX_LENGTH).optional(),
  file_name: nonBlank(FILE_NAME_MAX_LENGTH).optional(),
};

export const Button = z.object({
  id: nonBlank(BUTTON_ID_MAX_LENGTH),
  title: nonBlank(BUTTON_TITLE_MAX_LENGTH),
});
export type Button = z.infer<typeof Button>;

export const buttonsContentShape = {
  type: z.literal('buttons'),
  text: nonBlank(BUTTONS_TEXT_MAX_LENGTH),
  buttons: z.array(Button).min(BUTTONS_MIN).max(BUTTONS_MAX),
  footer: z.string().max(FOOTER_MAX_LENGTH).optional(),
};

export const ListRow = z.object({
  id: nonBlank(LIST_ROW_ID_MAX_LENGTH),
  title: nonBlank(LIST_ROW_TITLE_MAX_LENGTH),
  description: z.string().max(LIST_ROW_DESCRIPTION_MAX_LENGTH).optional(),
});
export type ListRow = z.infer<typeof ListRow>;

export const ListSection = z.object({
  title: nonBlank(LIST_SECTION_TITLE_MAX_LENGTH),
  rows: z.array(ListRow).min(1).max(LIST_ROWS_MAX),
});
export type ListSection = z.infer<typeof ListSection>;

export const listContentShape = {
  type: z.literal('list'),
  text: nonBlank(LIST_TEXT_MAX_LENGTH),
  button_text: nonBlank(LIST_BUTTON_TEXT_MAX_LENGTH),
  sections: z.array(ListSection).min(1).max(LIST_SECTIONS_MAX),
};

interface MediaSource {
  media_id?: string | undefined;
  url?: string | undefined;
}

/** Exactly one of `media_id` and `url`. */
function checkMediaSource(value: MediaSource, ctx: z.core.$RefinementCtx): void {
  if ((value.media_id === undefined) === (value.url === undefined)) {
    ctx.addIssue({
      code: 'custom',
      path: ['media_id'],
      message: 'Send exactly one of "media_id" and "url"',
    });
  }
}

/** Button ids are unique in one message. */
function checkButtons(value: { buttons: Button[] }, ctx: z.core.$RefinementCtx): void {
  const seen = new Set<string>();
  value.buttons.forEach((button, index) => {
    if (seen.has(button.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['buttons', index, 'id'],
        message: `Duplicate button id "${button.id}"`,
      });
    }
    seen.add(button.id);
  });
}

/** Row ids are unique in one message, and the message has at most 10 rows in all its sections. */
function checkList(value: { sections: ListSection[] }, ctx: z.core.$RefinementCtx): void {
  const seen = new Set<string>();
  let total = 0;
  value.sections.forEach((section, sectionIndex) => {
    section.rows.forEach((row, rowIndex) => {
      total += 1;
      if (seen.has(row.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['sections', sectionIndex, 'rows', rowIndex, 'id'],
          message: `Duplicate row id "${row.id}"`,
        });
      }
      seen.add(row.id);
    });
  });
  if (total > LIST_ROWS_MAX) {
    ctx.addIssue({
      code: 'custom',
      path: ['sections'],
      message: `A list has at most ${LIST_ROWS_MAX} rows in all its sections`,
    });
  }
}

export const TextContent = z.object(textContentShape);
export const MediaContent = z.object(mediaContentShape).superRefine(checkMediaSource);
export const ButtonsContent = z.object(buttonsContentShape).superRefine(checkButtons);
export const ListContent = z.object(listContentShape).superRefine(checkList);

/** Content of a message, without the delivery fields. */
export const MessageContent = z.discriminatedUnion('type', [
  TextContent,
  MediaContent,
  ButtonsContent,
  ListContent,
]);
export type MessageContent = z.infer<typeof MessageContent>;

/**
 * Same content as `MessageContent`, but an unknown key is an error.
 * The bot definition uses it, so that a typo in a stored definition does not drop a field.
 */
export const StrictMessageContent = z.discriminatedUnion('type', [
  z.strictObject(textContentShape),
  z.strictObject(mediaContentShape).superRefine(checkMediaSource),
  z.strictObject(buttonsContentShape).superRefine(checkButtons),
  z.strictObject(listContentShape).superRefine(checkList),
]);
export type TextContent = z.infer<typeof TextContent>;
export type MediaContent = z.infer<typeof MediaContent>;
export type ButtonsContent = z.infer<typeof ButtonsContent>;
export type ListContent = z.infer<typeof ListContent>;

// ---------------------------------------------------------------------------
// Send a message: `POST /v1/messages` (202 with a `MessageResponse`).
// ---------------------------------------------------------------------------

const deliveryShape = {
  instance_id: Uuid,
  to: PhoneNumber,
  priority: MessagePriority.default('bulk'),
};

export const SendMessageRequest = z.discriminatedUnion('type', [
  z.object({ ...deliveryShape, ...textContentShape }),
  z.object({ ...deliveryShape, ...mediaContentShape }).superRefine(checkMediaSource),
  z.object({ ...deliveryShape, ...buttonsContentShape }).superRefine(checkButtons),
  z.object({ ...deliveryShape, ...listContentShape }).superRefine(checkList),
]);
export type SendMessageRequest = z.infer<typeof SendMessageRequest>;
export type SendMessageRequestInput = z.input<typeof SendMessageRequest>;

/** Response of `POST /v1/messages` (202) and `GET /v1/messages/{id}`. */
export const MessageResponse = z.object({
  id: Uuid,
  instance_id: Uuid,
  to_masked: MaskedPhoneNumber,
  type: MessageType,
  status: MessageStatus,
  failure_reason: z.string().nullable(),
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
});
export type MessageResponse = z.infer<typeof MessageResponse>;

// ---------------------------------------------------------------------------
// Media upload: `POST /v1/media`. The client sends the bytes with
// `PUT upload_url` and the same `Content-Type`, then uses `media_id` in a message.
// ---------------------------------------------------------------------------

export const ContentType = z
  .string()
  .max(127)
  .regex(/^[a-z]+\/[a-z0-9][a-z0-9.+-]*$/, 'Must be a MIME type without parameters');

export const CreateMediaUploadRequest = z.object({
  content_type: ContentType,
  size_bytes: z.number().int().min(1).max(MEDIA_MAX_BYTES),
  file_name: nonBlank(FILE_NAME_MAX_LENGTH),
});
export type CreateMediaUploadRequest = z.infer<typeof CreateMediaUploadRequest>;

export const CreateMediaUploadResponse = z.object({
  media_id: Uuid,
  upload_url: z.url(),
  expires_at: IsoDateTime,
});
export type CreateMediaUploadResponse = z.infer<typeof CreateMediaUploadResponse>;
