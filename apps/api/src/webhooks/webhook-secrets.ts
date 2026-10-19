import { Injectable } from '@nestjs/common';
import { SecretBox } from '../services/secret-box';

/** After a rotation, the old secret stays valid for this time. */
export const SECRET_ROTATION_GRACE_MS = 24 * 60 * 60_000;

/** The secret columns of a subscription. */
export interface SubscriptionSecretColumns {
  id: string;
  secretEncrypted: string;
  previousSecretEncrypted: string | null;
  previousSecretExpiresAt: Date | null;
}

/**
 * Encrypts and decrypts the signing secrets with `SecretBox`. The additional data is the subscription id,
 * so a value copied to another row does not decrypt. The secret leaves the API only in the response of
 * `POST /v1/webhooks` and of the rotation.
 */
@Injectable()
export class WebhookSecrets {
  constructor(private readonly box: SecretBox) {}

  seal(subscriptionId: string, secret: string): string {
    return this.box.encrypt(secret, subscriptionId);
  }

  /** The secrets that sign a delivery: the current one, and the previous one in the rotation grace time. */
  signingSecrets(subscription: SubscriptionSecretColumns, now = new Date()): string[] {
    const secrets = [this.box.decrypt(subscription.secretEncrypted, subscription.id)];
    if (
      subscription.previousSecretEncrypted &&
      subscription.previousSecretExpiresAt &&
      subscription.previousSecretExpiresAt > now
    ) {
      secrets.push(this.box.decrypt(subscription.previousSecretEncrypted, subscription.id));
    }
    return secrets;
  }
}
