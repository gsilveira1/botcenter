import type { InboundContent } from '@botcenter/whatsapp-provider';
import { describe, expectTypeOf, it } from 'vitest';
import type { InboundInput } from './types.js';

describe('InboundInput', () => {
  it('has the same shape as InboundContent of the provider (checked by the typecheck)', () => {
    expectTypeOf<InboundContent>().toExtend<InboundInput>();
    expectTypeOf<InboundInput>().toExtend<InboundContent>();
  });
});
