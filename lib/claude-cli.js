// Pure logic extracted from main.js for testability.
// No Electron / fs / child_process imports — callers pass side-effect deps in.

const PERMISSION_TOOL = 'mcp__gui_permissions__approve_permission';

// Build the argv for `claude` given a send-prompt request.
// `dirExists` is a predicate so callers can inject fs.existsSync (or a mock).
function buildClaudeArgs(opts, dirExists = () => true) {
  const { sessionId, isFirst, yolo, mcpConfigPath, model, extraDirs } = opts;
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];

  if (mcpConfigPath) {
    args.push('--mcp-config', mcpConfigPath);
  }

  if (yolo) {
    args.push('--dangerously-skip-permissions');
  } else {
    args.push('--permission-prompt-tool', PERMISSION_TOOL);
  }

  if (model) {
    args.push('--model', model);
  }

  if (Array.isArray(extraDirs) && extraDirs.length) {
    const valid = extraDirs.filter(d => d && dirExists(d));
    if (valid.length) {
      args.push('--add-dir', ...valid);
    }
  }

  if (sessionId) {
    args.push(isFirst ? '--session-id' : '--resume', sessionId);
  }

  return args;
}

// Stderr text patterns that should be surfaced as errors to the UI.
// Kept as a list so tests can exercise each case.
const STDERR_ERROR_PATTERNS = [
  'Error',
  'error',
  'fatal',
  'not found',
  'No conversation found',
  'ENOENT',
  'failed',
];

function shouldSurfaceStderr(text) {
  if (!text) return false;
  return STDERR_ERROR_PATTERNS.some(p => text.includes(p));
}

// Translate a stream-json event from Claude CLI into a list of
// { channel, payload } objects that callers can forward over IPC.
// Returning data (instead of sending) makes this trivial to unit-test.
function processStreamEvent(obj) {
  const out = [];
  if (!obj || typeof obj !== 'object') return out;

  if (obj.type === 'assistant' && obj.message) {
    const content = obj.message.content || [];
    for (const block of content) {
      if (block.type === 'text' && block.text) {
        out.push({ channel: 'claude:stream-delta', payload: { text: block.text } });
      }
      if (block.type === 'thinking' && block.thinking) {
        out.push({ channel: 'claude:thinking-delta', payload: { text: block.thinking } });
      }
      if (block.type === 'tool_use') {
        out.push({ channel: 'claude:tool-use', payload: { name: block.name, input: block.input } });
      }
    }
  } else if (obj.type === 'result') {
    if (obj.is_error) {
      const msg = (Array.isArray(obj.errors) && obj.errors.length)
        ? obj.errors.join('; ')
        : (obj.subtype || 'Claude CLI returned an error');
      out.push({ channel: 'claude:stream-error', payload: { error: msg } });
    } else {
      out.push({
        channel: 'claude:stream-end',
        payload: {
          result: obj.result,
          cost: obj.total_cost_usd,
          duration: obj.duration_ms,
          model: Object.keys(obj.modelUsage || {})[0] || '',
        },
      });
    }
  }

  return out;
}

module.exports = {
  PERMISSION_TOOL,
  STDERR_ERROR_PATTERNS,
  buildClaudeArgs,
  shouldSurfaceStderr,
  processStreamEvent,
};
