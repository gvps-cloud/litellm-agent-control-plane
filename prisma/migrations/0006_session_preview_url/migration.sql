-- Add preview_url column to managed_agent_session
-- Populated by POST /sessions/:id/preview when an agent calls report_preview_url({ port }).
ALTER TABLE "managed_agent_session" ADD COLUMN "preview_url" TEXT;
