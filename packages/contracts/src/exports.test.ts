import { describe, expect, it } from 'vitest';
import * as contracts from './index.js';

describe('package index', () => {
  it('exports the main schemas and helpers', () => {
    for (const name of [
      'Scope',
      'ErrorCode',
      'ProblemDetails',
      'CursorQuery',
      'CreateInstanceRequest',
      'ConnectEvent',
      'SendMessageRequest',
      'CreateMediaUploadRequest',
      'BotDefinition',
      'PutBotRequest',
      'ConversationResponse',
      'CreateWebhookRequest',
      'WebhookEvent',
      'signWebhook',
      'verifyWebhook',
    ]) {
      expect(contracts, name).toHaveProperty(name);
    }
  });
});
