ALTER TABLE "Conversation" ADD COLUMN "nextSequence" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Conversation" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Conversation" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'active';

UPDATE "Conversation" SET "nextSequence" = COALESCE(
  (SELECT MAX("sequence") + 1 FROM "ConversationMessage" WHERE "conversationId" = "Conversation"."id"), 0
);

CREATE TABLE "new_ConversationMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "partsJson" TEXT NOT NULL DEFAULT '[]',
    "error" TEXT,
    "model" TEXT,
    "serviceTier" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "ConversationMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "new_ConversationMessage" ("id", "conversationId", "requestId", "sequence", "role", "status", "partsJson", "error", "model", "serviceTier", "createdAt", "completedAt")
SELECT "id", "conversationId", "requestId", "sequence", "role", "status", json_array(json_object('type', 'text', 'text', "text")), "error", "model", "serviceTier", "createdAt", "completedAt"
FROM "ConversationMessage";
DROP TABLE "ConversationMessage";
ALTER TABLE "new_ConversationMessage" RENAME TO "ConversationMessage";
CREATE UNIQUE INDEX "ConversationMessage_conversationId_requestId_role_key" ON "ConversationMessage"("conversationId", "requestId", "role");
CREATE UNIQUE INDEX "ConversationMessage_conversationId_sequence_key" ON "ConversationMessage"("conversationId", "sequence");

CREATE TABLE "ToolInvocation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "assistantId" TEXT NOT NULL,
    "providerCallId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "argumentsJson" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "claimClientId" TEXT,
    "claimTokenHash" TEXT,
    "productIdsJson" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "ToolInvocation_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ToolInvocation_assistantId_fkey" FOREIGN KEY ("assistantId") REFERENCES "ConversationMessage" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ToolInvocation_conversationId_providerCallId_key" ON "ToolInvocation"("conversationId", "providerCallId");
CREATE INDEX "ToolInvocation_conversationId_status_idx" ON "ToolInvocation"("conversationId", "status");
