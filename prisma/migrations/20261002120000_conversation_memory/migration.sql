ALTER TABLE "Conversation" ADD COLUMN "memoJson" TEXT NOT NULL DEFAULT '{}';
ALTER TABLE "VoiceSession" ADD COLUMN "closeReason" TEXT;
CREATE INDEX "ConversationMessage_conversationId_completedAt_sequence_idx" ON "ConversationMessage"("conversationId", "completedAt", "sequence");
CREATE INDEX "VoiceTranscript_conversationId_role_sequence_idx" ON "VoiceTranscript"("conversationId", "role", "sequence");
CREATE TABLE "ConversationContext" (
  "conversationId" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "throughSequence" INTEGER NOT NULL,
  "inputJson" TEXT NOT NULL,
  "updatedAt" DATETIME NOT NULL,
  PRIMARY KEY ("conversationId", "model"),
  CONSTRAINT "ConversationContext_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
