import { describe, expect, it } from 'vitest';
import {
  CreateMediaUploadRequest,
  CreateMediaUploadResponse,
  MEDIA_MAX_BYTES,
  MessageContent,
  MessageResponse,
  SendMessageRequest,
  StrictMessageContent,
} from './messages.js';

const ID = '01928f3e-8a3b-7c4d-9e5f-0123456789ab';
const NOW = '2026-10-19T12:00:00.000Z';
const delivery = { instance_id: ID, to: '5511987654321' };

describe('SendMessageRequest: text', () => {
  it('accepts a text and sets the default priority', () => {
    expect(SendMessageRequest.parse({ ...delivery, type: 'text', text: 'Oi' })).toEqual({
      ...delivery,
      type: 'text',
      text: 'Oi',
      priority: 'bulk',
    });
  });

  it('accepts the reply priority', () => {
    expect(
      SendMessageRequest.parse({ ...delivery, type: 'text', text: 'Oi', priority: 'reply' })
        .priority,
    ).toBe('reply');
  });

  it.each([
    [{ ...delivery, type: 'text', text: '' }],
    [{ ...delivery, type: 'text', text: '   ' }],
    [{ ...delivery, type: 'text', text: 'x'.repeat(4097) }],
    [{ ...delivery, type: 'text', text: 'Oi', priority: 'urgent' }],
    [{ ...delivery, to: '+5511987654321', type: 'text', text: 'Oi' }],
    [{ ...delivery, to: '123', type: 'text', text: 'Oi' }],
    [{ ...delivery, instance_id: 'abc', type: 'text', text: 'Oi' }],
    [{ to: '5511987654321', type: 'text', text: 'Oi' }],
    [{ ...delivery, type: 'sticker' }],
  ])('refuses %j', (input) => {
    expect(SendMessageRequest.safeParse(input).success).toBe(false);
  });

  it('accepts a text of 4096 characters', () => {
    expect(
      SendMessageRequest.safeParse({ ...delivery, type: 'text', text: 'x'.repeat(4096) }).success,
    ).toBe(true);
  });
});

describe('SendMessageRequest: media', () => {
  it('accepts a media id', () => {
    expect(
      SendMessageRequest.safeParse({
        ...delivery,
        type: 'media',
        media_type: 'image',
        media_id: ID,
        caption: 'Treino',
      }).success,
    ).toBe(true);
  });

  it('accepts an HTTPS URL', () => {
    expect(
      SendMessageRequest.safeParse({
        ...delivery,
        type: 'media',
        media_type: 'document',
        url: 'https://cdn.example.com/plan.pdf',
        file_name: 'plan.pdf',
      }).success,
    ).toBe(true);
  });

  it('refuses a media id and a URL together', () => {
    const result = SendMessageRequest.safeParse({
      ...delivery,
      type: 'media',
      media_type: 'image',
      media_id: ID,
      url: 'https://cdn.example.com/a.png',
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['media_id']);
  });

  it('refuses a media without a source', () => {
    expect(
      SendMessageRequest.safeParse({ ...delivery, type: 'media', media_type: 'image' }).success,
    ).toBe(false);
  });

  it('refuses an HTTP URL', () => {
    expect(
      SendMessageRequest.safeParse({
        ...delivery,
        type: 'media',
        media_type: 'image',
        url: 'http://cdn.example.com/a.png',
      }).success,
    ).toBe(false);
  });

  it('refuses an unknown media type', () => {
    expect(
      SendMessageRequest.safeParse({ ...delivery, type: 'media', media_type: 'gif', media_id: ID })
        .success,
    ).toBe(false);
  });

  it('refuses a caption longer than 1024 characters', () => {
    expect(
      SendMessageRequest.safeParse({
        ...delivery,
        type: 'media',
        media_type: 'image',
        media_id: ID,
        caption: 'x'.repeat(1025),
      }).success,
    ).toBe(false);
  });
});

describe('SendMessageRequest: buttons', () => {
  const buttons = {
    ...delivery,
    type: 'buttons',
    text: 'Confirma?',
    buttons: [
      { id: 'yes', title: 'Sim' },
      { id: 'no', title: 'Não' },
    ],
    footer: 'PersonalLife',
  };

  it('accepts two buttons', () => {
    expect(SendMessageRequest.safeParse(buttons).success).toBe(true);
  });

  it('refuses no button', () => {
    expect(SendMessageRequest.safeParse({ ...buttons, buttons: [] }).success).toBe(false);
  });

  it('refuses four buttons', () => {
    const four = [1, 2, 3, 4].map((n) => ({ id: `b${n}`, title: `B${n}` }));
    expect(SendMessageRequest.safeParse({ ...buttons, buttons: four }).success).toBe(false);
  });

  it('refuses a title longer than 20 characters', () => {
    expect(
      SendMessageRequest.safeParse({ ...buttons, buttons: [{ id: 'a', title: 'x'.repeat(21) }] })
        .success,
    ).toBe(false);
  });

  it('refuses duplicate button ids with the path of the duplicate', () => {
    const result = SendMessageRequest.safeParse({
      ...buttons,
      buttons: [
        { id: 'a', title: 'A' },
        { id: 'a', title: 'B' },
      ],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['buttons', 1, 'id']);
  });
});

describe('SendMessageRequest: list', () => {
  const list = {
    ...delivery,
    type: 'list',
    text: 'Escolha um horário',
    button_text: 'Horários',
    sections: [
      {
        title: 'Manhã',
        rows: [
          { id: 'h8', title: '08:00' },
          { id: 'h9', title: '09:00', description: 'Academia central' },
        ],
      },
    ],
  };

  it('accepts a list', () => {
    expect(SendMessageRequest.safeParse(list).success).toBe(true);
  });

  it('refuses a section without rows', () => {
    expect(
      SendMessageRequest.safeParse({ ...list, sections: [{ title: 'Vazio', rows: [] }] }).success,
    ).toBe(false);
  });

  it('refuses more than 10 rows in all the sections', () => {
    const rows = (prefix: string) =>
      Array.from({ length: 6 }, (_, n) => ({ id: `${prefix}${n}`, title: `${prefix}${n}` }));
    const result = SendMessageRequest.safeParse({
      ...list,
      sections: [
        { title: 'A', rows: rows('a') },
        { title: 'B', rows: rows('b') },
      ],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['sections']);
  });

  it('refuses duplicate row ids across sections', () => {
    const result = SendMessageRequest.safeParse({
      ...list,
      sections: [
        { title: 'A', rows: [{ id: 'x', title: 'X' }] },
        { title: 'B', rows: [{ id: 'x', title: 'Y' }] },
      ],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['sections', 1, 'rows', 0, 'id']);
  });

  it('refuses a missing button text', () => {
    const { button_text: _b, ...withoutButton } = list;
    expect(SendMessageRequest.safeParse(withoutButton).success).toBe(false);
  });
});

describe('MessageContent and StrictMessageContent', () => {
  it('MessageContent drops an unknown key', () => {
    expect(MessageContent.parse({ type: 'text', text: 'Oi', extra: 1 })).toEqual({
      type: 'text',
      text: 'Oi',
    });
  });

  it('StrictMessageContent refuses an unknown key', () => {
    expect(StrictMessageContent.safeParse({ type: 'text', text: 'Oi', extra: 1 }).success).toBe(
      false,
    );
  });

  it('StrictMessageContent keeps the media source rule', () => {
    expect(StrictMessageContent.safeParse({ type: 'media', media_type: 'audio' }).success).toBe(
      false,
    );
  });

  it('content has no delivery fields', () => {
    expect(
      StrictMessageContent.safeParse({ type: 'text', text: 'Oi', to: '5511987654321' }).success,
    ).toBe(false);
  });
});

describe('MessageResponse', () => {
  const valid = {
    id: ID,
    instance_id: ID,
    to_masked: '5511*****4321',
    type: 'text',
    status: 'queued',
    failure_reason: null,
    created_at: NOW,
    updated_at: NOW,
  };

  it('accepts a queued message', () => {
    expect(MessageResponse.safeParse(valid).success).toBe(true);
  });

  it('accepts a failed message with a reason', () => {
    expect(
      MessageResponse.safeParse({ ...valid, status: 'failed', failure_reason: 'not_on_whatsapp' })
        .success,
    ).toBe(true);
  });

  it('refuses an unknown status', () => {
    expect(MessageResponse.safeParse({ ...valid, status: 'pending' }).success).toBe(false);
  });
});

describe('media upload', () => {
  it('accepts a file of 16 MiB', () => {
    expect(
      CreateMediaUploadRequest.safeParse({
        content_type: 'image/jpeg',
        size_bytes: MEDIA_MAX_BYTES,
        file_name: 'photo.jpg',
      }).success,
    ).toBe(true);
  });

  it.each([
    [{ content_type: 'image/jpeg', size_bytes: MEDIA_MAX_BYTES + 1, file_name: 'a.jpg' }],
    [{ content_type: 'image/jpeg', size_bytes: 0, file_name: 'a.jpg' }],
    [{ content_type: 'image/jpeg; charset=x', size_bytes: 10, file_name: 'a.jpg' }],
    [{ content_type: 'jpeg', size_bytes: 10, file_name: 'a.jpg' }],
    [{ content_type: 'image/jpeg', size_bytes: 10, file_name: '' }],
  ])('refuses %j', (input) => {
    expect(CreateMediaUploadRequest.safeParse(input).success).toBe(false);
  });

  it('accepts an upload response', () => {
    expect(
      CreateMediaUploadResponse.safeParse({
        media_id: ID,
        upload_url: 'https://bucket.example.com/key?X-Amz-Signature=abc',
        expires_at: NOW,
      }).success,
    ).toBe(true);
  });
});
