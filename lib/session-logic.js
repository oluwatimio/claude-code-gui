// Pure decision logic extracted from renderer/app.js sendMessage.
// Dual-mode: loadable via require() from main.js and tests, and via
// <script src> from the renderer (where contextIsolation would otherwise
// clone objects across the preload bridge, breaking the mutation in
// resetSessionForContextSwitch).

(function (global) {
  // Called after the user message has been pushed to conv.messages.
  // Returns true when the spawn should use --session-id (fresh session),
  // false when it should use --resume (continuing an existing session).
  function shouldStartFreshSession(conv) {
    if (!conv) return true;
    if (conv.pendingNewSession === true) return true;
    const len = Array.isArray(conv.messages) ? conv.messages.length : 0;
    return len === 1;
  }

  // Apply to a conversation when switching project context (worktree toggle).
  // Mutates conv in place; caller supplies a UUID generator.
  function resetSessionForContextSwitch(conv, generateUUID) {
    conv.sessionId = generateUUID();
    conv.pendingNewSession = true;
    return conv;
  }

  const api = { shouldStartFreshSession, resetSessionForContextSwitch };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.sessionLogic = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
