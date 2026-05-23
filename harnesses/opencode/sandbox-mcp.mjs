#!/usr/bin/env node
/**
 * Standalone stdio MCP server exposing `provision` + `execute` sandbox tools
 * for the opencode harness.
 *
 * Why standalone (vs claude-agent-sdk's in-process buildSandboxMcpServer):
 * opencode runs as a shared `opencode serve` process configured by a static
 * opencode.json — there's no per-session hook to inject an in-process MCP with
 * a baked-in LAP session_id. So this MCP talks to E2B directly (the same SDK
 * the platform's E2bProvider uses) and keeps an in-process name→sandboxId map.
 * The agent sees the exact same two tools as claude-code-inline:
 *   provision(name, project_id) -> spins up a sandbox labelled `name`
 *   execute(sandbox_name, cmd)  -> runs a shell command in that sandbox
 *
 * Requires E2B_API_KEY. E2B_TEMPLATE defaults to "base".
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Sandbox } from "e2b";

const API_KEY = process.env.E2B_API_KEY;
const TEMPLATE = process.env.E2B_TEMPLATE || "base";
const EXECUTE_TIMEOUT_MS = Number(process.env.SANDBOX_EXECUTE_TIMEOUT_MS) || 120_000;
// E2B auto-kills the sandbox after this idle window. Bounds the cost of any
// leaked VM (e.g. a name reused across sessions, or a crash before cleanup).
const SANDBOX_TIMEOUT_MS = Number(process.env.SANDBOX_TIMEOUT_MS) || 900_000;

// label -> e2b sandboxId, so execute() can reconnect by the name provision()
// used. NOTE: this Map is process-wide. opencode runs one shared `opencode
// serve` across all sessions, and a stdio MCP has no per-session context, so
// sandbox names share a single namespace. Reusing a name kills the previous
// sandbox (see provision) to avoid leaking it.
const sandboxes = new Map();

async function killSandbox(id) {
  try {
    await Sandbox.kill(id, { apiKey: API_KEY });
  } catch (err) {
    console.error(`[sandbox-mcp] kill ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Best-effort cleanup so we don't leave billed VMs running when the harness
// shuts down (deploy, scale-down, crash).
let cleaningUp = false;
async function cleanupAll() {
  if (cleaningUp) return;
  cleaningUp = true;
  await Promise.all([...sandboxes.values()].map(killSandbox));
  sandboxes.clear();
}
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    cleanupAll().finally(() => process.exit(0));
  });
}

const server = new Server(
  { name: "opencode-sandbox", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

const TOOLS = [
  {
    name: "provision",
    description:
      "Provision a new sandbox environment. Returns a confirmation message when the sandbox is ready. Use the chosen name as sandbox_name in subsequent execute() calls.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Label for the sandbox — used in subsequent execute() calls as sandbox_name",
        },
        project_id: {
          type: "string",
          description: "ID of the project template (informational for E2B sandboxes)",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "execute",
    description:
      "Execute a shell command inside a provisioned sandbox. Returns the command output.",
    inputSchema: {
      type: "object",
      properties: {
        sandbox_name: {
          type: "string",
          description: "Label of the provisioned sandbox to run the command in",
        },
        cmd: { type: "string", description: "Shell command to execute inside the sandbox" },
      },
      required: ["sandbox_name", "cmd"],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

function textResult(text, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

async function provision({ name, project_id }) {
  if (!API_KEY) return textResult("provision failed: E2B_API_KEY not set", true);
  if (!name) return textResult("provision failed: name is required", true);
  // Reusing a name replaces the old sandbox — kill it first so it isn't leaked.
  const existing = sandboxes.get(name);
  if (existing) await killSandbox(existing);
  try {
    const sandbox = await Sandbox.create(TEMPLATE, {
      apiKey: API_KEY,
      timeoutMs: SANDBOX_TIMEOUT_MS,
    });
    sandboxes.set(name, sandbox.sandboxId);
    return textResult(
      `sandbox "${name}" provisioned (e2b ${sandbox.sandboxId}, template ${TEMPLATE})`,
    );
  } catch (err) {
    return textResult(`provision error: ${err instanceof Error ? err.message : String(err)}`, true);
  }
}

async function execute({ sandbox_name, cmd }) {
  if (!API_KEY) return textResult("execute failed: E2B_API_KEY not set", true);
  const id = sandboxes.get(sandbox_name);
  if (!id) {
    return textResult(
      `execute failed: no sandbox named "${sandbox_name}" — call provision() first`,
      true,
    );
  }
  try {
    const sandbox = await Sandbox.connect(id, { apiKey: API_KEY });
    const result = await sandbox.commands.run(cmd, { timeoutMs: EXECUTE_TIMEOUT_MS });
    const out = (result.stdout ?? "") + (result.stderr ?? "");
    const code = result.exitCode ?? 0;
    // A non-zero exit is a failed command — surface it so the agent doesn't
    // treat compiler/test/missing-file errors as success.
    return code === 0
      ? textResult(out)
      : textResult(`${out}\n[command exited with code ${code}]`, true);
  } catch (err) {
    // Some e2b SDK versions throw CommandExitError on non-zero exit instead of
    // returning a result — that error still carries stdout/stderr/exitCode.
    const e = err && typeof err === "object" ? err : {};
    const out = (e.stdout ?? "") + (e.stderr ?? "");
    const msg = err instanceof Error ? err.message : String(err);
    return textResult(out ? `${out}\n[command failed: ${msg}]` : `execute error: ${msg}`, true);
  }
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (name === "provision") return provision(args ?? {});
  if (name === "execute") return execute(args ?? {});
  return textResult(`unknown tool: ${name}`, true);
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `[sandbox-mcp] ready (template=${TEMPLATE}, e2b_key=${API_KEY ? "set" : "MISSING"})`,
);
