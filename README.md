# LiteLLM Agent Platform

Self-hosted control plane for sandboxed coding agents. An agent is a `(model, prompt, repo)` spec; spawning a session boots a fresh AWS Fargate task running the [opencode](https://opencode.ai) harness against that repo. Models route through a [LiteLLM](https://github.com/BerriAI/litellm) gateway. One Next.js app + a sidecar reconciler — no second service.

## 1. Create an Agent

<img width="1164" height="720" alt="split1" src="https://github.com/user-attachments/assets/2c4371a3-dc4b-4ca0-a1a8-a09006ac3314" />

## 2. Use your Agent on the UI

<img width="1164" height="720" alt="d7" src="https://github.com/user-attachments/assets/a39e1d74-9fd1-4db9-b090-9bffc49b09d5" />

---

## For platform admins

Prereqs: Docker Desktop, AWS account with default VPC, Postgres, a LiteLLM gateway, Node 20+.

Install:

```bash
git clone https://github.com/BerriAI/litellm-agent-platform
cd litellm-agent-platform
npm install
cp .env.example .env
```

Fill in `.env`. Required: `DATABASE_URL`, `MASTER_KEY` (≥ 8 chars; users sign in with this), `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `LITELLM_API_BASE`, `LITELLM_API_KEY`. Leave the four `AWS_TASK_DEFINITION_ARN` / `AWS_SUBNETS` / `AWS_SECURITY_GROUP` / `OPENCODE_IMAGE_URI` lines blank.

Provision AWS:

```bash
./setup.sh
```

Idempotent. Creates ECR repo, builds + pushes `harnesses/opencode/Dockerfile` (`linux/amd64`), creates IAM role + log group + ECS cluster, finds a public subnet, opens port 4096, registers a Fargate task definition. Prints four env values — paste them into `.env`.

Migrate + run:

```bash
npx prisma db push
npm run dev       # :3000
npm run worker    # reconciler, 60s tick
```

Open `http://localhost:3000`, sign in at `/login`.

### Container env passthrough

Anything in `.env` prefixed `CONTAINER_ENV_` is injected into every Fargate container with the prefix stripped:

```bash
CONTAINER_ENV_GITHUB_TOKEN=ghp_...   # container sees GITHUB_TOKEN=ghp_...
```

### Cost + cleanup

A `ready` Fargate task runs ~$0.04/hr (0.5 vCPU + 1 GB). The reconciler kills idle sessions at 24h, capping a forgotten session at ~$1. Every `RECONCILE_INTERVAL_SECONDS`:

- Orphan tasks (no row, or row `dead/failed/stopped`) → `StopTask`. 5min grace.
- Sessions stuck `creating` > 10min → marked failed.
- Sessions in `ready` with `last_seen_at` > 24h → killed.

Manual stop: `DELETE /api/v1/managed_agents/sessions/{id}`.

### Custom harness

Drop a Dockerfile in `harnesses/<id>/`, re-run `./setup.sh`. Container must expose `POST /session` and `POST /session/{id}/message` on `CONTAINER_PORT`. Env injected at session start:

| Env | Source |
| --- | --- |
| `REPO_URL` | agent `repo_url`, else `PREINSTALLED_GITHUB_REPO` |
| `BRANCH` | agent `branch` (default `main`) |
| `LITELLM_API_BASE` `LITELLM_API_KEY` | host env |
| `LITELLM_DEFAULT_MODEL` | agent `model` |
| `AGENT_PROMPT` | agent `prompt` |
| `PORT` | `CONTAINER_PORT` |
| `<X>` | every host `CONTAINER_ENV_<X>` |

---

## For developers

Auth: `Authorization: Bearer <MASTER_KEY>` on every request.

```bash
KEY=$MASTER_KEY
BASE=http://localhost:3000/api/v1/managed_agents

AGENT=$(curl -sX POST $BASE/agents \
  -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{
    "name":"code-reviewer",
    "model":"anthropic/claude-sonnet-4-6",
    "prompt":"Senior engineer reviewing for clarity and security.",
    "repo_url":"https://github.com/BerriAI/litellm"
  }' | jq -r .id)

SESSION=$(curl -sX POST $BASE/agents/$AGENT/session \
  -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"title":"smoke"}' | jq -r .id)   # ~50–120s cold

curl -sX POST $BASE/sessions/$SESSION/message \
  -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"text":"What does this repo do? One sentence."}'

curl -sX DELETE $BASE/sessions/$SESSION -H "Authorization: Bearer $KEY"
```

TypeScript:

```ts
const KEY = process.env.MASTER_KEY!;
const BASE = "http://localhost:3000/api/v1/managed_agents";
const h = { "Authorization": `Bearer ${KEY}`, "content-type": "application/json" };

const agent = await fetch(`${BASE}/agents`, {
  method: "POST", headers: h,
  body: JSON.stringify({
    model: "anthropic/claude-sonnet-4-6",
    repo_url: "https://github.com/BerriAI/litellm",
  }),
}).then(r => r.json());

const session = await fetch(`${BASE}/agents/${agent.id}/session`, {
  method: "POST", headers: h, body: "{}",
}).then(r => r.json());

const reply = await fetch(`${BASE}/sessions/${session.id}/message`, {
  method: "POST", headers: h,
  body: JSON.stringify({ text: "List the top-level directories." }),
}).then(r => r.json());

await fetch(`${BASE}/sessions/${session.id}`, { method: "DELETE", headers: h });
```

Body + response on `/sessions/{id}/message` are the [opencode HTTP API](https://github.com/sst/opencode) verbatim. Reuse a session across messages — `POST /agents/{id}/session` is the slow path.

### Endpoints

```
GET    /api/v1/managed_agents/dockerfiles            list harnesses
GET    /api/v1/managed_agents/agents                 list
POST   /api/v1/managed_agents/agents                 create
GET    /api/v1/managed_agents/agents/{id}            fetch
PATCH  /api/v1/managed_agents/agents/{id}            update
POST   /api/v1/managed_agents/agents/{id}/session    spawn (slow)
GET    /api/v1/managed_agents/sessions               list, ?agent_id= optional
GET    /api/v1/managed_agents/sessions/{id}          fetch
DELETE /api/v1/managed_agents/sessions/{id}          stop
POST   /api/v1/managed_agents/sessions/{id}/message  chat

# passthroughs to LITELLM_API_BASE
GET    /api/v1/models
GET    /api/v1/mcp/server
GET    /api/mcp-rest/tools/list?server_id=...
```
