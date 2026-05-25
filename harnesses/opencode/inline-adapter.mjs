#!/usr/bin/env node
/*
 * opencode inline adapter — makes per-agent skills LOADABLE on a single shared
 * `opencode serve` (the opencode-brain-inline harness).
 *
 * Problem: the inline server is one process/filesystem shared by every agent.
 * opencode discovers skills from disk at session-create time and scopes project
 * skills to the session's `directory`. So to give each agent only its own
 * loadable skills we must, per session: (1) write that agent's SKILL.md files
 * into a per-agent directory BEFORE creating the opencode session, and (2) pin
 * every call for that session to `?directory=<that dir>`. Raw `opencode serve`
 * can't do (1) from LAP's `files` payload (it would write skill files to the
 * shared ~/.claude/skills and leak them across agents), so this adapter sits in
 * front of it.
 *
 * The platform sends the agent's skills as SandboxFileSpec entries in the
 * POST /session `files` array (sandbox_path `~/.claude/skills/<slug>/SKILL.md`)
 * plus `agent_id`. We pull the skill files out, write them under
 * <workdir>/<agent_id>/.opencode/skills/<slug>/SKILL.md, drop them from the
 * forwarded body, and forward with ?directory.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const PORT = Number(process.env.PORT || 4096);
const CHILD_PORT = Number(process.env.OPENCODE_CHILD_PORT || PORT + 1);
const UP = `http://127.0.0.1:${CHILD_PORT}`;
const WORKDIR = process.env.OPENCODE_INLINE_WORKDIR || "/tmp/opencode-agents";
const BASE_CONFIG = path.join(process.env.REPO_DIR || "/work/repo", "opencode.json");

fs.mkdirSync(WORKDIR, { recursive: true });
const sessionDir = new Map(); // opencode session id -> working dir
const log = (...a) => console.log("[inline-adapter]", ...a);

// A SandboxFileSpec is a skill file when its sandbox_path lands in a skills dir
// and is a SKILL.md. Returns the slug (the directory under skills/), else null.
function skillSlug(sandboxPath) {
  if (!sandboxPath) return null;
  const m = sandboxPath.replace(/\\/g, "/").match(/\/skills\/([^/]+)\/SKILL\.md$/);
  return m && /^[a-z0-9._-]+$/i.test(m[1]) ? m[1] : null;
}

// Materialize an agent's skills into its own dir and return that dir. Writes a
// fresh skills tree each time so detaching a skill is reflected on next session.
function ensureAgentDir(agentId, files) {
  const key = /^[a-z0-9._-]+$/i.test(agentId || "") ? agentId : "default";
  const dir = path.join(WORKDIR, key);
  const skillsRoot = path.join(dir, ".opencode", "skills");
  fs.rmSync(skillsRoot, { recursive: true, force: true });
  fs.mkdirSync(skillsRoot, { recursive: true });
  if (!fs.existsSync(path.join(dir, ".git"))) {
    // opencode walks up to the git worktree to find project skills.
    spawnSync("git", ["init", "-q"], { cwd: dir });
  }
  // Give the dir the same provider/model/mcp config the entrypoint generated.
  try { fs.copyFileSync(BASE_CONFIG, path.join(dir, "opencode.json")); } catch {}
  let n = 0;
  for (const f of files || []) {
    const slug = skillSlug(f.sandbox_path);
    if (!slug) continue;
    const sdir = path.join(skillsRoot, slug);
    fs.mkdirSync(sdir, { recursive: true });
    fs.writeFileSync(path.join(sdir, "SKILL.md"), Buffer.from(f.content || "", "base64"));
    n++;
  }
  log(`agent ${key}: materialized ${n} skill(s)`);
  return dir;
}

function readBody(req) {
  return new Promise((res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => res(b)); });
}

function forward(method, urlPath, query, bodyBuf, clientRes) {
  const u = new URL(UP + urlPath);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  const upReq = http.request(u, { method, headers: { "content-type": "application/json" } }, (upRes) => {
    clientRes.writeHead(upRes.statusCode || 502, upRes.headers);
    upRes.pipe(clientRes);
  });
  upReq.on("error", (e) => { clientRes.writeHead(502); clientRes.end(JSON.stringify({ error: String(e) })); });
  if (bodyBuf) upReq.write(bodyBuf);
  upReq.end();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  if (p === "/" || p === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ harness: "opencode-brain-inline", ok: true }));
    return;
  }

  if (p === "/session" && req.method === "POST") {
    const raw = await readBody(req);
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch {}
    const dir = ensureAgentDir(body.agent_id, body.files);
    // Don't let opencode also write the skill files (they'd land in the shared
    // ~/.claude/skills and leak across agents) — keep only non-skill files.
    if (Array.isArray(body.files)) body.files = body.files.filter((f) => !skillSlug(f.sandbox_path));
    const u = new URL(UP + "/session");
    u.searchParams.set("directory", dir);
    const upReq = http.request(u, { method: "POST", headers: { "content-type": "application/json" } }, (upRes) => {
      let data = "";
      upRes.on("data", (c) => (data += c));
      upRes.on("end", () => {
        try { const j = JSON.parse(data); if (j && j.id) { sessionDir.set(j.id, dir); log(`session ${j.id} -> ${path.basename(dir)}`); } } catch {}
        res.writeHead(upRes.statusCode || 502, { "content-type": "application/json" });
        res.end(data);
      });
    });
    upReq.on("error", (e) => { res.writeHead(502); res.end(JSON.stringify({ error: String(e) })); });
    upReq.write(JSON.stringify(body));
    upReq.end();
    return;
  }

  // /session/:id/... — pin to the agent's dir so skills + provider resolve.
  const m = p.match(/^\/session\/([^/]+)/);
  const query = {};
  if (m) { const dir = sessionDir.get(m[1]); if (dir) query.directory = dir; }
  for (const [k, v] of url.searchParams) query[k] = v;
  const raw = ["POST", "PUT", "PATCH"].includes(req.method) ? await readBody(req) : null;
  forward(req.method, p, query, raw, res);
});

// Boot the shared opencode serve as a child, then start accepting traffic.
function startChild() {
  log(`spawning: opencode serve on :${CHILD_PORT}`);
  const child = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(CHILD_PORT)], {
    stdio: "inherit",
    env: process.env,
  });
  child.on("exit", (code) => { log(`opencode serve exited (${code}) — shutting down`); process.exit(code ?? 1); });
}

async function waitChild() {
  for (let i = 0; i < 120; i++) {
    try {
      const ok = await new Promise((r) => {
        const rq = http.get(UP + "/", (res) => { res.resume(); r(res.statusCode === 200); });
        rq.on("error", () => r(false));
      });
      if (ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

startChild();
waitChild().then((ok) => {
  if (!ok) { log("opencode serve never became ready"); process.exit(1); }
  server.listen(PORT, "0.0.0.0", () => log(`listening :${PORT} -> ${UP} | workdir=${WORKDIR}`));
});
