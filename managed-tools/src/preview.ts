/**
 * Preview tool spec — exposes `report_preview_url` to harness adapters.
 *
 * Lets an agent register the port its service is listening on so the
 * platform can construct a browser-accessible preview URL and surface it
 * in the session header as a "View Preview" link.
 *
 * Env contract (same vars as memory.ts — no new deps):
 *   LAP_BASE_URL       platform base URL
 *   SESSION_ID         session to attach the preview URL to
 *   LAP_ACCESS_TOKEN   bearer for /api/v1/managed_agents/*
 *   LAP_REFRESH_TOKEN  optional — used for token refresh on 401
 */

import { z } from "zod";
import { type MemoryEnv, memoryEnv } from "./memory.js";

export { memoryEnv };
export type { MemoryEnv };

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const reportPreviewUrlSchema = {
  port: z
    .number()
    .int()
    .min(1)
    .max(65535)
    .describe("Port the service is listening on inside the sandbox (e.g. 4000 for LiteLLM)."),
};

export const reportPreviewUrlDescription =
  "Register the port your service is listening on. Call this after the service is ready so the platform exposes a 'View Preview' link in the session header. The platform constructs the public URL — you only need to provide the port number.";

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export interface ReportPreviewUrlInput {
  port: number;
}

export interface ReportPreviewUrlResult {
  text: string;
  isError?: boolean;
}

export async function callReportPreviewUrl(
  env: MemoryEnv,
  input: ReportPreviewUrlInput,
): Promise<ReportPreviewUrlResult> {
  const sessionId = process.env.SESSION_ID ?? "";
  if (!sessionId) {
    return { text: "SESSION_ID not set — cannot register preview URL.", isError: true };
  }

  const url = `${env.base_url}/api/v1/managed_agents/sessions/${encodeURIComponent(sessionId)}/preview`;
  const bearer = process.env.LAP_ACCESS_TOKEN ?? process.env.LAP_AUTH_TOKEN ?? env.access_token;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ port: input.port }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        text: `Failed to register preview URL: HTTP ${res.status}${text ? ` — ${text}` : ""}`,
        isError: true,
      };
    }

    const data = (await res.json()) as { preview_url?: string };
    return {
      text: `Preview URL registered: ${data.preview_url ?? `port ${input.port}`}. The "View Preview" button is now active in the session header.`,
    };
  } catch (e) {
    return {
      text: `Failed to register preview URL: ${e instanceof Error ? e.message : String(e)}`,
      isError: true,
    };
  }
}
