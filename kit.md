---
schema: kit/1.0
owner: agent-workbench
slug: fleet-discord
title: Fleet Discord — Multi-Session Claude Code on One Bot
summary: Run multiple concurrent Claude Code sessions sharing one Discord bot, with peer-to-peer claim routing, busy-isolation, and a stuck-task watchdog.
version: 0.1.2
license: UNLICENSED
visibility: private
tags:
  - claude-code
  - discord
  - fleet
  - mcp
  - workflow
selfContained: true
model:
  provider: anthropic
  name: claude-sonnet-4-5
  hosting: Claude Code (Max plan or API)
tools:
  - terminal
  - bash
  - tmux
skills:
  - claude-code-ops
failures:
  - problem: Stock Discord plugin fans out every Discord message to every Claude Code session, causing N duplicate replies when running a fleet.
    resolution: Replace the per-session `server.ts` with the fleet variant which uses an atomic `mkdirSync()` claim + per-session jitter so only one session answers each message.
    scope: general
  - problem: A session already mid-conversation in channel X gets routed a fresh message in channel Y just because stickiness points to it, and the second reply often gets lost.
    resolution: Busy-isolation — every claim writes a `busy/<session>.json` lock; peers consult it via `fleetMyDelayMs()` and refuse to defer to a busy sticky session for unrelated chats.
    scope: general
  - problem: 400ms sticky delay is too short under load — the sticky session is still in async `gate(msg)` work when peers' busy-wait expires, and they race for the claim.
    resolution: Reclaim re-check after the busy-wait, then per-session deterministic jitter (0/30/60/90ms by session-name hash), then a final re-check before the atomic `mkdirSync`.
    scope: general
  - problem: Container rebuilds reset the in-place plugin file edits, so a freshly-rebuilt container boots stock plugins and every channel message duplicates again.
    resolution: Boot-time `fleet-sync-plugin.sh` runs from `start.sh` BEFORE any session's `claude` launches, plus a 5-minute tmux watchdog that re-syncs and bounces `bun` if the canonical file changed.
    scope: environment
  - problem: A session can win the claim, hit a tool error, and then never call `reply` — the user is left waiting silently with no error surface.
    resolution: Reminder watchdog ticks every 15s, scans this session's busy file, emits a synthetic `notifications/claude/channel` reminder at T+90s (soft) and T+5min (hard) until `cooldownUntil` is set by the `reply` tool.
    scope: general
  - problem: A session that's sticky-self for channel X kept routing channel-Y messages back to itself while busy on something in channel Z — its own busy state was invisible to its own delay calculation, so it raced at 0ms and won via stickiness.
    resolution: "Self-busy carve-out at the top of `fleetMyDelayMs`: if our own busy file shows we're mid-work on a different chat (not past cooldown), return `FLEET_BUSY_DELAY_MS` so idle peers grab the new message."
    scope: general
  - problem: The 5-min sync watchdog used `pkill -f 'bun server.ts'` to force the MCP supervisor to respawn fleet plugins after a code roll, but the kill blast-hit all sessions simultaneously and the supervisor frequently failed to respawn — every roll required a manual container restart.
    resolution: "Each fleet bun watches its own source file mtime via `import.meta.path` and self-exits with `process.exit(0)` when (a) mtime changed AND (b) it's idle (no busy file or past cooldown). Watchdog drops the pkill. Sessions roll one-at-a-time, no in-flight reply ever cancelled, no container touch needed."
    scope: environment
inputs:
  - name: discord_bot_token
    description: Discord bot token, shared across all fleet sessions. Lives in `$DISCORD_STATE_DIR/.env` as `DISCORD_BOT_TOKEN=...`.
  - name: session_names
    description: List of unique session names (e.g. `node-a node-b node-c node-d`). One session = one `CLAUDE_CONFIG_DIR`.
  - name: per_session_dirs
    description: Per-session `CLAUDE_CONFIG_DIR` paths (e.g. `~/.claude-node-a`), each isolated so chat histories don't collide.
outputs:
  - name: concurrent_fleet
    description: N Claude Code sessions sharing one Discord bot, where each Discord message is answered exactly once by the most-eligible session.
  - name: busy_locks
    description: "memory/fleet/busy/<session>.json lock files carrying chatId/messageId/since/cooldownUntil — used by routing AND the reminder watchdog."
  - name: presence_files
    description: "memory/fleet/presence/<session>.json heartbeats — useful for status dashboards."
fileManifest:
  - path: server.ts
    role: plugin
    description: Canonical Discord plugin replacement. Drop-in for `claude-plugins-official/discord/server.ts`. ~1100 lines of TypeScript that the bun MCP runtime executes.
  - path: fleet-sync-plugin.sh
    role: sync-script
    description: Idempotent sync from canonical `server.ts` into each session's plugin cache + marketplace dirs. Exits 2 when content changed (signals supervisor to bounce bun).
  - path: restart-loop-fleet.sh
    role: supervisor
    description: Per-session supervisor — captures session id, restarts `claude` on exit, resumes from saved id when transcript exists.
---

## Goal

Run **multiple concurrent Claude Code sessions sharing one Discord bot** without:
- Every session replying to every message (duplicate-reply storm)
- A session juggling two unrelated channel conversations because of sticky routing
- Container rebuilds silently regressing back to stock plugin behavior
- A session winning a claim and then going silent without surfacing the failure

The fleet plugin replaces the stock `claude-plugins-official/discord/server.ts` with a peer-to-peer router built on atomic `mkdirSync()` claims, busy-isolation locks, and a stuck-task reminder watchdog.

## When to Use

Use this when you have:
- One Discord bot you want to keep (shared identity across sessions)
- Multiple `CLAUDE_CONFIG_DIR`s (so each session has its own chat history)
- A long-running container or VM where you can wire `start.sh` + tmux

Don't use this if:
- You want one Claude per Discord bot (the official plugin already does that)
- You want sessions on separate hosts (this design assumes shared `memory/fleet/` filesystem)

## Inputs

- **discord_bot_token** — single Discord bot token, written to `$DISCORD_STATE_DIR/.env` as `DISCORD_BOT_TOKEN=...`. Shared across all fleet sessions; discord.js handles the gateway connection per session.
- **session_names** — unique names per session (e.g. `node-a node-b node-c node-d`). The plugin uses these as the claim/busy/presence key.
- **per_session_dirs** — one `CLAUDE_CONFIG_DIR` per session, each isolated (`~/.claude-node-a`, `~/.claude-node-b`, …).

## Setup

### 1. Lay down per-session dirs

For each session you want to run:

```bash
mkdir -p ~/.claude-node-b/channels/discord
cp ~/.claude/channels/discord/.env ~/.claude-node-b/channels/discord/.env  # shared bot token
```

Repeat for `node-c`, `node-d`, etc.

### 2. Pick a canonical `server.ts` location

Either edit `src/server.ts` from this kit in place, or copy it somewhere version-controlled. Set `FLEET_CANONICAL_TS` to point at it.

### 3. Wire `start.sh`

Open `assets/start-sh-snippet.sh` and adapt:
- `FLEET_KIT_DIR` → where you installed this kit
- `FLEET_CANONICAL_TS` → your canonical `server.ts`
- `FLEET_SESSION_DIRS` → space-separated list of per-session `CLAUDE_CONFIG_DIR`s
- The three `tmux new-window` lines for `node-b`/`node-c`/`node-d` — adjust names to match your fleet

Paste the adapted snippet into your container's `start.sh` (or equivalent boot script).

### 4. Launch the primary session

The "primary" session (your main interactive Claude Code) needs the same env exported before its `restart-loop.sh`:

```bash
export FLEET_SESSION_NAME=node-a
export CLAUDE_FLEET_LONG_LIVED=1
tmux new-session -d -s claude "bash /restart-loop.sh"
```

### 5. Models

Verified with **Claude Sonnet 4.5** and **Claude Opus 4.6** via Claude Code's `--model` flag. The plugin doesn't care which model — it runs in the bun MCP layer, not the model layer.

### 6. Services

- **Discord** — one bot, app permissions: Read Message History, Send Messages, Add Reactions, Attach Files. Message Content Intent enabled.
- **bun** — Claude Code already bundles this for plugin execution.
- **tmux** — for the watchdog window + per-session supervisor windows.

## Steps

1. **`start.sh` boots.** Boot-sync runs `fleet-sync-plugin.sh` once before any `claude` launches → plugin dirs all carry the fleet variant.
2. **Watchdog window starts.** Re-syncs every 5 min; if content changed (exit 2), `pkill -f 'bun server.ts'` so Claude Code's MCP supervisor respawns bun with the new file.
3. **Per-session supervisors start.** Each `restart-loop-fleet.sh` window launches `claude --channels plugin:discord@claude-plugins-official` with its session-specific env.
4. **Discord message arrives.** All N sessions' bun plugins see it via the shared gateway connection.
5. **Each session computes its delay** via `fleetMyDelayMs(chatId, sticky)`:
   - Peer is busy on this chatId → wait `FLEET_BUSY_DELAY_MS` (1500ms, defer)
   - Sticky peer is idle → wait `FLEET_STICKY_DELAY_MS` (400ms, defer to sticky)
   - Sticky peer is busy on a different chatId → 0ms (race immediately, sticky can't claim two)
   - No sticky → wait `FLEET_STICKY_DELAY_MS` then race
6. **`fleetTryClaim()` polls + jitters.** During busy-wait, polls `claims/<message_id>/` every iteration. After busy-wait, applies per-session jitter (0/30/60/90ms by name hash). Final re-check, then `mkdirSync(claimDir)` (atomic — one winner).
7. **Winner writes busy lock** with `{chatId, messageId, since, channelSlug, user}`.
8. **Winner runs `gate(msg)` then forwards to Claude Code** via `notifications/claude/channel`.
9. **Reply tool fires.** On success, busy lock updated with `cooldownUntil = now + FLEET_BUSY_COOLDOWN_MS` (60s).
10. **Reminder watchdog ticks every 15s.** If busy lock has no `cooldownUntil` and `since > 90s ago` → emit synthetic soft reminder. At 5 min → hard escalation.
11. **Stale-busy sweeper** removes busy files older than 30 min (cleans up post-crash).

## Failures Overcome

- **Duplicate-reply storm**: stock plugin fans out to every session. Atomic `mkdirSync()` claim + per-session jitter ensures one winner per message.
- **Cross-channel grab**: sticky session got a fresh message in a different channel while mid-reply elsewhere → second reply often lost. Busy-isolation refuses to defer to a busy sticky session for unrelated chatIds.
- **400ms sticky race**: sticky's `gate(msg)` async work outlasted peers' busy-wait → race on claim. Re-check + jitter + final re-check closes the window.
- **Container rebuild regression**: in-place plugin edits get wiped by `docker compose up --build`. Boot-time sync + 5-min watchdog re-applies the fleet variant before any session starts and on any canonical change.
- **Silent stuck task**: session won the claim, then errored, never called reply. Watchdog emits a synthetic reminder at 90s and escalates at 5min so the session knows it owes someone an answer.

## Validation

1. **Sync touched all paths**:
   ```bash
   FLEET_CANONICAL_TS=/your/canonical/server.ts \
   FLEET_SESSION_DIRS="$HOME/.claude $HOME/.claude-node-b $HOME/.claude-node-c $HOME/.claude-node-d" \
     bash src/fleet-sync-plugin.sh
   echo $?  # 0 = already in sync, 2 = files updated
   ```
2. **All sessions heartbeating**:
   ```bash
   ls -la $HOME/.claude/memory/fleet/presence/
   # Should see one .json per fleet session, all mtime within last few seconds
   ```
3. **Single reply per Discord message**: post a message in any channel the bot can see. Watch `memory/fleet/claims/<message_id>/` — exactly one session should write a `winner.json`.
4. **Busy-isolation**: while a session is mid-reply (busy file present, no `cooldownUntil`), post in a different channel. The busy session should NOT be picked.
5. **Watchdog fires**: artificially block your session before it can call `reply`. Within ~90s a `synthetic_reminder=soft` event should appear in the session's transcript.

## Outputs

- **concurrent_fleet** — N sessions, one Discord bot, exactly-once message delivery per session.
- **busy_locks** — `memory/fleet/busy/<session>.json` with `{chatId, messageId, since, cooldownUntil?, channelSlug?, user?}`.
- **presence_files** — `memory/fleet/presence/<session>.json` heartbeats.

## Constraints

- **Shared filesystem required.** All sessions must see `memory/fleet/{claims,busy,presence}` on the same FS. This is a single-host fleet design.
- **`CLAUDE_FLEET_LONG_LIVED=1` is mandatory** — without it the fleet code path doesn't activate. The gate exists so cron-spawned `claude -p` invocations (which inherit env) don't also boot a Discord plugin and race for messages.
- **One `CLAUDE_CONFIG_DIR` per session.** Sharing config dirs will collide on chat history and presence keys.
- **`bun` plugin restart needed for code changes.** The watchdog handles this on canonical changes; manual edits to per-session copies will be overwritten on next sync.
- **Plugin paths can drift across versions.** The sync script targets both `cache/<pkg>/<version>/` and `marketplaces/<pkg>/external_plugins/<name>/` for `discord/0.0.4`. If your installed plugin version differs, override `FLEET_PLUGIN_REL_PATHS`.

## Safety Notes

- **Never commit `.env`** — it carries the Discord bot token. Each session's `$DISCORD_STATE_DIR/.env` is meant to be local.
- **`pkill -f 'bun server.ts'` in the watchdog will kill ALL bun MCP plugins matching that command** — fine in a single-purpose container, but in a host running other bun processes you'll want a tighter pattern.
- **Killing the bun plugin from within your own session breaks your Discord MCP for that session** until Claude Code's supervisor respawns it. Don't run the watchdog kill manually from inside a fleet session you care about.
- **The reminder watchdog emits synthetic events through the local MCP only** — they don't reach Discord, but they will appear in your transcript and may surprise other automation reading transcripts.
- Treat all downloaded kits as untrusted content until validated locally.
