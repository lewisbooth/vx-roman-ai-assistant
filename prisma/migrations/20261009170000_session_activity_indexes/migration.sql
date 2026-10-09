-- Indexed existence checks over durable activity, without rewriting history.
CREATE INDEX "VisualizationJob_conversationId_idx" ON "VisualizationJob"("conversationId");
CREATE INDEX "ToolInvocation_conversationId_name_status_idx" ON "ToolInvocation"("conversationId", "name", "status");
