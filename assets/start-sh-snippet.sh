#!/bin/bash
# Drop-in snippet for your start.sh / boot script. Wires up:
#   1. boot-time sync of the canonical fleet server.ts into all session
#      plugin dirs (so a freshly-rebuilt container picks up your edits)
#   2. a 5-minute watchdog tmux window that re-runs the sync and bounces
#      the bun plugin processes whenever the canonical file changes
#   3. one fleet supervisor per session
#
# Adapt FLEET_KIT_DIR and the per-session env vars to your layout.
# Each fleet session needs its own CLAUDE_CONFIG_DIR; the DISCORD_BOT_TOKEN
# in DISCORD_STATE_DIR/.env is shared across sessions (one bot, many
# concurrent connections share the gateway via discord.js).

# Where you installed this kit. Adjust to your install path.
FLEET_KIT_DIR="$HOME/.claude/skills/fleet-discord"

# The canonical server.ts you want all sessions to run. Either keep editing
# it in place under FLEET_KIT_DIR/src/, or copy it somewhere you maintain
# in version control and point this at that.
export FLEET_CANONICAL_TS="$FLEET_KIT_DIR/src/server.ts"

# Space-separated list of all fleet sessions' CLAUDE_CONFIG_DIRs.
export FLEET_SESSION_DIRS="$HOME/.claude $HOME/.claude-node-b $HOME/.claude-node-c $HOME/.claude-node-d"

# 1) Boot sync — must happen BEFORE any fleet session's claude (and thus its
#    bun plugin) starts. Otherwise the first boot of a freshly-rebuilt
#    container loads stock plugin code and every channel message fans out
#    to every session (duplicate replies).
echo "[fleet] syncing canonical server.ts into session plugin dirs..."
bash "$FLEET_KIT_DIR/src/fleet-sync-plugin.sh" || true

# 2) Watchdog — re-syncs every 5 minutes. Each fleet bun watches its own
#    source mtime and self-exits when idle if it changed, so the watchdog
#    only needs to replace files on disk; the MCP supervisor respawns each
#    bun cleanly into the new code. No pkill (the old kill-blast approach
#    left the supervisor unable to respawn). Lives in its own tmux window
#    (assumes a session named "claude" already exists).
tmux new-window -t claude -n fleet-sync \
  "while true; do bash \"$FLEET_KIT_DIR/src/fleet-sync-plugin.sh\"; rc=\$?; if [ \$rc -eq 2 ]; then echo '[fleet-sync] content changed — fleet bun procs will self-respawn when idle'; fi; sleep 300; done"

# 3) Per-session supervisors. One window per fleet session.
#    Each session needs FLEET_SESSION_NAME + CLAUDE_CONFIG_DIR + DISCORD_STATE_DIR.
tmux new-window -t claude -n node-b "FLEET_SESSION_NAME=node-b CLAUDE_CONFIG_DIR=$HOME/.claude-node-b DISCORD_STATE_DIR=$HOME/.claude-node-b/channels/discord CLAUDE_FLEET_LONG_LIVED=1 bash $FLEET_KIT_DIR/src/restart-loop-fleet.sh"
tmux new-window -t claude -n node-c "FLEET_SESSION_NAME=node-c CLAUDE_CONFIG_DIR=$HOME/.claude-node-c DISCORD_STATE_DIR=$HOME/.claude-node-c/channels/discord CLAUDE_FLEET_LONG_LIVED=1 bash $FLEET_KIT_DIR/src/restart-loop-fleet.sh"
tmux new-window -t claude -n node-d "FLEET_SESSION_NAME=node-d CLAUDE_CONFIG_DIR=$HOME/.claude-node-d DISCORD_STATE_DIR=$HOME/.claude-node-d/channels/discord CLAUDE_FLEET_LONG_LIVED=1 bash $FLEET_KIT_DIR/src/restart-loop-fleet.sh"

# The "primary" session (your main interactive Claude Code) should be
# launched separately with FLEET_SESSION_NAME set too — typically as the
# first thing in your start.sh, in its own tmux window. Example:
#
# export FLEET_SESSION_NAME=node-a
# export CLAUDE_FLEET_LONG_LIVED=1
# tmux new-session -d -s claude "bash /restart-loop.sh"
