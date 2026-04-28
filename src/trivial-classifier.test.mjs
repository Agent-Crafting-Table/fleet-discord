#!/usr/bin/env node
/**
 * Smoke test for trivial-classifier.
 *
 * Goal: verify the classifier is conservative — every "trivial" return is
 * unambiguously a low-content ack, and every "not-trivial" return is
 * something the model should see.
 *
 * Run: node src/trivial-classifier.test.mjs
 */

import assert from 'node:assert';
import { classify, ACK_REACTION, SEEN_REACTION } from './trivial-classifier.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
  }
}

const T = (content, extras = {}) =>
  classify({ content, hasAttachments: false, hasMentions: false, ...extras });

console.log('trivial-classifier');

// ── Trivial — should be reacted to and skipped ──────────────────────────
test('"ok" → trivial ack', () => {
  const r = T('ok');
  assert.strictEqual(r.trivial, true);
  assert.strictEqual(r.reaction, ACK_REACTION);
});

test('"OK" (uppercase) → trivial ack (case-insensitive)', () => {
  assert.strictEqual(T('OK').trivial, true);
});

test('"thanks" → trivial', () => assert.strictEqual(T('thanks').trivial, true));
test('"Thanks!" with bang → trivial (punctuation stripped)', () => assert.strictEqual(T('Thanks!').trivial, true));
test('"thank you" with space → trivial', () => assert.strictEqual(T('thank you').trivial, true));
test('"got it" → trivial', () => assert.strictEqual(T('got it').trivial, true));
test('"sounds good" → trivial', () => assert.strictEqual(T('sounds good').trivial, true));
test('"lol" → trivial', () => assert.strictEqual(T('lol').trivial, true));
test('"yep" → trivial', () => assert.strictEqual(T('yep').trivial, true));
test('"no" → trivial', () => assert.strictEqual(T('no').trivial, true));

test('"👍" emoji-only → trivial seen', () => {
  const r = T('👍');
  assert.strictEqual(r.trivial, true);
  assert.strictEqual(r.reaction, SEEN_REACTION);
});

test('"🔥🔥" two emojis → trivial seen', () => {
  assert.strictEqual(T('🔥🔥').trivial, true);
});

// ── Not trivial — should still go to the model ──────────────────────────
test('"" empty → not trivial', () => assert.strictEqual(T('').trivial, false));
test('"   " whitespace → not trivial', () => assert.strictEqual(T('   ').trivial, false));
test('"hey can you check the db?" → not trivial (question)', () => {
  const r = T('hey can you check the db?');
  assert.strictEqual(r.trivial, false);
  assert.strictEqual(r.reason, 'contains-question');
});
test('"is this ok?" → not trivial (question mark)', () => {
  assert.strictEqual(T('is this ok?').trivial, false);
});
test('"do that thing" → not trivial (action request)', () => {
  assert.strictEqual(T('do that thing').trivial, false);
});
test('"/status" → not trivial (slash command)', () => {
  const r = T('/status');
  assert.strictEqual(r.trivial, false);
  assert.strictEqual(r.reason, 'slash-command');
});
test('"ok do that next" → not trivial (more than just ack)', () => {
  assert.strictEqual(T('ok do that next').trivial, false);
});
test('"no actually nevermind" → not trivial (more than just no)', () => {
  assert.strictEqual(T('no actually nevermind').trivial, false);
});
test('long message → not trivial', () => {
  assert.strictEqual(T('this is a much longer message that should not be classified as trivial').trivial, false);
});
test('message with attachment → not trivial', () => {
  assert.strictEqual(T('ok', { hasAttachments: true }).trivial, false);
});
test('message with @mention → not trivial', () => {
  assert.strictEqual(T('ok', { hasMentions: true }).trivial, false);
});

// ── Edge cases ──────────────────────────────────────────────────────────
test('"ok." with period → trivial (trailing period stripped)', () => {
  assert.strictEqual(T('ok.').trivial, true);
});
test('"haha!!" → trivial', () => assert.strictEqual(T('haha!!').trivial, true));
test('"yes please do that" → not trivial (longer than ack)', () => {
  assert.strictEqual(T('yes please do that').trivial, false);
});
test('"whatever" not in dict → not trivial', () => {
  assert.strictEqual(T('whatever').trivial, false);
});
test('"123" digits → not trivial (not in dict, not emoji)', () => {
  assert.strictEqual(T('123').trivial, false);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
