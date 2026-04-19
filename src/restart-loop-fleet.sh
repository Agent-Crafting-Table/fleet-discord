#!/bin/bash
# Per-session supervisor for a fleet Claude Code session.
#
# Required env vars (set BEFORE invoking this script):
#   FLEET_SESSION_NAME    Unique name for this session (e.g. "node-a", "node-b").
#                         Used by the fleet plugin as the claim/busy/presence key.
#   CLAUDE_CONFIG_DIR     Per-session Claude config dir (e.g. /home/user/.claude-node-b).
#                         Each fleet session needs its OWN dir to keep histories isolated.
#   DISCORD_STATE_DIR     Per-session Discord plugin state dir (typically
#                         "$CLAUDE_CONFIG_DIR/channels/discord"). The .env with
#                         DISCORD_BOT_TOKEN lives here. The bot token is shared
#                         across sessions; the state dir is per-session.
#   CLAUDE_FLEET_LONG_LIVED=1   Required — gates the fleet code path so cron-spawned
#                               `claude -p` invocations (which inherit the env)
#                               don't also boot a Discord plugin and race for messages.
#
# Optional env vars:
#   FLEET_MODEL                 Claude model name (default "sonnet")
#   FLEET_TRANSCRIPT_DIR        Override transcript discovery dir (default
#                               "$CLAUDE_CONFIG_DIR/projects/-workspace")
#   FLEET_SESSION_ID_FILE       Where to persist captured session id for resume
#                               (default "$HOME/.${FLEET_SESSION_NAME}-session-id")
#   FLEET_LOG_FILE              Log file path (default
#                               "$HOME/.${FLEET_SESSION_NAME}-session.log")
#   FLEET_RESTART_BACKOFF_S     Sleep after exit before restart (default 10)
#   FLEET_SEED_CONFIG_SCRIPT    Path to a seed-claude-config.sh-style script
#                               that pre-populates onboarding/trust/oauth so
#                               fresh config dirs skip the first-run wizard.
#                               Optional — skip if you've already done this.
#
# Usage example (drop in start.sh, one block per fleet session):
#
#   FLEET_SESSION_NAME=node-b \
#   CLAUDE_CONFIG_DIR=/home/node/.claude-node-b \
#   DISCORD_STATE_DIR=/home/node/.claude-node-b/channels/discord \
#   CLAUDE_FLEET_LONG_LIVED=1 \
#     bash /path/to/restart-loop-fleet.sh

set -u

: "${FLEET_SESSION_NAME:?required}"
: "${CLAUDE_CONFIG_DIR:?required}"
: "${DISCORD_STATE_DIR:?required}"
: "${CLAUDE_FLEET_LONG_LIVED:?required (set to 1)}"

export CLAUDE_FLEET_LONG_LIVED
export CLAUDE_CONFIG_DIR
export DISCORD_STATE_DIR
export FLEET_SESSION_NAME

MODEL="${FLEET_MODEL:-sonnet}"
TRANSCRIPT_DIR="${FLEET_TRANSCRIPT_DIR:-$CLAUDE_CONFIG_DIR/projects/-workspace}"
SESSION_ID_FILE="${FLEET_SESSION_ID_FILE:-$HOME/.${FLEET_SESSION_NAME}-session-id}"
LOG_FILE="${FLEET_LOG_FILE:-$HOME/.${FLEET_SESSION_NAME}-session.log}"
BACKOFF_S="${FLEET_RESTART_BACKOFF_S:-10}"
MIN_TRANSCRIPT_SIZE="+10k"

mkdir -p "$TRANSCRIPT_DIR" "$(dirname "$SESSION_ID_FILE")" "$(dirname "$LOG_FILE")"

log() {
  echo "[$(date)] [$FLEET_SESSION_NAME] $1" | tee -a "$LOG_FILE"
}

capture_session_id() {
  local newest
  newest=$(find "$TRANSCRIPT_DIR" -maxdepth 1 -name '*.jsonl' -size "$MIN_TRANSCRIPT_SIZE" -printf '%T@ %f\n' 2>/dev/null \
    | sort -rn | head -1 | awk '{print $2}' | sed 's/\.jsonl$//')
  if [ -n "$newest" ]; then
    echo "$newest" > "$SESSION_ID_FILE"
    log "Captured session ID: $newest"
  fi
}

if [ -n "${FLEET_SEED_CONFIG_SCRIPT:-}" ] && [ -x "$FLEET_SEED_CONFIG_SCRIPT" ]; then
  bash "$FLEET_SEED_CONFIG_SCRIPT" "$CLAUDE_CONFIG_DIR" 2>&1 | tee -a "$LOG_FILE" \
    || log "seed config script failed (non-fatal)"
fi

while true; do
  SESSION_ID=""
  if [ -f "$SESSION_ID_FILE" ]; then
    SESSION_ID=$(tr -d '[:space:]' < "$SESSION_ID_FILE")
  fi

  if [ -n "$SESSION_ID" ] && [ -s "$TRANSCRIPT_DIR/${SESSION_ID}.jsonl" ]; then
    log "Resuming session $SESSION_ID with model: $MODEL"
    claude --dangerously-skip-permissions --model "$MODEL" \
      --channels plugin:discord@claude-plugins-official \
      --resume "$SESSION_ID"
  else
    log "Starting fresh session with model: $MODEL"
    claude --dangerously-skip-permissions --model "$MODEL" \
      --channels plugin:discord@claude-plugins-official
  fi

  capture_session_id
  log "Session exited. Restarting in ${BACKOFF_S}s..."
  sleep "$BACKOFF_S"
done
