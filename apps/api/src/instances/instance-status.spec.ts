import { INSTANCE_STATUSES } from '@botcenter/contracts';
import { describe, expect, it } from 'vitest';
import {
  isIncidentStatus,
  isStreamFinalStatus,
  planTransition,
  statusFromProvider,
} from './instance-status';

const NOW = new Date('2026-10-19T12:00:00.000Z');
const EARLIER = new Date('2026-10-19T11:50:00.000Z');

describe('statusFromProvider', () => {
  it.each([
    ['connected', 'connected'],
    ['connecting', 'connecting'],
    ['disconnected', 'disconnected'],
    ['logged_out', 'logged_out'],
  ] as const)('maps the provider state %s to the status %s', (state, status) => {
    expect(statusFromProvider(state)).toBe(status);
    expect(INSTANCE_STATUSES).toContain(statusFromProvider(state));
  });
});

describe('status groups', () => {
  it('treats connecting and disconnected as incident statuses', () => {
    expect(INSTANCE_STATUSES.filter(isIncidentStatus)).toEqual(['connecting', 'disconnected']);
  });

  it('closes the connect stream after connected and logged_out', () => {
    expect(INSTANCE_STATUSES.filter(isStreamFinalStatus)).toEqual(['connected', 'logged_out']);
  });
});

describe('planTransition', () => {
  it('reports no change for the same status and keeps the incident start', () => {
    expect(
      planTransition({ status: 'connecting', disconnectedSince: EARLIER }, 'connecting', NOW),
    ).toEqual({ changed: false, status: 'connecting', disconnectedSince: EARLIER });
  });

  it.each(['connecting', 'disconnected'] as const)(
    'starts an incident when a connected instance goes to %s',
    (next) => {
      expect(planTransition({ status: 'connected', disconnectedSince: null }, next, NOW)).toEqual({
        changed: true,
        status: next,
        disconnectedSince: NOW,
      });
    },
  );

  it('keeps the incident start between connecting and disconnected', () => {
    expect(
      planTransition({ status: 'connecting', disconnectedSince: EARLIER }, 'disconnected', NOW),
    ).toMatchObject({ changed: true, disconnectedSince: EARLIER });
  });

  it('does not start an incident for the first connect flow (created to connecting)', () => {
    expect(
      planTransition({ status: 'created', disconnectedSince: null }, 'connecting', NOW),
    ).toMatchObject({ changed: true, disconnectedSince: null });
    expect(
      planTransition({ status: 'logged_out', disconnectedSince: null }, 'connecting', NOW),
    ).toMatchObject({ changed: true, disconnectedSince: null });
  });

  it.each(['connected', 'logged_out'] as const)('ends the incident at %s', (next) => {
    expect(
      planTransition({ status: 'disconnected', disconnectedSince: EARLIER }, next, NOW),
    ).toEqual({ changed: true, status: next, disconnectedSince: null });
  });
});
