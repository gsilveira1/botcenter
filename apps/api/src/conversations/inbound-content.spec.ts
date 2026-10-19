import { describe, expect, it } from 'vitest';
import type { InboundContent } from '@botcenter/whatsapp-provider';
import { eventContentFields, toEngineInput, toStoredContent } from './inbound-content';

const contents: InboundContent[] = [
  { type: 'text', text: 'Oi' },
  { type: 'button_reply', buttonId: 'b1', text: 'Sim' },
  { type: 'list_reply', rowId: 'r1', text: 'Linha' },
  { type: 'media', mediaType: 'image', mimeType: 'image/jpeg', caption: 'Foto', fileName: 'a.jpg' },
  { type: 'media', mediaType: 'audio', mimeType: 'audio/ogg' },
  { type: 'unsupported', providerType: 'stickerMessage' },
];

describe('inbound content', () => {
  it.each(contents)('stores %j and gives the same engine input back', (content) => {
    expect(toEngineInput(toStoredContent(content))).toEqual(content);
  });

  it('starts a media message as pending', () => {
    expect(toStoredContent(contents[3]!)).toMatchObject({ type: 'media', media_status: 'pending' });
  });

  it('gives the event fields: the text, the button or row id, and the caption of a media', () => {
    expect(contents.map((content) => eventContentFields(toStoredContent(content)))).toEqual([
      { type: 'text', text: 'Oi' },
      { type: 'button_reply', text: 'Sim', button_id: 'b1' },
      { type: 'list_reply', text: 'Linha', list_row_id: 'r1' },
      { type: 'media', text: 'Foto' },
      { type: 'media' },
      { type: 'unsupported' },
    ]);
  });
});
