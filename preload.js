const { contextBridge, ipcRenderer } = require('electron');
const { marked } = require('marked');
const hljs = require('highlight.js/lib/common');
const { structuredPatch } = require('diff');

// Configure marked with highlight.js integration
marked.use({
  breaks: true,
  gfm: true,
  renderer: {
    code({ text, lang }) {
      const codeText = text || '';
      const language = lang || '';

      let highlighted;
      try {
        if (language && hljs.getLanguage(language)) {
          highlighted = hljs.highlight(codeText, { language }).value;
        } else {
          highlighted = hljs.highlightAuto(codeText).value;
        }
      } catch (e) {
        highlighted = codeText
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
      }

      const escapedCode = codeText.replace(/"/g, '&quot;').replace(/'/g, '&#39;');

      return `<div class="code-block">
        <div class="code-header">
          <span class="code-lang">${language || 'text'}</span>
          <button class="copy-btn" data-code="${escapedCode}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
            <span>Copy</span>
          </button>
        </div>
        <pre><code class="hljs language-${language}">${highlighted}</code></pre>
      </div>`;
    },
    codespan({ text }) {
      return `<code>${text || ''}</code>`;
    }
  }
});

contextBridge.exposeInMainWorld('libs', {
  renderMarkdown: (text) => {
    // Handle incomplete code fences during streaming
    const openFences = (text.match(/```/g) || []).length;
    let processedText = text;
    if (openFences % 2 !== 0) {
      processedText += '\n```';
    }
    return marked.parse(processedText);
  },
  structuredPatch: (oldText, newText, context) => {
    try {
      const patch = structuredPatch('a', 'b', String(oldText || ''), String(newText || ''), '', '', {
        context: typeof context === 'number' ? context : 3,
      });
      // Return a cloneable plain object across the contextBridge
      return {
        hunks: (patch.hunks || []).map(h => ({
          oldStart: h.oldStart,
          oldLines: h.oldLines,
          newStart: h.newStart,
          newLines: h.newLines,
          lines: h.lines.slice(),
        })),
      };
    } catch (e) {
      return { hunks: [] };
    }
  },
  highlightCode: (code, language) => {
    const text = code || '';
    try {
      if (language && hljs.getLanguage(language)) {
        return { html: hljs.highlight(text, { language }).value, language };
      }
      const auto = hljs.highlightAuto(text);
      return { html: auto.value, language: auto.language || '' };
    } catch (e) {
      const escaped = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      return { html: escaped, language: '' };
    }
  }
});

contextBridge.exposeInMainWorld('claude', {
  sendPrompt: (convId, prompt, sessionId, isFirst, yolo, projectPath, model, extraDirs) => ipcRenderer.send('claude:send-prompt', { convId, prompt, sessionId, isFirst, yolo, projectPath, model, extraDirs }),
  stopGeneration: (convId) => ipcRenderer.send('claude:stop-generation', { convId }),
  onStreamStart: (callback) => ipcRenderer.on('claude:stream-start', (_, data) => callback(data)),
  onStreamDelta: (callback) => ipcRenderer.on('claude:stream-delta', (_, data) => callback(data)),
  onThinkingDelta: (callback) => ipcRenderer.on('claude:thinking-delta', (_, data) => callback(data)),
  onStreamEnd: (callback) => ipcRenderer.on('claude:stream-end', (_, data) => callback(data)),
  onStreamError: (callback) => ipcRenderer.on('claude:stream-error', (_, data) => callback(data)),
  onStreamClose: (callback) => ipcRenderer.on('claude:stream-close', (_, data) => callback(data)),
  onToolUse: (callback) => ipcRenderer.on('claude:tool-use', (_, data) => callback(data)),
  onToolResult: (callback) => ipcRenderer.on('claude:tool-result', (_, data) => callback(data)),
  onCompact: (callback) => ipcRenderer.on('claude:compact', (_, data) => callback(data)),
  onUsage: (callback) => ipcRenderer.on('claude:usage', (_, data) => callback(data)),
  focusWindow: () => ipcRenderer.send('window:focus'),
  onPermissionRequest: (callback) => ipcRenderer.on('permission:request', (_, data) => callback(data)),
  respondPermission: (toolUseId, decision) => ipcRenderer.send('permission:response', { toolUseId, decision }),
  onAskRequest: (callback) => ipcRenderer.on('ask:request', (_, data) => callback(data)),
  respondAsk: (askId, payload) => ipcRenderer.send('ask:response', { askId, ...payload }),
  removeAllListeners: () => {
    ipcRenderer.removeAllListeners('claude:stream-start');
    ipcRenderer.removeAllListeners('claude:stream-delta');
    ipcRenderer.removeAllListeners('claude:thinking-delta');
    ipcRenderer.removeAllListeners('claude:stream-end');
    ipcRenderer.removeAllListeners('claude:stream-error');
    ipcRenderer.removeAllListeners('claude:stream-close');
    ipcRenderer.removeAllListeners('claude:tool-use');
    ipcRenderer.removeAllListeners('claude:tool-result');
    ipcRenderer.removeAllListeners('claude:compact');
    ipcRenderer.removeAllListeners('claude:usage');
    ipcRenderer.removeAllListeners('permission:request');
    ipcRenderer.removeAllListeners('ask:request');
  }
});

contextBridge.exposeInMainWorld('shellAPI', {
  openExternal: (url) => ipcRenderer.send('shell:open-external', url)
});

contextBridge.exposeInMainWorld('project', {
  pick: () => ipcRenderer.invoke('project:pick'),
});

contextBridge.exposeInMainWorld('files', {
  listDir: (roots, dirPath) => ipcRenderer.invoke('fs:list-dir', roots, dirPath),
  listAll: (roots) => ipcRenderer.invoke('fs:list-all-files', roots),
  searchContent: (roots, query) => ipcRenderer.invoke('fs:search-content', roots, query),
  readFile: (roots, filePath) => ipcRenderer.invoke('fs:read-file', roots, filePath),
  pathInfo: (roots, p) => ipcRenderer.invoke('fs:path-info', roots, p),
  pickAttachments: () => ipcRenderer.invoke('files:pick-attachments'),
});

contextBridge.exposeInMainWorld('memory', {
  list: (query, limit) => ipcRenderer.invoke('context:recall', { query: query || '', limit: limit || 100 }),
  forget: (id) => ipcRenderer.invoke('context:forget', { id }),
});

contextBridge.exposeInMainWorld('git', {
  branch: (cwd) => ipcRenderer.invoke('git:branch', cwd),
  watch: (cwd) => ipcRenderer.send('git:watch', { cwd }),
  unwatch: (cwd) => ipcRenderer.send('git:unwatch', { cwd }),
  onBranchChanged: (cb) => ipcRenderer.on('git:branch-changed', (_, p) => cb(p)),
});

contextBridge.exposeInMainWorld('worktree', {
  add: (projectPath, convId, branch) => ipcRenderer.invoke('worktree:add', { projectPath, convId, branch }),
  remove: (worktreePath, force) => ipcRenderer.invoke('worktree:remove', { worktreePath, force: !!force }),
  status: (worktreePath) => ipcRenderer.invoke('worktree:status', { worktreePath }),
});

contextBridge.exposeInMainWorld('gh', {
  authStatus: () => ipcRenderer.invoke('gh:auth-status'),
  repoInfo: (cwd) => ipcRenderer.invoke('gh:repo-info', cwd),
  prList: (cwd, filter) => ipcRenderer.invoke('gh:pr-list', { cwd, filter }),
  prDetail: (cwd, number) => ipcRenderer.invoke('gh:pr-detail', { cwd, number }),
  prComment: (cwd, number, body) => ipcRenderer.invoke('gh:pr-comment', { cwd, number, body }),
  prReplyReview: (cwd, number, inReplyTo, body) => ipcRenderer.invoke('gh:pr-reply-review', { cwd, number, inReplyTo, body }),
});

contextBridge.exposeInMainWorld('terminal', {
  open: (params) => ipcRenderer.send('terminal:open', params),
  input: (termId, data) => ipcRenderer.send('terminal:input', { termId, data }),
  resize: (termId, cols, rows) => ipcRenderer.send('terminal:resize', { termId, cols, rows }),
  kill: (termId) => ipcRenderer.send('terminal:kill', { termId }),
  exists: (termId) => ipcRenderer.invoke('terminal:exists', { termId }),
  onData: (cb) => ipcRenderer.on('terminal:data', (_, payload) => cb(payload)),
  onExit: (cb) => ipcRenderer.on('terminal:exit', (_, payload) => cb(payload)),
});

