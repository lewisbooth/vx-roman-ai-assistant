-- Existing memos were selective notes, not proof of a complete review. Their
-- provider checkpoint/raw history remains available for the first review.
ALTER TABLE "Conversation" ADD COLUMN "memoThroughSequence" INTEGER NOT NULL DEFAULT -1;
