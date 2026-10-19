import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { BotsController } from '../bots/bots.controller';
import { BotsService } from '../bots/bots.service';
import { buildOpenApiDocument } from '../openapi/openapi.document';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';

// The document is plain JSON; the test reads nested fields without a schema.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

describe('OpenAPI entries of the conversations slice', () => {
  it('documents the bot and conversation routes with the bots:write scope', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [BotsController, ConversationsController],
      providers: [
        { provide: BotsService, useValue: {} },
        { provide: ConversationsService, useValue: {} },
      ],
    }).compile();
    const doc = buildOpenApiDocument(moduleRef) as Doc;
    await moduleRef.close();

    expect(Object.keys(doc['paths']).sort()).toEqual([
      '/v1/bots/{id}',
      '/v1/conversations/{id}',
      '/v1/conversations/{id}/handoff',
    ]);
    const put = doc['paths']['/v1/bots/{id}']['put'];
    expect(put['x-required-scopes']).toEqual(['bots:write']);
    expect(Object.keys(put['responses'])).toEqual(expect.arrayContaining(['200', '422']));
    // The body shows the full bot definition schema, although the pipe leaves it to the service.
    const body = doc['components']['schemas']['PutBotBody'];
    expect(body['properties']['definition']['properties']).toHaveProperty('states');
    expect(
      doc['paths']['/v1/conversations/{id}/handoff']['post']['responses']['200'],
    ).toBeDefined();
    expect(doc['components']['schemas']['ConversationResponseDto']).toBeDefined();
  });
});
