import type { MediaType } from '@botcenter/contracts';

/**
 * The file types that WhatsApp accepts for each media type. `POST /v1/media` refuses any other type, so a
 * signed URL never serves an active type (for example `text/html` or `image/svg+xml`).
 * A `document` can be any accepted type: WhatsApp sends every file as a document.
 */
export const MEDIA_CONTENT_TYPES: Readonly<Record<MediaType, readonly string[]>> = {
  image: ['image/jpeg', 'image/png', 'image/webp'],
  video: ['video/mp4', 'video/3gpp'],
  audio: ['audio/aac', 'audio/mp4', 'audio/mpeg', 'audio/amr', 'audio/ogg'],
  document: [
    'application/pdf',
    'text/plain',
    'text/csv',
    'application/zip',
    'application/msword',
    'application/vnd.ms-excel',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ],
};

const ALL_TYPES: ReadonlySet<string> = new Set(Object.values(MEDIA_CONTENT_TYPES).flat());

export function isAcceptedContentType(contentType: string): boolean {
  return ALL_TYPES.has(contentType);
}

/** True when a file of `contentType` can go out as `mediaType`. */
export function fitsMediaType(mediaType: MediaType, contentType: string): boolean {
  if (mediaType === 'document') {
    return ALL_TYPES.has(contentType);
  }
  return MEDIA_CONTENT_TYPES[mediaType].includes(contentType);
}
