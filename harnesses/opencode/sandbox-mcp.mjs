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

// label -> e2b sandboxId, so execute() can reconnect by the name provision() used.
const sandboxes = new Map();

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
  try {
    const sandbox = await Sandbox.create(TEMPLATE, { apiKey: API_KEY });
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
    return textResult((result.stdout ?? "") + (result.stderr ?? ""));
  } catch (err) {
    return textResult(`execute error: ${err instanceof Error ? err.message : String(err)}`, true);
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
