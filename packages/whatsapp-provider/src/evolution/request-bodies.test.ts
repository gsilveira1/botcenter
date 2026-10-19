import { describe, expect, it } from 'vitest';
import { maskDigits } from '../logger.js';
import { jidKind, phoneFromJid, phoneToJid } from './jid.js';
import { buttonsAsText, listAsText, sendRequest } from './request-bodies.js';

describe('text fallback of interactive content', () => {
  it('writes buttons as a numbered menu with the footer last', () => {
    expect(
      buttonsAsText({
        type: 'buttons',
        text: 'Qual plano?',
        footer: 'Responda com o número',
        buttons: [
          { id: 'm', title: 'Mensal' },
          { id: 't', title: 'Trimestral' },
          { id: 'a', title: 'Anual' },
        ],
      }),
    ).toBe('Qual plano?\n\n1. Mensal\n2. Trimestral\n3. Anual\n\nResponda com o número');
  });

  it('writes a list with one number sequence over all sections', () => {
    expect(
      listAsText({
        type: 'list',
        text: 'Escolha um horário',
        button_text: 'Horários',
        sections: [
          {
            title: 'Segunda',
            rows: [
              { id: 'a', title: '7h', description: 'Funcional' },
              { id: 'b', title: '8h' },
            ],
          },
          { title: 'Terça', rows: [{ id: 'c', title: '7h' }] },
        ],
      }),
    ).toBe('Escolha um horário\n\n*Segunda*\n1. 7h - Funcional\n2. 8h\n\n*Terça*\n3. 7h');
  });
});

describe('sendRequest', () => {
  const list = {
    type: 'list' as const,
    text: 'Escolha',
    button_text: 'Ver',
    sections: [
      {
        title: 'Seg',
        rows: [
          { id: 'r1', title: '7h' },
          { id: 'r2', title: '8h', description: 'Livre' },
        ],
      },
    ],
  };

  it('builds a native list with an empty footer and no empty row description', () => {
    expect(sendRequest({ to: '5511987654321', content: list }, 'native')).toEqual({
      route: 'sendList',
      body: {
        number: '5511987654321',
        title: 'Escolha',
        footerText: '',
        buttonText: 'Ver',
        sections: [
          {
            title: 'Seg',
            rows: [
              { title: '7h', rowId: 'r1' },
              { title: '8h', rowId: 'r2', description: 'Livre' },
            ],
          },
        ],
      },
    });
  });

  it('builds native buttons with the footer', () => {
    expect(
      sendRequest(
        {
          to: '5511987654321',
          content: {
            type: 'buttons',
            text: 'Plano?',
            footer: 'Rodapé',
            buttons: [{ id: 'm', title: 'Mensal' }],
          },
        },
        'native',
      ).body,
    ).toEqual({
      number: '5511987654321',
      title: 'Plano?',
      footer: 'Rodapé',
      buttons: [{ type: 'reply', displayText: 'Mensal', id: 'm' }],
    });
  });

  it('sends a list as text with the fallback', () => {
    expect(sendRequest({ to: '1', content: list }, 'text').route).toBe('sendText');
  });

  it('omits a zero typing delay', () => {
    expect(
      sendRequest({ to: '1', content: { type: 'text', text: 'x' }, typingDelayMs: 0 }, 'text').body,
    ).toEqual({
      number: '1',
      text: 'x',
    });
  });

  it('keeps the file name of a document and builds one from the URL when it is missing', () => {
    const media = (fileName?: string) =>
      sendRequest(
        {
          to: '1',
          content: {
            type: 'media',
            media_type: 'document',
            url: 'https://cdn.example.com/',
            ...(fileName ? { file_name: fileName } : {}),
          },
        },
        'text',
      ).body;
    expect(media('a.pdf')).toMatchObject({ fileName: 'a.pdf' });
    expect(media()).toMatchObject({ fileName: 'file' });
  });

  it('does not add a file name to an image', () => {
    const body = sendRequest(
      {
        to: '1',
        content: { type: 'media', media_type: 'image', url: 'https://cdn.example.com/x.jpg' },
      },
      'text',
    ).body;
    expect(body).toEqual({
      number: '1',
      mediatype: 'image',
      media: 'https://cdn.example.com/x.jpg',
    });
  });
});

describe('JID helpers and masks', () => {
  it.each([
    ['5511987654321@s.whatsapp.net', 'phone', '5511987654321'],
    ['5511987654321:12@s.whatsapp.net', 'phone', '5511987654321'],
    ['128793450123456@lid', 'lid', undefined],
    ['120363025246125486@g.us', 'group', undefined],
    ['status@broadcast', 'broadcast', undefined],
    ['120363000000000000@newsletter', 'newsletter', undefined],
    ['x@unknown', 'other', undefined],
  ])('%s', (jid, kind, phone) => {
    expect(jidKind(jid)).toBe(kind);
    expect(phoneFromJid(jid)).toBe(phone);
  });

  it('builds a phone JID and masks long digit runs', () => {
    expect(phoneToJid('5511987654321')).toBe('5511987654321@s.whatsapp.net');
    expect(phoneFromJid(null)).toBeUndefined();
    expect(maskDigits('to 5511987654321 at 12:30')).toBe('to 5511*****4321 at 12:30');
  });
});
