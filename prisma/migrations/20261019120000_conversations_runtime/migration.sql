-- conversations slice (additive): the handoff trigger, the last menu of a conversation, and the bot queue of inbound messages.
-- AlterEnum
ALTER TYPE "transition_trigger" ADD VALUE 'handoff';

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "lastMenu" JSONB;

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "botPending" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "messages_bot_pending_idx" ON "messages"("instanceId", "contact", "createdAt") WHERE ("botPending");

