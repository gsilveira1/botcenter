-- CreateIndex
CREATE INDEX "messages_direction_createdAt_idx" ON "messages"("direction", "createdAt");

-- CreateIndex
CREATE INDEX "webhook_deliveries_updatedAt_idx" ON "webhook_deliveries"("updatedAt");

