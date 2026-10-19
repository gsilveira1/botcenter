-- inbound-runtime slice (additive, SEC-04): the count of state timeouts in a row without an inbound message.
-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "timeoutsInRow" INTEGER NOT NULL DEFAULT 0;
