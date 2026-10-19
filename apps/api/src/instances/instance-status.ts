import type { InstanceStatus } from '@botcenter/contracts';
import type { ProviderConnectionState } from '@botcenter/whatsapp-provider';

/**
 * The lifecycle rules of an instance (architecture plan, section "Ciclo de vida da instância").
 * Pure functions: the services and the tests use them.
 */

/** A lost connection: the monitor alerts when an instance stays in one of these statuses after `connected`. */
export const INCIDENT_STATUSES = ['connecting', 'disconnected'] as const satisfies InstanceStatus[];

/** The connect stream closes after one of these statuses. `logged_out` needs a new connect flow. */
export const STREAM_FINAL_STATUSES = [
  'connected',
  'logged_out',
] as const satisfies InstanceStatus[];

/** Maps a connection state of the provider to an instance status. */
export function statusFromProvider(state: ProviderConnectionState): InstanceStatus {
  switch (state) {
    case 'connected':
      return 'connected';
    case 'connecting':
      return 'connecting';
    case 'disconnected':
      return 'disconnected';
    case 'logged_out':
      return 'logged_out';
  }
}

export function isIncidentStatus(status: InstanceStatus): boolean {
  return (INCIDENT_STATUSES as readonly InstanceStatus[]).includes(status);
}

export function isStreamFinalStatus(status: InstanceStatus): boolean {
  return (STREAM_FINAL_STATUSES as readonly InstanceStatus[]).includes(status);
}

export interface StatusState {
  status: InstanceStatus;
  disconnectedSince: Date | null;
}

export interface TransitionPlan {
  /** False when the status does not change (a duplicate event). */
  changed: boolean;
  status: InstanceStatus;
  disconnectedSince: Date | null;
}

/**
 * Plans a status change. An incident starts when a `connected` instance goes to `connecting` or
 * `disconnected` (the provider reports a lost connection as `connecting`). The incident continues while
 * the instance moves between these two statuses, and it ends at `connected`, `logged_out`, or `created`.
 */
export function planTransition(
  current: StatusState,
  next: InstanceStatus,
  now: Date,
): TransitionPlan {
  if (current.status === next) {
    return { changed: false, status: next, disconnectedSince: current.disconnectedSince };
  }
  let disconnectedSince: Date | null = null;
  if (isIncidentStatus(next)) {
    disconnectedSince = current.status === 'connected' ? now : current.disconnectedSince;
  }
  return { changed: true, status: next, disconnectedSince };
}
