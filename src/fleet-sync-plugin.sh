#!/bin/bash
# Sync the canonical fleet server.ts into all fleet sessions' Discord plugin
# caches. Hardlinks won't cross FS and symlinks confuse bun's node_modules
# resolver — so we copy, and this script keeps the copies in sync with the
# canonical source.
#
# Idempotent: only rewrites when content differs from canonical. Exits 2 if
# any file was updated (so callers can kill bun plugins to force respawn),
# 0 if everything was already in sync.
#
# Run after editing the canonical server.ts. Plugin processes must restart
# to pick up the change — wire this into a boot watchdog (see start.sh
# snippet) that kills `bun server.ts` whenever exit==2 so the Claude Code
# supervisor respawns it.
#
# Required env vars:
#   FLEET_CANONICAL_TS   Absolute path to the canonical server.ts source.
#   FLEET_SESSION_DIRS   Space-separated list of CLAUDE_CONFIG_DIR paths,
#                        one per fleet session.
#
# Optional env vars:
#   FLEET_PLUGIN_REL_PATHS   Space-separated list of plugin paths to sync
#                            into, relative to each session dir. Defaults
#                            cover both the marketplaces and cache layouts
#                            of the official Discord plugin v0.0.4.

set -u

CANONICAL="${FLEET_CANONICAL_TS:?required}"
read -r -a SESSIONS <<< "${FLEET_SESSION_DIRS:?required (space-separated)}"
DEFAULT_REL_PATHS="plugins/marketplaces/claude-plugins-official/external_plugins/discord/server.ts plugins/cache/claude-plugins-official/discord/0.0.4/server.ts"
read -r -a REL_PATHS <<< "${FLEET_PLUGIN_REL_PATHS:-$DEFAULT_REL_PATHS}"

if [[ ! -f "$CANONICAL" ]]; then
  echo "error: canonical not found at $CANONICAL" >&2
  exit 1
fi

CANON_HASH=$(md5sum "$CANONICAL" | awk '{print $1}')
CHANGED=0

for session in "${SESSIONS[@]}"; do
  any_present=0
  for rel in "${REL_PATHS[@]}"; do
    if [[ ! -d "$session/$(dirname "$rel")" ]]; then
      continue
    fi
    any_present=1
    target="$session/$rel"
    if [[ -f "$target" ]]; then
      target_hash=$(md5sum "$target" | awk '{print $1}')
      if [[ "$target_hash" == "$CANON_HASH" ]]; then
        continue
      fi
      # Back up the original stock plugin once so rollback is possible.
      if [[ ! -f "$target.orig" ]]; then
        cp -a "$target" "$target.orig"
        echo "backed up: $target.orig"
      fi
    fi
    # Plugin file may be root-owned from an earlier root-run install. cp can't
    # overwrite root-owned files as a non-root user — remove first (parent dir
    # is typically writable) then copy.
    rm -f "$target"
    cp "$CANONICAL" "$target"
    echo "synced:    $target"
    CHANGED=1
  done
  if [[ $any_present -eq 0 ]]; then
    echo "skip: $session — no known plugin path present"
  fi
done

if [[ $CHANGED -eq 1 ]]; then
  exit 2
fi
exit 0
