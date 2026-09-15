CREATE TABLE "VoiceSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "providerId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'starting',
    "leaseExpiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" DATETIME,
    "error" TEXT,
    CONSTRAINT "VoiceSession_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "VoiceSession_conversationId_status_idx" ON "VoiceSession"("conversationId", "status");
CREATE UNIQUE INDEX "VoiceSession_one_active_per_conversation" ON "VoiceSession"("conversationId") WHERE "status" IN ('starting', 'active');

CREATE TABLE "VoiceTranscript" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "voiceId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "startMs" REAL NOT NULL,
    "endMs" REAL NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VoiceTranscript_voiceId_fkey" FOREIGN KEY ("voiceId") REFERENCES "VoiceSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "VoiceTranscript_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "VoiceTranscript_voiceId_providerEventId_key" ON "VoiceTranscript"("voiceId", "providerEventId");
CREATE UNIQUE INDEX "VoiceTranscript_conversationId_sequence_key" ON "VoiceTranscript"("conversationId", "sequence");
