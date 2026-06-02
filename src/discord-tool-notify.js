#!/usr/bin/env node
/**
 * discord-tool-notify.js — PreToolUse hook: single rolling Discord message per task.
 *
 * Wired in settings.json as a PreToolUse hook for all fleet sessions.
 * STDIN: Claude Code PreToolUse JSON payload: { tool_name, tool_input, ... }
 *
 * Gates (any fail → exit 0, silent, never blocks the tool):
 *   GATE 1 — toggle: DISCORD_TOOL_STREAM !== '1' → exit 0
 *             (also reads CLAUDE_CONFIG_DIR/channels/discord/.env as fallback)
 *   GATE 2 — active-task guard: no busy file for this session → exit 0
 *             (silences headless cron agents and idle sessions)
 *
 * Channel routing: busy file's chatId → posting channel.
 * Fallback: sticky-channel map from FLEET_STICKY_CHANNELS env var (JSON object)
 *   e.g. FLEET_STICKY_CHANNELS='{"session-a":"YOUR_CHANNEL_ID","session-b":"YOUR_CHANNEL_ID"}'
 *   Defaults to empty map — set to enable fallback routing for idle sessions.
 *
 * Format whitelist (anything else → exit 0 silently):
 *   Bash      🔧 **Bash** `<first line of command, ≤120 chars>`
 *   Read      📖 **Read** `<file_path>`
 *   Edit      ✏️ **Edit** `<file_path>`
 *   Write     📝 **Write** `<file_path>`
 *   Glob      🔎 **Glob** `<pattern>`
 *   Grep      🔍 **Grep** `<pattern>`
 *   Agent     🤖 **Agent** — <description or first 100 chars of prompt>
 *   WebFetch  🌐 **WebFetch** <url, ≤80 chars>
 *   WebSearch 🔍 **WebSearch** <query, ≤80 chars>
 *
 * Rolling message (Option B):
 *   Maintains ONE Discord message per active task, edited in place.
 *   State file (ephemeral, per-session): /tmp/fleet-tool-stream-<SESSION>.json
 *   taskKey = busy file's messageId (stable inbound msg id); fallback: chatId alone.
 *   Do NOT key on since/cooldownUntil/lastReminderAt — those can update mid-task.
 *   New taskKey → fresh message. Same taskKey → edit in place.
 *   Lines capped at last 12. Self-recovers if message deleted (404 → fresh post).
 *   On POST failure: state saved with null messageId so next call edits→404→recovers.
 *
 * Timing: all Discord I/O is raced against a 1500ms timeout and swallowed on any
 * failure — a slow/failed Discord post NEVER delays or breaks the tool.
 *
 * Required env:
 *   DISCORD_BOT_TOKEN      Bot token (or set in CLAUDE_CONFIG_DIR/channels/discord/.env)
 *   FLEET_STATE_DIR        Fleet state directory (same as server.ts; default ~/.claude/fleet)
 *   FLEET_SESSION_NAME     Session identifier (set by restart-loop-fleet.sh)
 *
 * Optional env:
 *   DISCORD_TOOL_STREAM=1  Enable streaming (required; also readable from plugin .env)
 *   FLEET_STICKY_CHANNELS  JSON map of session → channel snowflake for fallback routing
 *                          Example: '{"session-a":"YOUR_CHANNEL_ID","session-b":"YOUR_CHANNEL_ID"}'
 *   CLAUDE_CONFIG_DIR      Claude config dir (used to find plugin .env; default ~/.claude)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');

// Sticky-channel fallback map: session → channel id
// Read from FLEET_STICKY_CHANNELS env var as JSON. Defaults to empty.
// Example (in your container env or .env):
//   FLEET_STICKY_CHANNELS='{"session-a":"YOUR_CHANNEL_ID_HERE","session-b":"YOUR_CHANNEL_ID_HERE"}'
let STICKY_CHANNELS = {};
try {
  if (process.env.FLEET_STICKY_CHANNELS) {
    STICKY_CHANNELS = JSON.parse(process.env.FLEET_STICKY_CHANNELS);
  }
} catch {
  // malformed JSON — treat as empty
}

const FLEET_STATE_DIR = process.env.FLEET_STATE_DIR || path.join(os.homedir(), '.claude', 'fleet');
const FLEET_BUSY_DIR = path.join(FLEET_STATE_DIR, 'busy');
const MAX_LINES = 12;

/**
 * Resolve this session's name from env, with fallback via CLAUDE_CONFIG_DIR suffix.
 * e.g. CLAUDE_CONFIG_DIR=/home/user/.claude-session-b → 'session-b'
 *      CLAUDE_CONFIG_DIR=/home/user/.claude           → 'session-a' (primary)
 */
function resolveSessionName() {
  if (process.env.FLEET_SESSION_NAME) return process.env.FLEET_SESSION_NAME;
  const cfgDir = process.env.CLAUDE_CONFIG_DIR || '';
  const base = path.basename(cfgDir);
  const m = base.match(/\.claude-(.+)$/);
  if (m) return m[1];
  if (base === '.claude') return 'session-a';
  return null;
}

/**
 * Resolve the CLAUDE_CONFIG_DIR for a session name when the env var is absent.
 */
function configDirForSession(session) {
  const home = os.homedir();
  if (session === 'session-a') return path.join(home, '.claude');
  if (session) return path.join(home, `.claude-${session}`);
  return null;
}

/**
 * Check whether DISCORD_TOOL_STREAM=1 is set in the session's plugin .env file.
 * Path: <CLAUDE_CONFIG_DIR>/channels/discord/.env
 * Returns true if the flag is present; false on any error or absence.
 * NEVER throws — the hook must never break a tool call.
 */
function readSessionEnvFlag() {
  try {
    let cfgDir = process.env.CLAUDE_CONFIG_DIR || '';
    if (!cfgDir) {
      const session = resolveSessionName();
      cfgDir = configDirForSession(session) || '';
    }
    if (!cfgDir) return false;

    const envFile = path.join(cfgDir, 'channels', 'discord', '.env');
    const contents = fs.readFileSync(envFile, 'utf8');
    return contents.split('\n').some(line => line.trim() === 'DISCORD_TOOL_STREAM=1');
  } catch {
    return false;
  }
}

/**
 * Read the busy file for this session. Returns null if absent or invalid.
 * Matches the BusyFile shape from server.ts:
 *   { chatId, messageId, since, cooldownUntil?, channelSlug?, user? }
 * TTL: 30 min (matching FLEET_BUSY_TTL_MS in server.ts).
 */
function readBusyFile(session) {
  try {
    const filePath = path.join(FLEET_BUSY_DIR, `${session}.json`);
    const raw = fs.readFileSync(filePath, 'utf8');
    const b = JSON.parse(raw);
    if (!b || typeof b.chatId !== 'string') return null;
    const BUSY_TTL_MS = 30 * 60 * 1000;
    if (Date.now() - (b.since || 0) > BUSY_TTL_MS) return null;
    return b;
  } catch {
    return null;
  }
}

/**
 * Format a single-line tool notification. Returns null for non-whitelisted tools.
 */
function formatLine(toolName, toolInput) {
  switch (toolName) {
    case 'Bash': {
      const cmd = (toolInput.command || '').split('\n')[0].trim();
      const preview = cmd.length > 120 ? cmd.slice(0, 120) + '…' : cmd;
      return `🔧 **Bash** \`${preview}\``;
    }
    case 'Read': {
      return `📖 **Read** \`${toolInput.file_path || ''}\``;
    }
    case 'Edit': {
      return `✏️ **Edit** \`${toolInput.file_path || ''}\``;
    }
    case 'Write': {
      return `📝 **Write** \`${toolInput.file_path || ''}\``;
    }
    case 'Glob': {
      return `🔎 **Glob** \`${toolInput.pattern || ''}\``;
    }
    case 'Grep': {
      return `🔍 **Grep** \`${toolInput.pattern || ''}\``;
    }
    case 'Agent': {
      const desc = toolInput.description
        || (toolInput.prompt ? toolInput.prompt.slice(0, 100) + (toolInput.prompt.length > 100 ? '…' : '') : '');
      return `🤖 **Agent** — ${desc}`;
    }
    case 'WebFetch': {
      const url = (toolInput.url || '').slice(0, 80);
      return `🌐 **WebFetch** ${url}`;
    }
    case 'WebSearch': {
      const q = (toolInput.query || '').slice(0, 80);
      return `🔍 **WebSearch** ${q}`;
    }
    default:
      return null;
  }
}

/**
 * Resolve the bot token:
 *   1. process.env.DISCORD_BOT_TOKEN
 *   2. MCP plugin .env fallback at CLAUDE_CONFIG_DIR/channels/discord/.env
 * Returns null if neither is available.
 */
function resolveBotToken() {
  if (process.env.DISCORD_BOT_TOKEN) return process.env.DISCORD_BOT_TOKEN;
  try {
    const cfgDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    const envPath = path.join(cfgDir, 'channels', 'discord', '.env');
    const raw = fs.readFileSync(envPath, 'utf8');
    const match = raw.match(/^DISCORD_BOT_TOKEN=(.+)$/m);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

/**
 * POST a new message to Discord. Returns the message object (with .id).
 * Throws on failure. err.statusCode is set on HTTP errors (e.g. 429 rate-limit).
 */
function discordPost(channelId, content, token) {
  const body = JSON.stringify({ content: content.length > 2000 ? content.slice(0, 1997) + '...' : content });
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'discord.com',
        path: `/api/v10/channels/${channelId}/messages`,
        method: 'POST',
        headers: {
          'Authorization': `Bot ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(data)); } catch { resolve({ id: null }); }
          } else {
            const err = new Error(`Discord POST ${res.statusCode}: ${data}`);
            err.statusCode = res.statusCode;
            reject(err);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * PATCH (edit) an existing Discord message. Throws on failure.
 * Sets err.statusCode on HTTP errors so callers can detect 404 or 429.
 */
function discordEdit(channelId, messageId, content, token) {
  const body = JSON.stringify({ content: content.length > 2000 ? content.slice(0, 1997) + '...' : content });
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'discord.com',
        path: `/api/v10/channels/${channelId}/messages/${messageId}`,
        method: 'PATCH',
        headers: {
          'Authorization': `Bot ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(data)); } catch { resolve({}); }
          } else {
            const err = new Error(`Discord PATCH ${res.statusCode}: ${data}`);
            err.statusCode = res.statusCode;
            reject(err);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Build the rolling message content from a list of lines.
 */
function buildMessageContent(lines) {
  return ['🔧 **fleet — live activity**', ...lines].join('\n');
}

/**
 * Load rolling state from /tmp. Returns null on any error.
 */
function loadState(session) {
  try {
    const p = `/tmp/fleet-tool-stream-${session}.json`;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Save rolling state to /tmp. Swallows errors.
 */
function saveState(session, state) {
  try {
    const p = `/tmp/fleet-tool-stream-${session}.json`;
    fs.writeFileSync(p, JSON.stringify(state), 'utf8');
  } catch {
    // swallow
  }
}

async function main() {
  // GATE 1: toggle — flag ON if set in process env OR in the session's plugin .env file.
  // The plugin .env (CLAUDE_CONFIG_DIR/channels/discord/.env) is NOT injected into the
  // claude process env, so running sessions must fall back to reading the file directly.
  // Any error reading the file is treated as OFF (never throws).
  const toolStreamOn =
    process.env.DISCORD_TOOL_STREAM === '1' || readSessionEnvFlag();
  if (!toolStreamOn) {
    process.exit(0);
  }

  // Read stdin
  let raw = '';
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    raw = Buffer.concat(chunks).toString('utf8');
  } catch {
    process.exit(0);
  }

  // Parse payload
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const toolName = payload.tool_name || '';
  const toolInput = payload.tool_input || {};

  // GATE 2: active-task guard
  const session = resolveSessionName();
  if (!session) process.exit(0);

  const busy = readBusyFile(session);
  if (!busy) process.exit(0);

  // Channel routing: prefer busy file's chatId (active task channel),
  // fall back to sticky-channel map (FLEET_STICKY_CHANNELS env var).
  const channelId = busy.chatId || STICKY_CHANNELS[session] || null;
  if (!channelId) process.exit(0);

  // Format the line (non-whitelisted tools → exit 0 silently)
  const line = formatLine(toolName, toolInput);
  if (!line) process.exit(0);

  // Compute taskKey from busy file.
  // Use the stable inbound message id (set once at claim, never rewritten by
  // heartbeats/watchdog/reply-tool). Fall back to chatId only if messageId is
  // absent — do NOT use since/cooldownUntil/lastReminderAt (those update mid-task
  // and would churn the key, causing every tool call to post a fresh message).
  const taskKey = String(busy.messageId || busy.chatId || '');

  // Resolve bot token
  const token = resolveBotToken();
  if (!token) process.exit(0);

  // Rolling message — post or edit, raced against 1500ms timeout.
  // Any error is swallowed — NEVER block/break the tool.
  try {
    await Promise.race([
      (async () => {
        let state = loadState(session);

        // COOLDOWN GATE: if a prior call set cooldownUntil (rate-limit or hard failure),
        // exit silently until the window passes.
        if (state && state.cooldownUntil && state.cooldownUntil > Date.now()) {
          return;
        }

        const isNewTask = !state
          || state.taskKey !== taskKey
          || state.chatId !== channelId;

        if (isNewTask) {
          const lines = [line];
          const content = buildMessageContent(lines);
          // Save-before-network: even if 1500ms timeout fires mid-POST, next call
          // finds the same taskKey and goes to edit/recovery branch, not fresh POST.
          saveState(session, { chatId: channelId, messageId: null, taskKey, lines });
          let postedId = null;
          try {
            const msg = await discordPost(channelId, content, token);
            postedId = msg.id ?? null;
            saveState(session, { chatId: channelId, messageId: postedId, taskKey, lines });
          } catch (postErr) {
            const cooldownUntil = Date.now() + 8000;
            if (postErr.statusCode === 429 || !postErr.statusCode) {
              saveState(session, { chatId: channelId, messageId: null, taskKey, lines, cooldownUntil });
            }
          }
        } else {
          const lines = [...(state.lines || []), line].slice(-MAX_LINES);
          const content = buildMessageContent(lines);

          if (!state.messageId) {
            // Recovery POST: null messageId means prior POST timed out or failed.
            saveState(session, { chatId: channelId, messageId: null, taskKey, lines });
            let recoveredId = null;
            try {
              const msg = await discordPost(channelId, content, token);
              recoveredId = msg.id ?? null;
              saveState(session, { chatId: channelId, messageId: recoveredId, taskKey, lines });
            } catch (postErr) {
              const cooldownUntil = Date.now() + 8000;
              saveState(session, { chatId: channelId, messageId: null, taskKey, lines, cooldownUntil });
            }
          } else {
            try {
              await discordEdit(channelId, state.messageId, content, token);
              saveState(session, { chatId: channelId, messageId: state.messageId, taskKey, lines });
            } catch (editErr) {
              if (editErr.statusCode === 404) {
                // Message was deleted — self-recover with a fresh post.
                saveState(session, { chatId: channelId, messageId: null, taskKey, lines });
                let recoveredId = null;
                try {
                  const msg = await discordPost(channelId, content, token);
                  recoveredId = msg.id ?? null;
                  saveState(session, { chatId: channelId, messageId: recoveredId, taskKey, lines });
                } catch (postErr) {
                  const cooldownUntil = Date.now() + 8000;
                  saveState(session, { chatId: channelId, messageId: null, taskKey, lines, cooldownUntil });
                }
              } else if (editErr.statusCode === 429) {
                const cooldownUntil = Date.now() + 8000;
                saveState(session, { chatId: channelId, messageId: state.messageId, taskKey, lines, cooldownUntil });
              } else {
                saveState(session, { chatId: channelId, messageId: state.messageId, taskKey, lines });
              }
            }
          }
        }
      })().catch(() => {}),
      new Promise(resolve => setTimeout(resolve, 1500)),
    ]);
  } catch {
    // Swallow all errors
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
