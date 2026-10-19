import { describe, expect, it } from 'vitest';
import { fitsMediaType, isAcceptedContentType } from './media-types';

describe('media types', () => {
  it('accepts only the WhatsApp file types', () => {
    expect(isAcceptedContentType('image/jpeg')).toBe(true);
    expect(isAcceptedContentType('application/pdf')).toBe(true);
    expect(isAcceptedContentType('text/html')).toBe(false);
    expect(isAcceptedContentType('image/svg+xml')).toBe(false);
  });

  it('checks that a file fits the media type of the message', () => {
    expect(fitsMediaType('image', 'image/png')).toBe(true);
    expect(fitsMediaType('image', 'video/mp4')).toBe(false);
    expect(fitsMediaType('audio', 'audio/ogg')).toBe(true);
    expect(fitsMediaType('document', 'image/png')).toBe(true);
    expect(fitsMediaType('document', 'text/html')).toBe(false);
  });
});
