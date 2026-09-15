ALTER TABLE "ToolInvocation" ADD COLUMN "resultJson" TEXT;
ALTER TABLE "ToolInvocation" ADD COLUMN "confirmedAt" DATETIME;

CREATE TABLE "MeasurementDraft" (
    "conversationId" TEXT NOT NULL,
    "productPath" TEXT NOT NULL,
    "width" REAL NOT NULL,
    "height" REAL NOT NULL,
    "unit" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "mount" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    PRIMARY KEY ("conversationId", "productPath"),
    CONSTRAINT "MeasurementDraft_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "MeasurementWriteReceipt" (
    "conversationId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "argumentsJson" TEXT NOT NULL,
    "resultJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("conversationId", "requestId"),
    CONSTRAINT "MeasurementWriteReceipt_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
