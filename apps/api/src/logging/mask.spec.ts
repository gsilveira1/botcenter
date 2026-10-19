import { describe, expect, it } from 'vitest';
import { MaskedPhoneNumber } from '@botcenter/contracts';
import { maskPhone } from './mask';

describe('maskPhone', () => {
  it('keeps the first 4 and the last 4 digits', () => {
    expect(maskPhone('5511987654321')).toBe('5511*****4321');
    expect(maskPhone('+55 (11) 98765-4321')).toBe('5511*****4321');
    expect(maskPhone('1234567890')).toBe('1234**7890');
  });

  it('gives a value that matches the contracts MaskedPhoneNumber', () => {
    for (const phone of ['5511987654321', '1234567890', '123456789012345']) {
      expect(MaskedPhoneNumber.safeParse(maskPhone(phone)).success).toBe(true);
    }
  });

  it('masks short and empty values without a leak', () => {
    expect(maskPhone('12345')).toBe('***45');
    expect(maskPhone('12')).toBe('**');
    expect(maskPhone(undefined)).toBe('*');
  });
});
