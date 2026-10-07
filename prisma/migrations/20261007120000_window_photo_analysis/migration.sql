ALTER TABLE "WindowPhoto" ADD COLUMN "analysisStatus" TEXT;
ALTER TABLE "WindowPhoto" ADD COLUMN "analysisVersion" TEXT;
ALTER TABLE "WindowPhoto" ADD COLUMN "analysisQueuedAt" DATETIME;
ALTER TABLE "WindowPhoto" ADD COLUMN "analysisStartedAt" DATETIME;
ALTER TABLE "WindowPhoto" ADD COLUMN "analysisCompletedAt" DATETIME;
ALTER TABLE "WindowPhoto" ADD COLUMN "analysisAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "WindowPhoto" ADD COLUMN "analysisUsageId" TEXT;
ALTER TABLE "WindowPhoto" ADD COLUMN "analysisJson" TEXT;
CREATE INDEX "WindowPhoto_analysisStatus_analysisQueuedAt_idx" ON "WindowPhoto"("analysisStatus", "analysisQueuedAt");
