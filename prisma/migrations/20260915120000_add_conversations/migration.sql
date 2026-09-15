CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "credentialHash" TEXT NOT NULL,
    "credentialExpiresAt" DATETIME NOT NULL,
    "turnCount" INTEGER NOT NULL DEFAULT 0,
    "pendingRequestId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "ConversationMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "text" TEXT NOT NULL DEFAULT '',
    "error" TEXT,
    "model" TEXT,
    "serviceTier" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "ConversationMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "Conversation_credentialHash_key" ON "Conversation"("credentialHash");
CREATE INDEX "Conversation_shop_createdAt_idx" ON "Conversation"("shop", "createdAt");
CREATE UNIQUE INDEX "ConversationMessage_conversationId_requestId_role_key" ON "ConversationMessage"("conversationId", "requestId", "role");
CREATE UNIQUE INDEX "ConversationMessage_conversationId_sequence_key" ON "ConversationMessage"("conversationId", "sequence");
