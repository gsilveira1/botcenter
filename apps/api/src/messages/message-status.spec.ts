import { describe, expect, it } from 'vitest';
import { canMoveStatus, statusesBefore } from './message-status';

describe('canMoveStatus', () => {
  it('moves only forward: queued < sent < delivered < read', () => {
    expect(canMoveStatus('queued', 'sent')).toBe(true);
    expect(canMoveStatus('queued', 'delivered')).toBe(true);
    expect(canMoveStatus('sent', 'read')).toBe(true);
    expect(canMoveStatus('delivered', 'read')).toBe(true);
    expect(canMoveStatus('read', 'delivered')).toBe(false);
    expect(canMoveStatus('delivered', 'sent')).toBe(false);
    expect(canMoveStatus('sent', 'sent')).toBe(false);
  });

  it('allows failed only from queued or sent, and failed is final', () => {
    expect(canMoveStatus('queued', 'failed')).toBe(true);
    expect(canMoveStatus('sent', 'failed')).toBe(true);
    expect(canMoveStatus('delivered', 'failed')).toBe(false);
    expect(canMoveStatus('read', 'failed')).toBe(false);
    expect(canMoveStatus('failed', 'read')).toBe(false);
    expect(canMoveStatus('failed', 'failed')).toBe(false);
  });
});

describe('statusesBefore', () => {
  it('lists the statuses from which a move is valid', () => {
    expect(statusesBefore('sent')).toEqual(['queued']);
    expect(statusesBefore('delivered')).toEqual(['queued', 'sent']);
    expect(statusesBefore('read')).toEqual(['queued', 'sent', 'delivered']);
    expect(statusesBefore('failed')).toEqual(['queued', 'sent']);
    expect(statusesBefore('queued')).toEqual([]);
  });
});
