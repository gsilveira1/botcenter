-- inbound-runtime slice (additive, ARCH-08): the fire time of the armed state timer, so a lost timer job can be added again.
-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "timerFireAt" TIMESTAMPTZ(3);

-- CreateIndex
CREATE INDEX "conversations_timer_fire_at_idx" ON "conversations"("timerFireAt") WHERE ("timerFireAt" IS NOT NULL);
