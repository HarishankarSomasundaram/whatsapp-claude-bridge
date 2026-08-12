# Technical deep-dive

Two layers. The transport is deliberately simple; the concurrency lives in the agent layer and the session pool.

## Layer 1 — transport (Node + Baileys)

- Links a spare WhatsApp account as a **linked device** ([Baileys](https://github.com/WhiskeySockets/Baileys)); one-time QR scan, credentials persisted under `./auth`.
- Every inbound message is checked against `WA_ALLOWED` (WhatsApp's per-contact **LID**, or a phone JID). The allowlist is the **only** authentication.
- The router classifies each message: instant shortcut, `sh` raw shell, a control word (`agents`, `use`, `reset`, `stop`), a coordinator command (`@all`/`broadcast`), or an agent turn (`@name …`, default `@main`).
- **IPv4:** WhatsApp's socket 408-times-out on hosts with broken IPv6 egress — run with `NODE_OPTIONS=--dns-result-order=ipv4first` (the systemd unit sets it).

## Layer 2 — the session pool (where parallel lives)

Each **named agent** is its own long-lived `claude` process in **stream-json** mode over stdin/stdout:

```
claude -p --input-format stream-json --output-format stream-json \
       --verbose --dangerously-skip-permissions --model <model>
```

- **Warm:** the process stays alive across turns, so there's **no per-message cold start** and each agent keeps its **own conversation context**.
- **Per-agent serialization:** turns within one agent run one-at-a-time through a promise chain — a single stdin pipe is one ordered channel, so interleaving would corrupt context. A per-agent watchdog (`TURN_TIMEOUT_MS`) restarts a stuck turn instead of blocking its queue.
- **Cross-agent parallelism:** different agents are independent processes with independent chains, so `@build …` and `@research …` run **concurrently**. The message handler dispatches without blocking (`ask(name, body).then(reply)`), so nothing serializes across agents.

```
ask(name, msg):
  s = pool[name] || spawn()      # lazily create a warm session
  s.chain = s.chain.then(() => writeTurn(s, msg))   # serialize within agent
  return thisTurnsResult          # but return immediately to the caller
```

## Two kinds of "multi-agent"

1. **Within one agent (automatic).** Because each session is full Claude Code, a *single* instruction can fan out: parallel tool calls, and the **Agent/Task tool** spawning independent sub-agents (each with its own context window) that run concurrently and are then synthesized — map-reduce for one message. You don't ask for it; the lead agent decides.
2. **Across agents (explicit, via this bridge).** You run a **team of named agents in parallel** and coordinate them:
   - `@build …`, `@research …` — separate concurrent workers, each with its own memory.
   - `@all <task>` / `broadcast <task>` — fan one instruction across **every active agent** in parallel (`Promise.all`), then a dedicated `coordinator` session **synthesizes one reconciled answer**, flagging disagreements.

So one WhatsApp thread drives a fleet of warm agents, each of which can itself fan out further.

## Command reference

| Command | Effect |
|---|---|
| `<plain text>` | Turn on `@main` (fans out sub-agents as needed) |
| `@<name> <task>` | Turn on a named agent (created on first use); agents run in parallel |
| `@all <task>` · `broadcast <task>` | Fan the task across all active agents, then merge via the coordinator |
| `agents` | List agents + model + state (idle/working/stopped) |
| `stop <name>` | Terminate an agent |
| `@<name> reset` · `reset` | Fresh context for that agent (`reset` = `@main`) |
| `use <model>` | Default model for **new** agents (`haiku`/`sonnet`/`opus`) |
| `@<name> use <model>` | Switch an existing agent's model (restarts it) |
| `sh <cmd>` | Raw shell, instant (skips Claude) |
| `gpu` · `disk` · `mem` · `uptime` | Instant exact-match shortcuts (edit `SHORTCUTS`) |
| `CONFIRM` | Approve a pending destructive shell command |
| `help` | Command list |

## Failure handling

- A crashed agent process is respawned on its next turn; an in-flight turn resolves with a notice.
- A turn exceeding `TURN_TIMEOUT_MS` restarts just that agent — other agents are unaffected.
- Bot replies are tracked by message id so the bridge never treats its own messages as commands.
