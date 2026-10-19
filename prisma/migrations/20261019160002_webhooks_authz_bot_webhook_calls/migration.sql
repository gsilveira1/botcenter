-- AlterTable
ALTER TABLE "bots" ADD COLUMN     "previousSecretEncrypted" TEXT,
ADD COLUMN     "previousSecretExpiresAt" TIMESTAMPTZ(3),
ADD COLUMN     "secretEncrypted" TEXT;

-- CreateTable
CREATE TABLE "bot_webhook_calls" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "botId" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "webhook_delivery_status" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastStatusCode" INTEGER,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMPTZ(3),
    "leaseExpiresAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bot_webhook_calls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bot_webhook_calls_status_nextAttemptAt_idx" ON "bot_webhook_calls"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "bot_webhook_calls_tenantId_createdAt_idx" ON "bot_webhook_calls"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "bot_webhook_calls_conversationId_idx" ON "bot_webhook_calls"("conversationId");

-- CreateIndex
CREATE INDEX "bot_webhook_calls_botId_idx" ON "bot_webhook_calls"("botId");

-- AddForeignKey
ALTER TABLE "bot_webhook_calls" ADD CONSTRAINT "bot_webhook_calls_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_webhook_calls" ADD CONSTRAINT "bot_webhook_calls_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_webhook_calls" ADD CONSTRAINT "bot_webhook_calls_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

