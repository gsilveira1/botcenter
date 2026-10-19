import { z } from 'zod';
import { BotDefinition } from './bot-definition.js';
import { BotId, IsoDateTime, Uuid } from './common.js';

export const BOT_INSTANCES_MAX = 100;

/** Route parameter of `PUT /v1/bots/{id}`. */
export const BotIdParam = z.object({ id: BotId });
export type BotIdParam = z.infer<typeof BotIdParam>;

/**
 * `PUT /v1/bots/{id}`: creates the bot or publishes a new version of its definition.
 * `instance_ids` is the full list of instances that the bot serves (an instance has at most one bot).
 * New conversations use the new version. Open conversations stay on their version.
 */
export const PutBotRequest = z
  .object({
    name: z
      .string()
      .max(100)
      .refine((value) => value.trim().length > 0, 'Must not be empty'),
    definition: BotDefinition,
    instance_ids: z.array(Uuid).max(BOT_INSTANCES_MAX),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.instance_ids.forEach((id, index) => {
      if (seen.has(id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['instance_ids', index],
          message: `Duplicate instance id "${id}"`,
        });
      }
      seen.add(id);
    });
  });
export type PutBotRequest = z.infer<typeof PutBotRequest>;
export type PutBotRequestInput = z.input<typeof PutBotRequest>;

export const BotResponse = z.object({
  id: BotId,
  name: z.string(),
  version: z.number().int().min(1),
  instance_ids: z.array(Uuid),
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
});
export type BotResponse = z.infer<typeof BotResponse>;
