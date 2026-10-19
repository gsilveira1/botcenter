import type { AppEnv } from '../../src/config/env';
import { AlertService } from '../../src/services/alert.service';
import type { Alert } from '../../src/services/alert.service';

/** An `AlertService` that records the alerts instead of a Discord call. */
export class RecordingAlertService extends AlertService {
  readonly alerts: Alert[] = [];

  constructor(env: AppEnv) {
    super(env, async () => 204);
  }

  override async notify(alert: Alert): Promise<void> {
    this.alerts.push(alert);
  }
}
