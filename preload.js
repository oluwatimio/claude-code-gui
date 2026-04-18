const { contextBridge, ipcRenderer } = require('electron');
const { marked } = require('marked');
const hljs = require('highlight.js/lib/common');

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
  sendPrompt: (prompt, sessionId, isFirst, yolo, projectPath, model, extraDirs) => ipcRenderer.send('claude:send-prompt', { prompt, sessionId, isFirst, yolo, projectPath, model, extraDirs }),
  stopGeneration: () => ipcRenderer.send('claude:stop-generation'),
  onStreamStart: (callback) => ipcRenderer.on('claude:stream-start', (_, data) => callback(data)),
  onStreamDelta: (callback) => ipcRenderer.on('claude:stream-delta', (_, data) => callback(data)),
  onThinkingDelta: (callback) => ipcRenderer.on('claude:thinking-delta', (_, data) => callback(data)),
  onStreamEnd: (callback) => ipcRenderer.on('claude:stream-end', (_, data) => callback(data)),
  onStreamError: (callback) => ipcRenderer.on('claude:stream-error', (_, error) => callback(error)),
  onStreamClose: (callback) => ipcRenderer.on('claude:stream-close', (_, data) => callback(data)),
  onToolUse: (callback) => ipcRenderer.on('claude:tool-use', (_, data) => callback(data)),
  onPermissionRequest: (callback) => ipcRenderer.on('permission:request', (_, data) => callback(data)),
  respondPermission: (decision) => ipcRenderer.send('permission:response', decision),
  removeAllListeners: () => {
    ipcRenderer.removeAllListeners('claude:stream-start');
    ipcRenderer.removeAllListeners('claude:stream-delta');
    ipcRenderer.removeAllListeners('claude:thinking-delta');
    ipcRenderer.removeAllListeners('claude:stream-end');
    ipcRenderer.removeAllListeners('claude:stream-error');
    ipcRenderer.removeAllListeners('claude:stream-close');
    ipcRenderer.removeAllListeners('claude:tool-use');
    ipcRenderer.removeAllListeners('permission:request');
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
  readFile: (roots, filePath) => ipcRenderer.invoke('fs:read-file', roots, filePath),
  pathInfo: (roots, p) => ipcRenderer.invoke('fs:path-info', roots, p),
});

contextBridge.exposeInMainWorld('git', {
  branch: (cwd) => ipcRenderer.invoke('git:branch', cwd),
  watch: (cwd) => ipcRenderer.send('git:watch', { cwd }),
  unwatch: (cwd) => ipcRenderer.send('git:unwatch', { cwd }),
  onBranchChanged: (cb) => ipcRenderer.on('git:branch-changed', (_, p) => cb(p)),
});

contextBridge.exposeInMainWorld('terminal', {
  open: (params) => ipcRenderer.send('terminal:open', params),
  input: (sessionId, data) => ipcRenderer.send('terminal:input', { sessionId, data }),
  resize: (sessionId, cols, rows) => ipcRenderer.send('terminal:resize', { sessionId, cols, rows }),
  kill: (sessionId) => ipcRenderer.send('terminal:kill', { sessionId }),
  exists: (sessionId) => ipcRenderer.invoke('terminal:exists', { sessionId }),
  onData: (cb) => ipcRenderer.on('terminal:data', (_, payload) => cb(payload)),
  onExit: (cb) => ipcRenderer.on('terminal:exit', (_, payload) => cb(payload)),
});

