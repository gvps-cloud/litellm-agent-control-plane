#!/usr/bin/env bash
# Claude Agent SDK harness entrypoint.
#
# Mirrors harnesses/opencode/entrypoint.sh's contract so the platform's
# fargate.ts:buildContainerEnv works unchanged: same env vars, same
# clone-then-listen flow, same port.
set -euo pipefail

# vault sidecar handoff. When enabled, the sidecar writes a stub-env file
# into /lap-shared once it's listening. Wait for it, source the stubs, and
# the rest of the entrypoint sees only stubs in env. If vault never comes
# up, unset the proxy env so direct HTTPS still works (degraded mode rather
# than every outbound request hanging).
if [ "${VAULT_ENABLED:-}" = "true" ]; then
  for _ in $(seq 1 30); do
    if [ -s /lap-shared/env ]; then break; fi
    sleep 0.5
  done
  if [ ! -s /lap-shared/env ]; then
    echo "[entrypoint] vault not ready after 15s — unsetting proxy, proceeding without stubs" >&2
    unset HTTPS_PROXY HTTP_PROXY NO_PROXY
  else
    set -a
    . /lap-shared/env
    set +a
    # Debian's git is libcurl-gnutls — doesn't auto-discover the system
    # trust store reliably. Pin it to the bundle file (which has vault's
    # CA baked in at image build time).
    export GIT_SSL_CAINFO=/etc/ssl/certs/ca-certificates.crt
    echo "[entrypoint] vault stubs sourced ($(wc -l </lap-shared/env) keys)"
  fi
fi

: "${LITELLM_API_KEY:?LITELLM_API_KEY required}"
: "${LITELLM_API_BASE:?LITELLM_API_BASE required}"
: "${LITELLM_DEFAULT_MODEL:?LITELLM_DEFAULT_MODEL required}"

: "${BRANCH:=main}"
: "${PORT:=4096}"
: "${REPO_DIR:=/work/repo}"

# Phase progress reporter. POSTs the named phase to the platform so the UI
# can render real container-side progress instead of guessing from the
# wall clock. The platform injects PLATFORM_URL, SESSION_ID, and
# HARNESS_PROGRESS_TOKEN at runTask time; if any is empty (warm-pool tasks
# pre-claim, or a deploy that hasn't configured PLATFORM_INTERNAL_URL) the
# call short-circuits. The trailing `|| true` is critical — a failed phase
# report must never prevent the harness from booting.
report_phase() {
  if [ -z "${PLATFORM_URL:-}" ] || [ -z "${SESSION_ID:-}" ] || [ -z "${HARNESS_PROGRESS_TOKEN:-}" ]; then
    return 0
  fi
  curl -fsS --max-time 5 \
    -X POST \
    -H "Authorization: Bearer ${HARNESS_PROGRESS_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"phase\":\"$1\"}" \
    "${PLATFORM_URL}/api/v1/managed_agents/sessions/${SESSION_ID}/phase" \
    >/dev/null 2>&1 || true
}

# The SDK spawns the `claude` binary with cwd=$REPO_DIR. If the directory
# doesn't exist (no REPO_URL set, or clone failed), spawn fails with
# ENOENT — and the SDK's error message blames "Claude Code native binary
# not found", which is misleading. Always ensure the dir exists so the
# spawn itself succeeds.
mkdir -p "$REPO_DIR"

# Two token paths, matching opencode's contract:
#   GIT_TOKEN: clone-only, wiped from env after clone (read-only PR review).
#   GITHUB_TOKEN / GH_TOKEN: persistent, gh + git push.
CLONE_TOKEN="${GIT_TOKEN:-${GITHUB_TOKEN:-${GH_TOKEN:-}}}"

if [ -n "${REPO_URL:-}" ]; then
  if [ ! -d "$REPO_DIR/.git" ]; then
    report_phase cloning_repo
    if [ -n "$CLONE_TOKEN" ]; then
      git -c credential.helper= \
          -c "credential.helper=!f() { echo username=x-access-token; echo password=$CLONE_TOKEN; }; f" \
          clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$REPO_DIR"
    else
      git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$REPO_DIR"
    fi
  fi
  # Persistent token path: configure a credential helper that reads from env
  # so `gh pr create` and `git push` work without the token landing in argv
  # or .git/config.
  if [ -n "${GITHUB_TOKEN:-}${GH_TOKEN:-}" ] && [ -z "${GIT_TOKEN:-}" ]; then
    git -C "$REPO_DIR" config credential.helper "store --file=/tmp/.git-credentials"
    PERSIST_TOKEN="${GITHUB_TOKEN:-${GH_TOKEN}}"
    echo "https://x-access-token:${PERSIST_TOKEN}@github.com" > /tmp/.git-credentials
    chmod 600 /tmp/.git-credentials
  fi
fi

# Install per-agent Python packages if AGENT_REQUIREMENTS is set.
# Content is the requirements.txt body (newline-separated pip specs).
# Use --target to install into a sandbox-owned directory instead of --system,
# which would require root to write to /usr/lib/python3.x/dist-packages.
report_phase installing_deps
if [ -n "${AGENT_REQUIREMENTS:-}" ]; then
  printf '%s\n' "$AGENT_REQUIREMENTS" | uv pip install --target /home/sandbox/.local/lib/python-agent -q -r /dev/stdin
  export PYTHONPATH="/home/sandbox/.local/lib/python-agent${PYTHONPATH:+:$PYTHONPATH}"
fi

# Clone-only token: wipe so the LLM can't `printenv GIT_TOKEN` it back.
unset GIT_TOKEN

# Hydrate attached skills as ~/.claude/skills/<slug>/SKILL.md so the SDK's
# in-sandbox `claude` binary (and any future file-based skill consumer)
# discovers them on boot. Platform builds SKILLS_JSON in
# src/server/k8s.ts:buildSkillsJsonForAgent. Empty/unset = no-op. Failure
# must not block the harness.
if [ -n "${SKILLS_JSON:-}" ]; then
  mkdir -p "$HOME/.claude/skills"
  printf '%s' "$SKILLS_JSON" | node -e '
    let raw = "";
    process.stdin.on("data", c => raw += c);
    process.stdin.on("end", () => {
      try {
        const skills = JSON.parse(raw);
        const fs = require("fs"), path = require("path");
        const root = path.join(process.env.HOME, ".claude", "skills");
        for (const { slug, content } of skills) {
          if (!slug || typeof content !== "string") continue;
          const dir = path.join(root, slug);
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, "SKILL.md"), content);
        }
        console.log("[entrypoint] hydrated " + skills.length + " skill(s)");
      } catch (e) {
        console.error("[entrypoint] WARNING: SKILLS_JSON parse failed:", e.message);
      }
    });
  ' || echo "[entrypoint] WARNING: skill hydration failed; continuing"
fi

# Last point before `exec` replaces this process — there's no opportunity
# to report after the server takes over.
report_phase harness_listening

# Hand off to the Node server. The server reads ANTHROPIC_BASE_URL +
# ANTHROPIC_AUTH_TOKEN from the LITELLM_* values at boot.
exec node /opt/harnesses/claude-agent-sdk/dist/server.js
