import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { MediaController } from '../media/media.controller';
import { buildOpenApiDocument } from '../openapi/openapi.document';
import { MessagesController } from './messages.controller';

describe('OpenAPI entries of the messages slice', () => {
  it('documents the three routes, their scope, and the at-least-once delivery', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [MessagesController, MediaController],
    })
      .useMocker(() => ({}))
      .compile();
    await moduleRef.init();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doc = buildOpenApiDocument(moduleRef) as Record<string, any>;
    await moduleRef.close();

    const send = doc['paths']['/v1/messages'].post;
    expect(send['x-required-scopes']).toEqual(['messages:send']);
    expect(Object.keys(send.responses)).toContain('202');
    expect(send.description).toContain('at least once');
    expect(send.requestBody.content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/SendMessageBody',
    });
    expect(
      doc['components'].schemas.SendMessageBody.oneOf ??
        doc['components'].schemas.SendMessageBody.anyOf,
    ).toHaveLength(4);
    expect(doc['paths']['/v1/messages/{id}'].get.responses['200']).toBeDefined();
    const media = doc['paths']['/v1/media'].post;
    expect(media.responses['201'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/CreateMediaUploadResponseDto',
    });
  });
});
