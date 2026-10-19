import { describe, expect, it } from 'vitest';
import { looseText, messageText, strictText } from './text.js';

describe('messageText', () => {
  it('trims the text and makes it NFC', () => {
    // "não" with a combining tilde (NFD) becomes the composed form.
    expect(messageText({ type: 'text', text: '  não \n' })).toBe('não');
  });

  it('uses the title of a button reply and of a list reply', () => {
    expect(messageText({ type: 'button_reply', buttonId: 'yes', text: ' Sim ' })).toBe('Sim');
    expect(messageText({ type: 'list_reply', rowId: 'r1', text: 'Emagrecer' })).toBe('Emagrecer');
  });

  it('uses the caption of a media message, or null without a caption', () => {
    const media = { type: 'media', mediaType: 'image', mimeType: 'image/jpeg' } as const;
    expect(messageText({ ...media, caption: ' minha foto ' })).toBe('minha foto');
    expect(messageText(media)).toBeNull();
  });

  it('gives null for an unsupported message', () => {
    expect(messageText({ type: 'unsupported', providerType: 'stickerMessage' })).toBeNull();
  });
});

describe('looseText', () => {
  it('ignores case, accents, and extra white space', () => {
    expect(looseText('  NÃO   Sei ')).toBe('nao sei');
    expect(looseText('nao sei')).toBe('nao sei');
    expect(looseText('Começar')).toBe(looseText('comecar'));
  });

  it('gives the same form for NFC and NFD input', () => {
    expect(looseText('é')).toBe(looseText('é'));
  });
});

describe('strictText', () => {
  it('keeps case and accents', () => {
    expect(strictText(' Não ')).toBe('Não');
    expect(strictText('Não')).not.toBe(strictText('nao'));
  });
});
