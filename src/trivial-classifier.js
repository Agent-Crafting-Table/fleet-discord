/**
 * Discord trivial-message classifier.
 *
 * Decides whether an inbound Discord message is "trivial" — an ack, an
 * emoji-only reply, or some other message where the right response is a
 * lightweight reaction rather than a full Claude session spin.
 *
 * Used by fleet-discord-server.ts before the fleet claim. If a message is
 * classified trivial, the bot reacts with the suggested emoji and skips
 * the `notifications/claude/channel` MCP call entirely — saving the cost
 * of loading a full session just to say "👍".
 *
 * Conservative on purpose: when in doubt, return trivial=false so the
 * model still sees the message. The cost of a missed model spin is much
 * higher than the cost of an extra model spin.
 */

// Lower-case, no trailing punctuation. Matches against the same.
export const TRIVIAL_ACKS = new Set([
  // Acks
  'ok', 'okay', 'kk', 'k',
  'yep', 'yup', 'yeah', 'yes',
  'no', 'nope',
  // Thanks
  'ty', 'thx', 'thanks', 'thank you', 'thanks!', 'thx!',
  // Affirmations
  'cool', 'nice', 'great', 'awesome', 'perfect', 'sweet',
  'got it', 'gotcha', 'understood', 'sounds good',
  // Reactions
  'lol', 'haha', 'lmao', 'rofl',
]);

export const ACK_REACTION = '👍';
export const SEEN_REACTION = '👀';

export const MAX_LENGTH = 30;

/**
 * Classify a Discord-like inbound message.
 *
 * @param {object} input
 * @param {string} input.content       - Message text body.
 * @param {boolean} input.hasAttachments - Whether the message has attachments.
 * @param {boolean} input.hasMentions  - Whether the message @mentions any user/role.
 * @returns {{trivial: boolean, reaction: string|null, reason: string}}
 */
export function classify({ content, hasAttachments, hasMentions }) {
  if (hasAttachments) {
    return { trivial: false, reaction: null, reason: 'has-attachments' };
  }
  if (hasMentions) {
    return { trivial: false, reaction: null, reason: 'has-mentions' };
  }

  const text = (content == null ? '' : String(content)).trim();
  if (!text) {
    return { trivial: false, reaction: null, reason: 'empty' };
  }
  if (text.length > MAX_LENGTH) {
    return { trivial: false, reaction: null, reason: 'too-long' };
  }
  if (text.includes('?')) {
    return { trivial: false, reaction: null, reason: 'contains-question' };
  }
  if (text.startsWith('/')) {
    return { trivial: false, reaction: null, reason: 'slash-command' };
  }

  const normalized = text.toLowerCase().replace(/[.!]+$/, '').trim();
  if (TRIVIAL_ACKS.has(normalized)) {
    return { trivial: true, reaction: ACK_REACTION, reason: `ack:${normalized}` };
  }

  // Pure-emoji message (no ASCII letters/digits, no whitespace beyond what
  // sits between emojis). The Extended_Pictographic Unicode property
  // covers most user-typed emoji.
  if (text.length <= 8 && /^[\p{Extended_Pictographic}‍️\s]+$/u.test(text)) {
    return { trivial: true, reaction: SEEN_REACTION, reason: 'emoji-only' };
  }

  return { trivial: false, reaction: null, reason: 'no-match' };
}
