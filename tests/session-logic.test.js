const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  shouldStartFreshSession,
  resetSessionForContextSwitch,
} = require('../lib/session-logic');

// ===== shouldStartFreshSession =====
// This formula decides --session-id vs --resume. Getting it wrong has
// caused two separate worktree hangs — keep these tests tight.

test('shouldStartFreshSession: brand new conv with one user message -> fresh', () => {
  const conv = { messages: [{ role: 'user', content: 'hi' }] };
  assert.equal(shouldStartFreshSession(conv), true);
});

test('shouldStartFreshSession: second turn -> resume', () => {
  const conv = {
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hi there' },
      { role: 'user', content: 'again' },
    ],
  };
  assert.equal(shouldStartFreshSession(conv), false);
});

test('shouldStartFreshSession: pendingNewSession forces fresh even mid-conversation', () => {
  // This is the worktree-toggle case — messages already exist, but we
  // just reset the sessionId, so --resume would 404.
  const conv = {
    pendingNewSession: true,
    messages: [
      { role: 'user', content: 'old' },
      { role: 'assistant', content: 'old response' },
      { role: 'user', content: 'new after toggle' },
    ],
  };
  assert.equal(shouldStartFreshSession(conv), true);
});

test('shouldStartFreshSession: handles missing/empty messages defensively', () => {
  assert.equal(shouldStartFreshSession({ messages: [] }), false);
  assert.equal(shouldStartFreshSession({}), false);
  assert.equal(shouldStartFreshSession(null), true);
  assert.equal(shouldStartFreshSession(undefined), true);
});

// ===== resetSessionForContextSwitch =====

test('resetSessionForContextSwitch: generates new sessionId and sets pending flag', () => {
  const conv = {
    sessionId: 'old-uuid',
    pendingNewSession: false,
    messages: [{ role: 'user', content: 'hi' }],
  };
  resetSessionForContextSwitch(conv, () => 'new-uuid');
  assert.equal(conv.sessionId, 'new-uuid');
  assert.equal(conv.pendingNewSession, true);
  // Must not touch messages — user expects to still see them in the UI.
  assert.equal(conv.messages.length, 1);
});

test('resetSessionForContextSwitch: after toggle, next send is fresh', () => {
  // End-to-end flow for the exact regression that caused the hang:
  // 1. User has a real conversation going
  // 2. Toggles worktree → context switch
  // 3. Sends another message
  // Previously: --resume <new-uuid> → "No conversation found" → hang.
  // Correct: --session-id <new-uuid> → fresh session in the worktree.
  const conv = {
    sessionId: 'original-uuid',
    pendingNewSession: false,
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hi there' },
    ],
  };

  resetSessionForContextSwitch(conv, () => 'worktree-uuid');

  // Simulate sendMessage: user message pushed first
  conv.messages.push({ role: 'user', content: 'after toggle' });
  const fresh = shouldStartFreshSession(conv);

  assert.equal(fresh, true, 'must use --session-id, not --resume');
  assert.equal(conv.sessionId, 'worktree-uuid');
});
