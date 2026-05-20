# `@berriai/lap-cli`

Command-line client for the LiteLLM Agent Platform. Spins up a managed
sandbox and attaches your local terminal — no browser, no portal, no
copy-pasting URLs.

Two interaction modes are picked automatically based on the agent's harness:

| Harness | Mode | Experience |
|---|---|---|
| `claude-code`, `codex`, `hermes`, `gemini` | **TTY** | Full interactive terminal over WebSocket PTY — same feel as `ssh` |
| `claude-agent-sdk`, `opencode` | **Chat REPL** | Line-by-line chat via HTTP JSON message API |

### TTY example

```
~/code/payments $ lap refactor-bot
  ✓ agent refactor-bot (ac70ab02, harness=claude-code)
  ✓ session 8c12262c
  waiting for sandbox. ready
  → attaching local TTY to ws://54.174.239.129:32011/tty

╭───────────────────────────────────────────────────────╮
│   ✻ Welcome to Claude Code                            │
│   cwd:  /work/repo  (acme/payments @ main)            │
│   model: claude-sonnet-4-5  (via LiteLLM gateway)     │
╰───────────────────────────────────────────────────────╯
›
```

### Chat REPL example

```
~/code $ lap my-sdk-agent
  ✓ agent my-sdk-agent (0f21c021, harness=claude-agent-sdk)
  ✓ session c3970704
  waiting for sandbox. ready
  Chat mode — Ctrl-D to exit

  > List the files in /work/repo
  Here are the files in /work/repo:
  - README.md
  - src/
  - ...

  >
```

## Install

```bash
git clone https://github.com/BerriAI/litellm-agent-platform.git
cd litellm-agent-platform/cli
npm install
chmod +x bin/lap.mjs
ln -sf "$PWD/bin/lap.mjs" ~/.local/bin/lap
```

## First run

```bash
lap login
#   Agent platform URL: https://lap.acme.dev
#   Master key:         ••••••••••••••••
#   ✓ saved to ~/.lap/config.json
```

Config is written to `~/.lap/config.json` with mode `0600`.

## Usage

```bash
lap <agent-name>              # open a sandbox (TTY or chat, detected automatically)
lap --agent <name>            # same as above (flag form)
lap --resume <session-id>     # reattach to an existing session
lap agents                    # list agents ([tui] = TTY harness)
lap config                    # show current config
lap logout                    # delete config
```

The agent name accepts either a human name or a UUID.

Press **Ctrl-D** in an attached TTY session to detach. Press **Ctrl-D** in
chat REPL to end. Remote sessions stay alive (idle reaper kicks in after 24h).

## How it works

### TTY mode

```
your terminal      lap CLI                LAP API           harness pod
──────────────     ───────                ───────           ───────────
(local PTY)        POST /agents/:id/session ────────────►   spawned
                                                            with auth token
                   poll until status=ready
                   read tty_url + tty_token from response

                   WS upgrade  ws://<tty_url>
                   Authorization: Bearer <tty_token>
(raw mode) ◄───►   WebSocket bytes ◄────────────────────► PTY → claude/codex
```

### Chat REPL mode

```
your terminal      lap CLI                LAP API           harness pod
──────────────     ───────                ───────           ───────────
                   POST /agents/:id/session ────────────►   spawned

                   poll until status=ready

  user input ────► POST /sessions/:id/message ──────────► harness HTTP API
  response  ◄────  200 { parts: [{type:"text", text:"…"}] }
```

## Configuration

| File / env var | Purpose |
|---|---|
| `~/.lap/config.json` | base URL + master key, set by `lap login` |
| `LAP_TTY_TOKEN` | override the harness bearer token (normally read from `session.tty_token`) |
| `LAP_TTY_FALLBACK` | fallback WS URL when the platform returns an in-cluster `sandbox_url` |

## Security (TTY mode)

The harness pod's `/tty` WebSocket requires a bearer token matching
`HARNESS_AUTH_TOKEN` on the pod. The CLI obtains it from
`session.tty_token` in the API response and presents it as an
`Authorization: Bearer <token>` header on the WebSocket upgrade
handshake — **not** in the URL query string — so the token never appears
in ingress, proxy, or load-balancer access logs that record the request
line.

(The harness also accepts `?token=…` as a fallback because browsers
cannot set arbitrary headers on `new WebSocket(...)`. The CLI always
uses the header form.)

## Source

[`github.com/BerriAI/litellm-agent-platform/cli`](https://github.com/BerriAI/litellm-agent-platform/tree/main/cli)
