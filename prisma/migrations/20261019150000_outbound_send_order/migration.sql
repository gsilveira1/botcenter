-- outbound slice (additive): the insert order of the messages, for the send order of each contact (ARCH-02)
-- and the limit of queued rows of each instance (SEC-04).
-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "seq" BIGSERIAL NOT NULL;

-- CreateIndex
CREATE INDEX "messages_queued_idx" ON "messages"("instanceId", "contact", "seq") WHERE ("status" = 'queued');
