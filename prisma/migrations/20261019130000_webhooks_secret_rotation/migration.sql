-- AlterTable
ALTER TABLE "webhook_subscriptions" ADD COLUMN     "previousSecretEncrypted" TEXT,
ADD COLUMN     "previousSecretExpiresAt" TIMESTAMPTZ(3);

