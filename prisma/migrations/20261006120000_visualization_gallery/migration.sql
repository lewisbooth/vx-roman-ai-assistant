-- CreateTable
CREATE TABLE "GalleryOwner" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" DATETIME
);

-- CreateTable
CREATE TABLE "WindowPhoto" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "assetKey" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "bytes" INTEGER NOT NULL,
    "cleanup" BOOLEAN NOT NULL DEFAULT true,
    "consentVersion" TEXT NOT NULL,
    "consentAt" DATETIME NOT NULL,
    "uploadStatus" TEXT NOT NULL DEFAULT 'saving',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "WindowPhoto_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "GalleryOwner" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "WindowPhoto_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "VisualizationJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "windowId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "windowRevision" INTEGER NOT NULL,
    "windowTitle" TEXT NOT NULL,
    "sourceAssetKey" TEXT NOT NULL,
    "productPath" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL,
    "productJson" TEXT NOT NULL DEFAULT '{}',
    "referencesJson" TEXT NOT NULL DEFAULT '[]',
    "cleanup" BOOLEAN NOT NULL,
    "targetDescription" TEXT,
    "promptVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'awaiting_product',
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "reservedBytes" INTEGER NOT NULL DEFAULT 10485760,
    "resultKey" TEXT,
    "resultBytes" INTEGER,
    "error" TEXT,
    "claimClientId" TEXT,
    "claimTokenHash" TEXT,
    "claimExpiresAt" DATETIME,
    "deadlineAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "deletedAt" DATETIME,
    CONSTRAINT "VisualizationJob_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "GalleryOwner" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "VisualizationJob_windowId_fkey" FOREIGN KEY ("windowId") REFERENCES "WindowPhoto" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "VisualizationJob_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ImageGenerationAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "model" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "providerRequestId" TEXT,
    "errorCode" TEXT,
    "textInputTokens" INTEGER,
    "textCachedInputTokens" INTEGER,
    "imageInputTokens" INTEGER,
    "imageCachedInputTokens" INTEGER,
    "imageOutputTokens" INTEGER,
    "usageValid" BOOLEAN NOT NULL DEFAULT false,
    "usageJson" TEXT,
    "rateSnapshotJson" TEXT NOT NULL,
    "costUsd" REAL,
    "costEvidence" TEXT NOT NULL DEFAULT 'unknown',
    "costReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "ImageGenerationAttempt_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "VisualizationJob" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ImageGenerationAttempt_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Conversation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "credentialHash" TEXT NOT NULL,
    "credentialExpiresAt" DATETIME NOT NULL,
    "turnCount" INTEGER NOT NULL DEFAULT 0,
    "nextSequence" INTEGER NOT NULL DEFAULT 0,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "pendingRequestId" TEXT,
    "memoJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "galleryOwnerId" TEXT,
    "selectedWindowPhotoId" TEXT,
    CONSTRAINT "Conversation_galleryOwnerId_fkey" FOREIGN KEY ("galleryOwnerId") REFERENCES "GalleryOwner" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Conversation" ("createdAt", "credentialExpiresAt", "credentialHash", "id", "memoJson", "nextSequence", "origin", "pendingRequestId", "revision", "shop", "status", "turnCount", "updatedAt") SELECT "createdAt", "credentialExpiresAt", "credentialHash", "id", "memoJson", "nextSequence", "origin", "pendingRequestId", "revision", "shop", "status", "turnCount", "updatedAt" FROM "Conversation";
DROP TABLE "Conversation";
ALTER TABLE "new_Conversation" RENAME TO "Conversation";
CREATE UNIQUE INDEX "Conversation_credentialHash_key" ON "Conversation"("credentialHash");
CREATE INDEX "Conversation_shop_createdAt_idx" ON "Conversation"("shop", "createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "GalleryOwner_tokenHash_key" ON "GalleryOwner"("tokenHash");

-- CreateIndex
CREATE INDEX "GalleryOwner_shop_createdAt_idx" ON "GalleryOwner"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "WindowPhoto_ownerId_createdAt_id_idx" ON "WindowPhoto"("ownerId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WindowPhoto_ownerId_requestId_key" ON "WindowPhoto"("ownerId", "requestId");

-- CreateIndex
CREATE INDEX "VisualizationJob_ownerId_createdAt_id_idx" ON "VisualizationJob"("ownerId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "VisualizationJob_status_deadlineAt_idx" ON "VisualizationJob"("status", "deadlineAt");

-- CreateIndex
CREATE UNIQUE INDEX "VisualizationJob_ownerId_requestId_key" ON "VisualizationJob"("ownerId", "requestId");

-- CreateIndex
CREATE INDEX "ImageGenerationAttempt_conversationId_createdAt_idx" ON "ImageGenerationAttempt"("conversationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ImageGenerationAttempt_jobId_ordinal_key" ON "ImageGenerationAttempt"("jobId", "ordinal");
