CREATE TABLE "ApiIncident" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL,
    "startedDayUtc" TEXT NOT NULL,
    "endedAt" DATETIME
);

CREATE INDEX "ApiIncident_startedDayUtc_kind_idx" ON "ApiIncident"("startedDayUtc", "kind");
CREATE INDEX "ApiIncident_startedAt_idx" ON "ApiIncident"("startedAt");
CREATE UNIQUE INDEX "ApiIncident_one_open_idx" ON "ApiIncident" ((1)) WHERE "endedAt" IS NULL;
