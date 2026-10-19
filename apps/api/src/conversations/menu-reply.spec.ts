import { describe, expect, it } from 'vitest';
import type { EngineAction } from '@botcenter/engine';
import { mapMenuReply, menuAfterActions, parseLastMenu } from './menu-reply';
import type { LastMenu } from './menu-reply';

const buttons: LastMenu = {
  kind: 'buttons',
  options: [
    { id: 'comecar', title: 'Começar' },
    { id: 'falar_personal', title: 'Falar com o personal' },
  ],
};

const list: LastMenu = {
  kind: 'list',
  options: [
    { id: 'emagrecimento', title: 'Emagrecer' },
    { id: 'saude', title: 'Saúde e bem-estar' },
  ],
};

describe('mapMenuReply', () => {
  it.each([
    ['1', 'comecar', 'Começar'],
    [' 2 ', 'falar_personal', 'Falar com o personal'],
    ['2.', 'falar_personal', 'Falar com o personal'],
    ['1)', 'comecar', 'Começar'],
    ['COMECAR', 'comecar', 'Começar'],
    ['falar  com o PERSONAL', 'falar_personal', 'Falar com o personal'],
  ])('maps "%s" to the button %s', (text, buttonId, title) => {
    expect(mapMenuReply({ type: 'text', text }, buttons)).toEqual({
      type: 'button_reply',
      buttonId,
      text: title,
    });
  });

  it('maps a number or a title of a list to a list reply (accents do not count)', () => {
    expect(mapMenuReply({ type: 'text', text: '2' }, list)).toEqual({
      type: 'list_reply',
      rowId: 'saude',
      text: 'Saúde e bem-estar',
    });
    expect(mapMenuReply({ type: 'text', text: 'saude e bem estar' }, list)).toMatchObject({
      type: 'text',
    });
    expect(mapMenuReply({ type: 'text', text: 'saude e bem-estar' }, list)).toMatchObject({
      rowId: 'saude',
    });
  });

  it('keeps the input for a number out of range, another text, no menu, or another type', () => {
    expect(mapMenuReply({ type: 'text', text: '3' }, buttons)).toEqual({ type: 'text', text: '3' });
    expect(mapMenuReply({ type: 'text', text: '0' }, buttons)).toEqual({ type: 'text', text: '0' });
    expect(mapMenuReply({ type: 'text', text: 'talvez' }, buttons)).toEqual({
      type: 'text',
      text: 'talvez',
    });
    expect(mapMenuReply({ type: 'text', text: '1' }, null)).toEqual({ type: 'text', text: '1' });
    const reply = { type: 'button_reply' as const, buttonId: 'x', text: 'X' };
    expect(mapMenuReply(reply, buttons)).toBe(reply);
  });
});

describe('menuAfterActions', () => {
  const send = (message: unknown): EngineAction =>
    ({ type: 'send_message', message }) as EngineAction;

  it('keeps the menu of the last message that the step sends', () => {
    const actions = [
      send({ type: 'text', text: 'Oi' }),
      send({
        type: 'list',
        text: 'Escolha',
        button_text: 'Ver',
        sections: [
          { title: 'A', rows: [{ id: 'r1', title: 'Um' }] },
          { title: 'B', rows: [{ id: 'r2', title: 'Dois' }] },
        ],
      }),
    ];
    expect(menuAfterActions(actions, null)).toEqual({
      kind: 'list',
      options: [
        { id: 'r1', title: 'Um' },
        { id: 'r2', title: 'Dois' },
      ],
    });
  });

  it('clears the menu after a text message and keeps it after a step without a message', () => {
    expect(menuAfterActions([send({ type: 'text', text: 'Oi' })], buttons)).toBeNull();
    expect(menuAfterActions([{ type: 'handoff' }], buttons)).toBe(buttons);
  });
});

describe('parseLastMenu', () => {
  it('reads a stored menu and refuses other values', () => {
    expect(parseLastMenu(buttons)).toEqual(buttons);
    expect(parseLastMenu(null)).toBeNull();
    expect(parseLastMenu({ kind: 'buttons', options: [] })).toBeNull();
    expect(parseLastMenu({ nome: 'x' })).toBeNull();
  });
});
