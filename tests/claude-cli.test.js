const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  PERMISSION_TOOL,
  buildClaudeArgs,
  shouldSurfaceStderr,
  processStreamEvent,
} = require('../lib/claude-cli');

// ===== buildClaudeArgs =====

test('buildClaudeArgs: bare minimum produces correct base flags', () => {
  const args = buildClaudeArgs({});
  assert.deepEqual(args.slice(0, 4), ['-p', '--output-format', 'stream-json', '--verbose']);
  // No --mcp-config when not provided
  assert.equal(args.includes('--mcp-config'), false);
  // Permission tool is the default (no yolo)
  assert.equal(args.includes('--permission-prompt-tool'), true);
  assert.equal(args[args.indexOf('--permission-prompt-tool') + 1], PERMISSION_TOOL);
});

test('buildClaudeArgs: --mcp-config passed when provided', () => {
  const args = buildClaudeArgs({ mcpConfigPath: '/tmp/mcp.json' });
  const idx = args.indexOf('--mcp-config');
  assert.notEqual(idx, -1);
  assert.equal(args[idx + 1], '/tmp/mcp.json');
});

test('buildClaudeArgs: yolo swaps permission tool for --dangerously-skip-permissions', () => {
  const args = buildClaudeArgs({ yolo: true });
  assert.equal(args.includes('--dangerously-skip-permissions'), true);
  assert.equal(args.includes('--permission-prompt-tool'), false);
});

test('buildClaudeArgs: --model only added when set', () => {
  const withoutModel = buildClaudeArgs({});
  assert.equal(withoutModel.includes('--model'), false);

  const withModel = buildClaudeArgs({ model: 'claude-opus-4-7' });
  const idx = withModel.indexOf('--model');
  assert.notEqual(idx, -1);
  assert.equal(withModel[idx + 1], 'claude-opus-4-7');
});

test('buildClaudeArgs: --add-dir filters to existing dirs only', () => {
  const exists = new Set(['/a', '/b']);
  const args = buildClaudeArgs(
    { extraDirs: ['/a', '/missing', '/b', ''] },
    (p) => exists.has(p)
  );
  const idx = args.indexOf('--add-dir');
  assert.notEqual(idx, -1);
  assert.deepEqual(args.slice(idx + 1, idx + 3), ['/a', '/b']);
});

test('buildClaudeArgs: --add-dir omitted entirely when no valid dirs', () => {
  const args = buildClaudeArgs(
    { extraDirs: ['/missing'] },
    () => false
  );
  assert.equal(args.includes('--add-dir'), false);
});

test('buildClaudeArgs: --add-dir omitted when extraDirs missing/empty', () => {
  assert.equal(buildClaudeArgs({}).includes('--add-dir'), false);
  assert.equal(buildClaudeArgs({ extraDirs: [] }).includes('--add-dir'), false);
  assert.equal(buildClaudeArgs({ extraDirs: null }).includes('--add-dir'), false);
});

test('buildClaudeArgs: first message uses --session-id (not --resume)', () => {
  const args = buildClaudeArgs({ sessionId: 'abc-123', isFirst: true });
  assert.equal(args.includes('--session-id'), true);
  assert.equal(args.includes('--resume'), false);
  const idx = args.indexOf('--session-id');
  assert.equal(args[idx + 1], 'abc-123');
});

test('buildClaudeArgs: subsequent message uses --resume', () => {
  const args = buildClaudeArgs({ sessionId: 'abc-123', isFirst: false });
  assert.equal(args.includes('--resume'), true);
  assert.equal(args.includes('--session-id'), false);
  const idx = args.indexOf('--resume');
  assert.equal(args[idx + 1], 'abc-123');
});

test('buildClaudeArgs: no session flag when sessionId is missing', () => {
  const args = buildClaudeArgs({ isFirst: true });
  assert.equal(args.includes('--session-id'), false);
  assert.equal(args.includes('--resume'), false);
});

// ===== shouldSurfaceStderr =====

test('shouldSurfaceStderr: matches known error substrings', () => {
  assert.equal(shouldSurfaceStderr('Error: something broke'), true);
  assert.equal(shouldSurfaceStderr('some error happened'), true);
  assert.equal(shouldSurfaceStderr('fatal: bad thing'), true);
  assert.equal(shouldSurfaceStderr('command not found'), true);
  assert.equal(shouldSurfaceStderr('ENOENT: no such file'), true);
  assert.equal(shouldSurfaceStderr('task failed'), true);
});

test('shouldSurfaceStderr: catches "No conversation found" (worktree regression)', () => {
  // This is the exact stderr Claude CLI emits when --resume is called with
  // an unknown session ID. A regression here means the worktree hang returns.
  assert.equal(
    shouldSurfaceStderr('No conversation found with session ID: abc-123'),
    true
  );
});

test('shouldSurfaceStderr: ignores empty and informational text', () => {
  assert.equal(shouldSurfaceStderr(''), false);
  assert.equal(shouldSurfaceStderr(null), false);
  assert.equal(shouldSurfaceStderr(undefined), false);
  assert.equal(shouldSurfaceStderr('starting up'), false);
  assert.equal(shouldSurfaceStderr('MCP server connected'), false);
});

// ===== processStreamEvent =====

test('processStreamEvent: assistant text block -> stream-delta', () => {
  const out = processStreamEvent({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'hello' }] },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].channel, 'claude:stream-delta');
  assert.equal(out[0].payload.text, 'hello');
});

test('processStreamEvent: thinking block -> thinking-delta', () => {
  const out = processStreamEvent({
    type: 'assistant',
    message: { content: [{ type: 'thinking', thinking: 'pondering' }] },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].channel, 'claude:thinking-delta');
  assert.equal(out[0].payload.text, 'pondering');
});

test('processStreamEvent: tool_use block -> tool-use', () => {
  const out = processStreamEvent({
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/x' } }],
    },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].channel, 'claude:tool-use');
  assert.equal(out[0].payload.name, 'Read');
  assert.deepEqual(out[0].payload.input, { file_path: '/x' });
});

test('processStreamEvent: multiple blocks produce multiple events in order', () => {
  const out = processStreamEvent({
    type: 'assistant',
    message: {
      content: [
        { type: 'thinking', thinking: 't1' },
        { type: 'text', text: 'txt' },
        { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
      ],
    },
  });
  assert.deepEqual(
    out.map(e => e.channel),
    ['claude:thinking-delta', 'claude:stream-delta', 'claude:tool-use']
  );
});

test('processStreamEvent: successful result -> stream-end with metadata', () => {
  const out = processStreamEvent({
    type: 'result',
    is_error: false,
    result: 'Hi there',
    total_cost_usd: 0.05,
    duration_ms: 1234,
    modelUsage: { 'claude-opus-4-7': {} },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].channel, 'claude:stream-end');
  assert.equal(out[0].payload.result, 'Hi there');
  assert.equal(out[0].payload.cost, 0.05);
  assert.equal(out[0].payload.duration, 1234);
  assert.equal(out[0].payload.model, 'claude-opus-4-7');
});

test('processStreamEvent: error result -> stream-error with joined errors', () => {
  // This is the exact shape Claude CLI returns when --resume finds no session.
  // Regression here = silent hang when session is missing.
  const out = processStreamEvent({
    type: 'result',
    is_error: true,
    subtype: 'error_during_execution',
    errors: ['No conversation found with session ID: abc-123'],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].channel, 'claude:stream-error');
  assert.equal(
    out[0].payload.error,
    'No conversation found with session ID: abc-123'
  );
});

test('processStreamEvent: error result with no errors array falls back to subtype', () => {
  const out = processStreamEvent({
    type: 'result',
    is_error: true,
    subtype: 'error_during_execution',
  });
  assert.equal(out[0].channel, 'claude:stream-error');
  assert.equal(out[0].payload.error, 'error_during_execution');
});

test('processStreamEvent: unknown event types yield nothing', () => {
  assert.deepEqual(processStreamEvent({ type: 'system', subtype: 'init' }), []);
  assert.deepEqual(processStreamEvent({ type: 'rate_limit_event' }), []);
  assert.deepEqual(processStreamEvent(null), []);
  assert.deepEqual(processStreamEvent(undefined), []);
  assert.deepEqual(processStreamEvent('not an object'), []);
});

test('processStreamEvent: empty text/thinking blocks are skipped', () => {
  const out = processStreamEvent({
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: '' },
        { type: 'thinking', thinking: '' },
      ],
    },
  });
  assert.deepEqual(out, []);
});
