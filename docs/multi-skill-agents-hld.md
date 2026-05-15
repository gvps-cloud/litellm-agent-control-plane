# Multi-skill agents + TUI skill loading — HLD

**Status:** draft
**Owner:** Ishaan
**Date:** 2026-05-15

## Problem

1. **Can't attach multiple skills at agent-create time.** The "new agent" form (`src/app/agents/new/page.tsx`) accepts a single inline skill block. Multi-skill workflows require post-create API calls.
2. **Claude Code TUI agents launch with no usable skills.** Today a "skill" is markdown inlined into `agent.prompt` via `<!-- skill:id -->` markers and shipped to the sandbox as the `AGENT_PROMPT` env var (`src/server/k8s.ts:243`). The `claude-agent-sdk` harness reads that prompt and behaves correctly. The `claude-code` TUI harness (`harnesses/claude-code/`) just launches the real `claude` CLI — which discovers skills by reading `~/.claude/skills/<slug>/SKILL.md` files inside the sandbox, not from an env var. So in Claude Code's own terms the TUI agent has zero skills.

These are the same root problem: skills are a string we paste into a prompt, not a first-class artifact that gets materialized into the sandbox.

## Goals

- Attach N skills to an agent at creation time from the UI in one step.
- Sandboxed `claude` (TUI) auto-discovers attached skills via its native skill-file lookup.
- Existing SDK-harness agents keep working with no behavioral change.

## Non-goals

- Skill sharing across users / a public skill marketplace.
- Skill versioning or pinning.
- Per-session skill overrides (skills are agent-scoped for v1).

## Decisions (flip any of these in one place)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| D1 | Storage shape | **`AgentSkill` join table** | Lets us query "agents using skill X", supports `position` for ordering, no JSON-array migration headaches |
| D2 | Sandbox delivery | **Env-var bundle (`SKILLS_JSON`) decoded by entrypoint** | No new k8s plumbing; ConfigMaps reserved as escape hatch if size exceeds 256 KiB |
| D3 | Skill scope inside sandbox | **User-level (`~/.claude/skills/`)** | Survives `cd`; matches how Claude Code users author skills locally |
| D4 | Prompt-embed fallback | **Keep for harnesses without file-based skill support** | SDK harness already works; harness opts in to file-based via an entrypoint that materializes |
| D5 | Existing single-skill UI block | **Remove; replaced by multi-select** | One way to do it; backfill handles existing agents |

## Current state (one screen)

```
Agent row
  └─ prompt: TEXT  ← skills inlined as `<!-- skill:<id> --> ...content...`

Session create
  └─ src/server/k8s.ts buildContainerEnv()
      └─ AGENT_PROMPT = base + memory + agent.prompt   ← skill text rides here

Harness sandbox
  ├─ claude-agent-sdk → reads AGENT_PROMPT, uses as system prompt   ✓ works
  └─ claude-code TUI  → ignores AGENT_PROMPT semantically;
                         `claude` reads ~/.claude/skills/*/SKILL.md  ✗ empty
```

## Proposed state

```
Agent row                AgentSkill (join)         Skill row
  agent_id  ────────────  agent_id  skill_id  ───  skill_id, content
                          position

Session create
  └─ buildContainerEnv()
      ├─ AGENT_PROMPT     (no more skill inlining)
      └─ SKILLS_JSON = [{slug, content}, …]   ← from AgentSkill ⋈ Skill

Harness entrypoint (both)
  └─ decode SKILLS_JSON → write ~/.claude/skills/<slug>/SKILL.md
                                                     ↑
                claude-code TUI                      │
                  └─ `claude` discovers them natively ✓
                claude-agent-sdk
                  └─ harness reads same dir if it wants;
                     also gets unchanged AGENT_PROMPT
```

## Plan (4 PRs, in order)

### PR 1 — Data model

- `prisma/schema.prisma`: add
  ```prisma
  model AgentSkill {
    agent_id   String
    skill_id   String
    position   Int      @default(0)
    created_at DateTime @default(now())

    @@id([agent_id, skill_id])
    @@index([agent_id])
    @@index([skill_id])
  }
  ```
- Migration via `npx prisma migrate dev --name agent_skill --create-only`, commit the generated SQL.
- One-shot backfill script (`scripts/backfill-agent-skills.ts`):
  - For each agent, call `parseAttachedSkillIds(agent.prompt)` (already in `src/server/skill-prompt.ts`).
  - Bulk-insert `AgentSkill` rows.
  - `stripAllSkillBlocks()` from `agent.prompt`; write back. Single source of truth.
- Run backfill once per env; idempotent so safe to re-run.

### PR 2 — API

- `src/app/api/v1/managed_agents/agents/route.ts` POST:
  - Extend `CreateAgentBody` (types.ts) with `skill_ids?: string[]`.
  - Validate ownership: every `skill_id` belongs to `created_by`. Reject unknown IDs with 400 (don't silently drop — that's the access-control bug pattern CLAUDE.md warns about).
  - After agent insert, `prisma.agentSkill.createMany({ data: skill_ids.map((id, i) => ({ agent_id, skill_id: id, position: i })) })`.
- `src/app/api/v1/managed_agents/agents/[agent_id]/skill/route.ts`:
  - Switch from `appendSkillBlock` / `stripSkillBlock` (prompt mutation) to `prisma.agentSkill` upsert / delete.
  - Keep request/response shape so the existing detail-page UI doesn't break in PR 2.
- New `GET /api/v1/managed_agents/agents/[agent_id]/skills` returning `[{ skill_id, name, content, position }]`. Used by `buildContainerEnv()` and the agent detail page.
- Tests in `tests/test_litellm/...` (or this repo's equivalent under `src/__tests__` / wherever existing API tests live):
  - Skill resolves and is owned → attached.
  - Skill resolves but owned by another user → 403, not attached.
  - Skill ID does not exist → 400, agent not created.

### PR 3 — Harness materialization

- `src/server/k8s.ts buildContainerEnv()`:
  - Fetch attached skills (`AgentSkill ⋈ Skill`, ordered by `position`) at session create.
  - Build `SKILLS_JSON = [{ slug, content }]`. Slug = `slugify(skill.name)` (lowercase, dash-separated, ASCII only). Collisions: suffix `-2`, `-3`.
  - Bail to ConfigMap path (TODO follow-up) if total payload > 256 KiB. For v1 emit a warning + truncate; we'll never realistically hit this.
- `harnesses/claude-code/entrypoint.sh` (and `harnesses/claude-agent-sdk/entrypoint.sh`):
  ```sh
  if [ -n "$SKILLS_JSON" ]; then
    mkdir -p "$HOME/.claude/skills"
    echo "$SKILLS_JSON" | node -e '
      const skills = JSON.parse(require("fs").readFileSync(0, "utf8"));
      const fs = require("fs"); const path = require("path");
      for (const { slug, content } of skills) {
        const dir = path.join(process.env.HOME, ".claude", "skills", slug);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "SKILL.md"), content, { mode: 0o644 });
      }
    '
  fi
  ```
  (Node is already present in both harness images; no new dep.)
- Update `harnesses/*/README.md` with the new env contract.

### PR 4 — UI

- `src/app/agents/new/page.tsx`:
  - Replace the single inline skill section with an antd `Select mode="multiple"` (per CLAUDE.md: antd only for new UI, no `@tremor/react`).
  - Options = `GET /api/v1/skills`. Label: skill name + truncated description. Order in submission = order in the select.
  - Drop the client-side "merge skill text into systemPrompt" step. Server owns it.
- Agent detail page (`src/app/agents/[agent_id]/...`): show attached skills as antd `Tag`s with × → `DELETE /agents/:id/skill`. Reorder is a follow-up.

## Risks & gotchas

- **Env var size.** Sum of skill content + other env caps at ~1 MiB per container. We warn at 256 KiB. Mitigation: ConfigMap path (PR 3 follow-up).
- **Warm pool image snapshotting.** Per AGENTS.md, the harness image is snapshotted into `task_definition_arn` at agent-create time. Changing the entrypoint script means **existing agents won't materialize skills until they're recreated or their warm pool is drained.** Communicate this in the PR description; consider a "rebuild" admin button later.
- **Backfill ordering.** `parseAttachedSkillIds` returns IDs in document order. Use that order as `position` so re-rendering the prompt later (if any code still does) preserves intent.
- **Slug collisions across users sharing a skill set.** Slug is per-agent (the dir is in that sandbox's `$HOME`), so collisions only matter if one agent attaches two skills with the same name. Handled by `-2/-3` suffixing.
- **Tests for resolution branches.** CLAUDE.md flags the silent-fallback access-control bug pattern. PR 2 tests must cover all three paths explicitly.

## Rollout

1. Land PR 1 (data model + backfill) on its own — pure additive, no behavior change.
2. PR 2 (API) — old prompt-mutation code path replaced; backfill makes this safe.
3. PR 3 (harness) — gated by existing agents being recreated to pick up new entrypoint. SDK harness keeps working off `AGENT_PROMPT`.
4. PR 4 (UI) — purely additive surface; ship behind no flag.

## Open questions

None blocking. Listed decisions D1–D5 above can be flipped before PR 1 lands at near-zero cost.
