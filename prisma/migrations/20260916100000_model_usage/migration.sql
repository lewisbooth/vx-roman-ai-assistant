ALTER TABLE "VoiceSession" ADD COLUMN "model" TEXT;
ALTER TABLE "VoiceSession" ADD COLUMN "usageSeconds" REAL;

CREATE TABLE "ModelUsage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "assistantId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "serviceTier" TEXT,
    "status" TEXT NOT NULL,
    "inputTokens" INTEGER,
    "cachedInputTokens" INTEGER,
    "outputTokens" INTEGER,
    "reasoningTokens" INTEGER,
    "totalTokens" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "ModelUsage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ModelUsage_assistantId_fkey" FOREIGN KEY ("assistantId") REFERENCES "ConversationMessage" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "ModelUsage_conversationId_createdAt_idx" ON "ModelUsage"("conversationId", "createdAt");
