-- AlterTable
ALTER TABLE "instances" ADD COLUMN     "disconnectAlertedAt" TIMESTAMPTZ(3),
ADD COLUMN     "disconnectedSince" TIMESTAMPTZ(3),
ADD COLUMN     "providerCreatedAt" TIMESTAMPTZ(3),
ADD COLUMN     "providerEventAt" TIMESTAMPTZ(3),
ADD COLUMN     "statusChangedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "instances_status_statusChangedAt_idx" ON "instances"("status", "statusChangedAt");

