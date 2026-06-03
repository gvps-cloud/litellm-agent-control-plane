/**
 * Generic upstream-LiteLLM passthrough used by `/api/v1/[...path]` and
 * `/api/mcp-rest/[...path]` route handlers. Both forward to
 * `${LITELLM_API_BASE}/<prefix>/<path>` with the master key attached and
 * the bearer auth gate enforced.
 */

import { assertAuth } from "@/api/auth";
import { env } from "@/api/env";

const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-authenticate",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "content-length",
  // undici has already decompressed; forwarding makes the browser try again.
  "content-encoding",
]);

export async function forwardToLiteLLM(
  req: Request,
  path: string[],
  prefix: string,
): Promise<Response> {
  try {
    assertAuth(req);
  } catch (r) {
    if (r instanceof Response) return r;
    throw r;
  }

  const base = env.LITELLM_API_BASE.replace(/\/+$/, "");
  if (!base) {
    const joinedPath = path.join("/");
    if (prefix === "v1" && joinedPath === "models" && req.method === "GET") {
      return Response.json({ object: "list", data: [] });
    }
    if (prefix === "v1" && joinedPath === "mcp/server" && req.method === "GET") {
      return Response.json([]);
    }
    if (prefix === "mcp-rest" && joinedPath === "tools/list" && req.method === "GET") {
      return Response.json({ tools: [] });
    }
    return Response.json(
      { error: "LITELLM_API_BASE is not configured" },
      { status: 503 },
    );
  }

  const url = new URL(req.url);
  const target = `${base}/${prefix}/${path.join("/")}${url.search}`;

  const headers = new Headers();
  for (const [k, v] of req.headers.entries()) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    if (k.toLowerCase() === "authorization") continue;
    headers.set(k, v);
  }
  headers.set("Authorization", `Bearer ${env.LITELLM_API_KEY}`);

  const init: RequestInit & { duplex?: "half" } = {
    method: req.method,
    headers,
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = req.body;
    init.duplex = "half";
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, init);
  } catch (e) {
    return Response.json(
      { error: `upstream unreachable: ${(e as Error).message}` },
      { status: 502 },
    );
  }

  const respHeaders = new Headers();
  for (const [k, v] of upstream.headers.entries()) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    respHeaders.set(k, v);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: respHeaders,
  });
}
