// ===== State =====
const state = {
  conversations: [],
  currentConversationId: null,
  yolo: false,
  workspaceOpen: false,
  wsTreeHeight: 260,
  sidebarWidth: 260,
  workspaceWidth: 480,
  terminalOpen: false,
  terminalHeight: 240,
};

// Per-conversation DOM + timer refs (not persisted)
const assistantElByConv = new Map(); // convId -> HTMLElement
const throttleTimerByConv = new Map(); // convId -> timeout id

function getConversation(id) {
  return state.conversations.find(c => c.id === id);
}

function isCurrentConv(convId) {
  return convId && convId === state.currentConversationId;
}

function effectiveProjectPath(conv) {
  if (!conv) return null;
  return conv.worktreePath || conv.projectPath || null;
}

// ===== DOM Elements =====
const welcomeEl = document.getElementById('welcome');
const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('prompt-input');
const sendBtn = document.getElementById('send-btn');
const stopBtn = document.getElementById('stop-btn');
const statusText = document.getElementById('status-text');
const costDisplay = document.getElementById('cost-display');
const newChatBtn = document.getElementById('new-chat-btn');
const conversationList = document.getElementById('conversation-list');
const toggleSidebarBtn = document.getElementById('toggle-sidebar-btn');
const sidebar = document.getElementById('sidebar');
const projectPill = document.getElementById('project-pill');
const projectLabel = document.getElementById('project-label');
const extraDirsList = document.getElementById('extra-dirs-list');
const addDirBtn = document.getElementById('add-dir-btn');
const modelSelector = document.getElementById('model-selector');
const modelLabel = document.getElementById('model-label');
const modelMenu = document.getElementById('model-menu');
const workspacePanel = document.getElementById('workspace-panel');
const wsTabsEl = document.getElementById('ws-tabs');
const wsTreeEl = document.getElementById('ws-tree');
const wsTilesEl = document.getElementById('ws-tiles');
const wsVSplitter = document.getElementById('ws-vsplitter');
const toggleWorkspaceBtn = document.getElementById('btn-toggle-workspace');
const sidebarResizeEl = document.getElementById('sidebar-resize');
const workspaceResizeEl = document.getElementById('workspace-resize');
const chatArea = document.getElementById('chat-area');
const terminalPanel = document.getElementById('terminal-panel');
const terminalBody = document.getElementById('terminal-body');
const terminalHandle = document.getElementById('terminal-resize-handle');
const terminalLabel = document.getElementById('terminal-label');
const toggleTerminalBtn = document.getElementById('btn-toggle-terminal');
const killTerminalBtn = document.getElementById('btn-terminal-kill');
const closeTerminalBtn = document.getElementById('btn-terminal-close');
const branchPill = document.getElementById('branch-pill');
const branchLabel = document.getElementById('branch-label');
const worktreeBtn = document.getElementById('worktree-btn');
const sidebarTabs = document.querySelectorAll('.sidebar-tab');
const chatsPanelEl = document.getElementById('chats-panel');
const memoriesPanelEl = document.getElementById('memories-panel');
const memorySearchEl = document.getElementById('memory-search');
const memoryListEl = document.getElementById('memory-list');

// Model options. `value: null` means "don't pass --model" (use user's global default).
// Label = what humans read. id = the literal CLI value passed via --model.
const MODELS = [
  { section: 'Default' },
  { label: 'Use global default', short: 'Default', value: null, id: 'from ~/.claude/settings.json' },

  { section: 'Current versions' },
  { label: 'Opus 4.7',              short: 'Opus 4.7',     value: 'claude-opus-4-7',           id: 'claude-opus-4-7' },
  { label: 'Opus 4.7 · 1M context', short: 'Opus 4.7 1M',  value: 'claude-opus-4-7[1m]',       id: 'claude-opus-4-7[1m]' },
  { label: 'Sonnet 4.6',            short: 'Sonnet 4.6',   value: 'claude-sonnet-4-6',         id: 'claude-sonnet-4-6' },
  { label: 'Haiku 4.5',             short: 'Haiku 4.5',    value: 'claude-haiku-4-5-20251001', id: 'claude-haiku-4-5-20251001' },

  { section: 'Track latest (auto-updates)' },
  { label: 'Latest Opus',               short: 'opus',     value: 'opus',     id: 'opus' },
  { label: 'Latest Opus · 1M context',  short: 'opus 1M',  value: 'opus[1m]', id: 'opus[1m]' },
  { label: 'Latest Sonnet',             short: 'sonnet',   value: 'sonnet',   id: 'sonnet' },
  { label: 'Latest Haiku',              short: 'haiku',    value: 'haiku',    id: 'haiku' },
];

function findModelLabel(value) {
  if (value == null) return 'Default';
  const m = MODELS.find(o => !o.section && o.value === value);
  return m ? m.short : value;
}

// ===== Helpers =====
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function renderMarkdown(text) {
  return window.libs.renderMarkdown(text);
}

function basename(p) {
  if (!p) return '';
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] || p;
}

let currentBranchWatchCwd = null;

async function refreshBranch() {
  const conv = getCurrentConversation();
  const cwd = effectiveProjectPath(conv);
  if (!cwd) {
    branchPill.classList.add('hidden');
    branchLabel.textContent = '';
    if (currentBranchWatchCwd) {
      window.git.unwatch(currentBranchWatchCwd);
      currentBranchWatchCwd = null;
    }
    return;
  }
  if (currentBranchWatchCwd !== cwd) {
    if (currentBranchWatchCwd) window.git.unwatch(currentBranchWatchCwd);
    window.git.watch(cwd);
    currentBranchWatchCwd = cwd;
  }
  try {
    const branch = await window.git.branch(cwd);
    if (branch) {
      branchLabel.textContent = branch;
      branchPill.title = `Branch: ${branch} · click to refresh`;
      branchPill.classList.remove('hidden');
    } else {
      branchPill.classList.add('hidden');
    }
  } catch (e) {
    branchPill.classList.add('hidden');
  }
}

function renderProjectPill() {
  const conv = getCurrentConversation();
  const path = conv && conv.projectPath;
  if (path) {
    projectLabel.textContent = basename(path);
    projectPill.title = conv.worktreePath ? `${path}\n(worktree: ${conv.worktreePath})` : path;
    projectPill.classList.add('has-project');
  } else {
    projectLabel.textContent = 'No project';
    projectPill.title = 'Select project folder';
    projectPill.classList.remove('has-project');
  }
  renderExtraDirs();
  renderWorktreeBtn();
}

function renderWorktreeBtn() {
  if (!worktreeBtn) return;
  const conv = getCurrentConversation();
  if (!conv || !conv.projectPath) {
    worktreeBtn.classList.add('hidden');
    return;
  }
  worktreeBtn.classList.remove('hidden');
  if (conv.worktreePath) {
    worktreeBtn.classList.add('active');
    worktreeBtn.title = `Worktree: ${conv.worktreeBranch || conv.worktreePath}\nClick to remove`;
    const label = worktreeBtn.querySelector('#worktree-label');
    if (label) label.textContent = conv.worktreeBranch || 'Worktree';
  } else {
    worktreeBtn.classList.remove('active');
    worktreeBtn.title = 'Isolate this chat in a git worktree';
    const label = worktreeBtn.querySelector('#worktree-label');
    if (label) label.textContent = 'Worktree';
  }
}

function renderExtraDirs() {
  extraDirsList.innerHTML = '';
  const conv = getCurrentConversation();
  const dirs = (conv && conv.extraDirs) || [];
  for (const dir of dirs) {
    const chip = document.createElement('div');
    chip.className = 'extra-dir-chip';
    chip.title = dir;

    const label = document.createElement('span');
    label.className = 'extra-dir-label';
    label.textContent = basename(dir);
    chip.appendChild(label);

    const remove = document.createElement('button');
    remove.className = 'extra-dir-remove';
    remove.type = 'button';
    remove.title = 'Remove';
    remove.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
      <path d="M18 6L6 18M6 6l12 12"/>
    </svg>`;
    remove.onclick = () => {
      const c = getCurrentConversation();
      if (!c || !c.extraDirs) return;
      c.extraDirs = c.extraDirs.filter(d => d !== dir);
      saveState();
      renderExtraDirs();
      renderWsTabs();
      renderWsTree();
    };
    chip.appendChild(remove);

    extraDirsList.appendChild(chip);
  }
}

function renderModelSelector() {
  const conv = getCurrentConversation();
  const current = conv ? (conv.model ?? null) : null;
  modelLabel.textContent = findModelLabel(current);
  modelSelector.title = current == null
    ? 'Using global default model · click to change'
    : `Model: ${current} · click to change`;
}

function buildModelMenu() {
  const conv = getCurrentConversation();
  const current = conv ? (conv.model ?? null) : null;
  modelMenu.innerHTML = '';
  for (const entry of MODELS) {
    if (entry.section) {
      const h = document.createElement('div');
      h.className = 'model-section-header';
      h.textContent = entry.section;
      modelMenu.appendChild(h);
      continue;
    }
    const opt = document.createElement('div');
    opt.className = 'model-option' + (entry.value === current ? ' active' : '');
    const lbl = document.createElement('span');
    lbl.className = 'model-option-label';
    lbl.textContent = entry.label;
    const id = document.createElement('span');
    id.className = 'model-option-id';
    id.textContent = entry.id;
    opt.appendChild(lbl);
    opt.appendChild(id);
    opt.onclick = () => {
      let c = getCurrentConversation();
      if (!c) c = createConversation('New Chat');
      c.model = entry.value;
      saveState();
      renderModelSelector();
      closeModelMenu();
    };
    modelMenu.appendChild(opt);
  }
}

function openModelMenu() {
  buildModelMenu();
  modelMenu.classList.remove('hidden');
  modelSelector.classList.add('open');
}

function closeModelMenu() {
  modelMenu.classList.add('hidden');
  modelSelector.classList.remove('open');
}

// ===== Message Rendering =====
function createThinkingBlock(text, expanded = false) {
  const wrap = document.createElement('div');
  wrap.className = 'thinking-block' + (expanded ? ' expanded' : '');
  wrap.innerHTML = `
    <button class="thinking-toggle" type="button">
      <svg class="thinking-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="6 9 12 15 18 9"/>
      </svg>
      <span class="thinking-label">Thinking</span>
    </button>
    <div class="thinking-body"></div>
  `;
  const body = wrap.querySelector('.thinking-body');
  body.textContent = text || '';
  wrap.querySelector('.thinking-toggle').addEventListener('click', () => {
    wrap.classList.toggle('expanded');
  });
  return wrap;
}

function createMessageEl(role, content, isStreaming = false, thinking = '') {
  const msg = document.createElement('div');
  msg.className = `message message-${role}`;

  const header = document.createElement('div');
  header.className = 'message-header';

  const avatar = document.createElement('div');
  avatar.className = `message-avatar avatar-${role}`;

  if (role === 'user') {
    avatar.textContent = 'Y';
  } else if (role === 'assistant') {
    avatar.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" fill="currentColor"/>
    </svg>`;
  } else {
    avatar.textContent = '!';
    avatar.style.background = 'var(--error-red)';
    avatar.style.color = 'white';
  }

  const roleLabel = document.createElement('span');
  roleLabel.className = 'message-role';
  roleLabel.textContent = role === 'user' ? 'You' : role === 'assistant' ? 'Claude' : 'Error';

  header.appendChild(avatar);
  header.appendChild(roleLabel);

  const body = document.createElement('div');
  body.className = 'message-body';

  if (content) {
    body.innerHTML = role === 'user' ? escapeHtml(content).replace(/\n/g, '<br>') : renderMarkdown(content);
  }

  if (isStreaming && !content) {
    body.innerHTML = `<div class="typing-indicator"><span></span><span></span><span></span></div>`;
  }

  if (isStreaming && content) {
    body.classList.add('streaming-cursor');
  }

  msg.appendChild(header);
  if (role === 'assistant' && thinking) {
    msg.appendChild(createThinkingBlock(thinking, false));
  }
  msg.appendChild(body);
  return msg;
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });
}

// ===== Conversation Management =====
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function createConversation(title) {
  const conv = {
    id: generateId(),
    sessionId: generateUUID(),
    title: title || 'New Chat',
    messages: [],
    createdAt: Date.now(),
    streaming: false,
    streamContent: '',
    streamThinking: '',
    worktreePath: null,
    worktreeBranch: null,
  };
  state.conversations.unshift(conv);
  state.currentConversationId = conv.id;
  saveState();
  renderConversationList();
  return conv;
}

function getCurrentConversation() {
  return state.conversations.find(c => c.id === state.currentConversationId);
}

function switchConversation(id) {
  state.currentConversationId = id;
  const conv = getCurrentConversation();
  if (!conv) return;

  // Re-render messages
  messagesEl.innerHTML = '';
  for (const msg of conv.messages) {
    messagesEl.appendChild(createMessageEl(msg.role, msg.content, false, msg.thinking || ''));
  }

  // If this conversation is streaming, rebuild the live placeholder with accumulated content
  if (conv.streaming) {
    const el = createMessageEl('assistant', conv.streamContent || '', true, conv.streamThinking || '');
    if (conv.streamThinking) {
      const think = el.querySelector(':scope > .thinking-block');
      if (think) think.classList.add('expanded');
    }
    messagesEl.appendChild(el);
    assistantElByConv.set(conv.id, el);
    inputEl.disabled = true;
    sendBtn.classList.add('hidden');
    stopBtn.classList.remove('hidden');
    setStatus('streaming', 'Generating...');
  } else {
    inputEl.disabled = false;
    sendBtn.classList.remove('hidden');
    stopBtn.classList.add('hidden');
    setStatus('ready', 'Ready');
  }

  if (conv.messages.length > 0 || conv.streaming) {
    welcomeEl.classList.add('hidden');
    messagesEl.classList.remove('hidden');
    scrollToBottom();
  } else {
    welcomeEl.classList.remove('hidden');
    messagesEl.classList.add('hidden');
  }

  renderConversationList();
  renderProjectPill();
  refreshBranch();
  renderModelSelector();
  renderWsTabs();
  renderWsTree();
  restoreOpenFiles();
  if (state.terminalOpen) mountTerminal();
  saveState();
}

async function deleteConversation(id) {
  const conv = state.conversations.find(c => c.id === id);
  if (conv && conv.worktreePath) {
    try {
      const st = await window.worktree.status(conv.worktreePath);
      if (st.dirty || st.unpushed) {
        const ok = confirm(
          `Chat has an attached worktree with ${st.dirty ? 'uncommitted changes' : ''}${st.dirty && st.unpushed ? ' and ' : ''}${st.unpushed ? 'unpushed commits' : ''}.\n\n` +
          `Delete the chat and remove the worktree anyway?`
        );
        if (!ok) return;
      }
      await window.worktree.remove(conv.worktreePath, true);
    } catch (e) {
      console.warn('worktree cleanup failed:', e);
    }
  }

  window.claude.stopGeneration(id);
  window.terminal.kill(id);

  const entry = xtermByConv.get(id);
  if (entry) {
    try { entry.term.dispose(); } catch (e) {}
    xtermByConv.delete(id);
  }
  assistantElByConv.delete(id);
  const t = throttleTimerByConv.get(id);
  if (t) { clearTimeout(t); throttleTimerByConv.delete(id); }

  state.conversations = state.conversations.filter(c => c.id !== id);
  if (state.currentConversationId === id) {
    if (state.conversations.length > 0) {
      switchConversation(state.conversations[0].id);
    } else {
      state.currentConversationId = null;
      newChat();
    }
  }
  saveState();
  renderConversationList();
}

function renderConversationList() {
  conversationList.innerHTML = '';
  for (const conv of state.conversations) {
    const item = document.createElement('div');
    item.className = `conversation-item ${conv.id === state.currentConversationId ? 'active' : ''}`;
    item.title = conv.projectPath ? `${conv.title}\n${conv.projectPath}` : conv.title;

    const title = document.createElement('div');
    title.className = 'conv-title';
    title.textContent = conv.title;
    if (conv.streaming) {
      const dot = document.createElement('span');
      dot.className = 'conv-streaming-dot';
      title.appendChild(dot);
    }
    item.appendChild(title);

    if (conv.projectPath) {
      const sub = document.createElement('div');
      sub.className = 'conv-subtitle';
      sub.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
      </svg><span></span>`;
      sub.querySelector('span').textContent = basename(conv.projectPath);
      item.appendChild(sub);
    }

    const delBtn = document.createElement('button');
    delBtn.className = 'delete-btn';
    delBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M18 6L6 18M6 6l12 12" stroke-linecap="round"/>
    </svg>`;
    delBtn.onclick = (e) => {
      e.stopPropagation();
      deleteConversation(conv.id);
    };

    item.appendChild(delBtn);
    item.onclick = () => switchConversation(conv.id);
    conversationList.appendChild(item);
  }
}

function newChat() {
  state.currentConversationId = null;
  messagesEl.innerHTML = '';
  messagesEl.classList.add('hidden');
  welcomeEl.classList.remove('hidden');
  inputEl.value = '';
  autoResize();
  renderConversationList();
  renderProjectPill();
  refreshBranch();
  renderModelSelector();
  wsTilesEl.innerHTML = '';
  renderWsTabs();
  renderWsTree();
  inputEl.focus();
}

// ===== Persistence =====
function saveState() {
  try {
    localStorage.setItem('claude-gui-state', JSON.stringify({
      conversations: state.conversations,
      currentConversationId: state.currentConversationId,
      yolo: state.yolo,
      workspaceOpen: state.workspaceOpen,
      wsTreeHeight: state.wsTreeHeight,
      sidebarWidth: state.sidebarWidth,
      workspaceWidth: state.workspaceWidth,
      terminalOpen: state.terminalOpen,
      terminalHeight: state.terminalHeight,
    }));
  } catch (e) {
    // Silently fail on storage quota
  }
}

function loadState() {
  try {
    const saved = localStorage.getItem('claude-gui-state');
    if (saved) {
      const data = JSON.parse(saved);
      state.conversations = data.conversations || [];
      state.currentConversationId = data.currentConversationId;
      state.yolo = !!data.yolo;
      state.workspaceOpen = !!data.workspaceOpen;
      if (typeof data.wsTreeHeight === 'number' && data.wsTreeHeight > 80) {
        state.wsTreeHeight = data.wsTreeHeight;
      }
      if (typeof data.sidebarWidth === 'number' && data.sidebarWidth >= 180) {
        state.sidebarWidth = data.sidebarWidth;
      }
      if (typeof data.workspaceWidth === 'number' && data.workspaceWidth >= 320) {
        state.workspaceWidth = data.workspaceWidth;
      }
      state.terminalOpen = !!data.terminalOpen;
      if (typeof data.terminalHeight === 'number' && data.terminalHeight >= 120) {
        state.terminalHeight = data.terminalHeight;
      }

      // Reset any in-flight stream flags — processes don't survive app restarts
      for (const conv of state.conversations) {
        conv.streaming = false;
        conv.streamContent = '';
        conv.streamThinking = '';
        if (conv.worktreePath === undefined) conv.worktreePath = null;
        if (conv.worktreeBranch === undefined) conv.worktreeBranch = null;
      }
    }
  } catch (e) {
    // Start fresh
  }
}

// ===== Streaming Integration (per-conversation) =====

function sendMessage(prompt) {
  if (!prompt.trim()) return;

  let conv = getCurrentConversation();
  if (!conv) {
    const title = prompt.slice(0, 50) + (prompt.length > 50 ? '...' : '');
    conv = createConversation(title);
  }

  if (conv.streaming) return; // don't allow concurrent sends within the same conv

  welcomeEl.classList.add('hidden');
  messagesEl.classList.remove('hidden');

  conv.messages.push({ role: 'user', content: prompt });
  messagesEl.appendChild(createMessageEl('user', prompt));
  scrollToBottom();
  saveState();

  conv.streaming = true;
  conv.streamContent = '';
  conv.streamThinking = '';

  const assistantEl = createMessageEl('assistant', '', true);
  messagesEl.appendChild(assistantEl);
  assistantElByConv.set(conv.id, assistantEl);
  scrollToBottom();

  inputEl.value = '';
  autoResize();
  inputEl.disabled = true;
  sendBtn.classList.add('hidden');
  stopBtn.classList.remove('hidden');
  setStatus('streaming', 'Thinking...');

  const isFirstMessage = conv.messages.length === 1;
  window.claude.sendPrompt(conv.id, prompt, conv.sessionId, isFirstMessage, state.yolo, effectiveProjectPath(conv), conv.model ?? null, conv.extraDirs ?? []);
  renderConversationList();
}

function handleThinkingDelta(data) {
  if (!data || !data.convId || !data.text) return;
  const conv = getConversation(data.convId);
  if (!conv) return;
  conv.streamThinking = (conv.streamThinking || '') + data.text;

  if (!isCurrentConv(data.convId)) return;
  const el = assistantElByConv.get(data.convId);
  if (!el) return;
  let block = el.querySelector(':scope > .thinking-block');
  if (!block) {
    block = createThinkingBlock('', true);
    const body = el.querySelector('.message-body');
    el.insertBefore(block, body);
  }
  block.querySelector('.thinking-body').textContent = conv.streamThinking;
  setStatus('streaming', 'Thinking...');
  scrollToBottom();
}

function handleDelta(data) {
  if (!data || !data.convId || !data.text) return;
  const conv = getConversation(data.convId);
  if (!conv) return;
  conv.streamContent = (conv.streamContent || '') + data.text;

  if (!isCurrentConv(data.convId)) return;
  const el = assistantElByConv.get(data.convId);
  if (!el) return;

  // Throttle re-renders per conversation
  if (!throttleTimerByConv.has(data.convId)) {
    throttleTimerByConv.set(data.convId, setTimeout(() => {
      throttleTimerByConv.delete(data.convId);
      const conv2 = getConversation(data.convId);
      const el2 = assistantElByConv.get(data.convId);
      if (!conv2 || !el2) return;
      const body = el2.querySelector('.message-body');
      body.innerHTML = renderMarkdown(conv2.streamContent || '');
      body.classList.add('streaming-cursor');
      if (isCurrentConv(data.convId)) scrollToBottom();
    }, 30));
  }
  setStatus('streaming', 'Generating...');
}

function finalizeStream(convId, { save = true } = {}) {
  const conv = getConversation(convId);
  if (!conv) return;
  const el = assistantElByConv.get(convId);
  const t = throttleTimerByConv.get(convId);
  if (t) { clearTimeout(t); throttleTimerByConv.delete(convId); }

  if (el) {
    const body = el.querySelector('.message-body');
    if (conv.streamContent) {
      body.innerHTML = renderMarkdown(conv.streamContent);
    } else if (!save) {
      body.innerHTML = '<em style="color:var(--text-muted)">Generation stopped</em>';
    }
    body.classList.remove('streaming-cursor');
    const think = el.querySelector(':scope > .thinking-block');
    if (think) think.classList.remove('expanded');
  }

  if (save && (conv.streamContent || conv.streamThinking)) {
    conv.messages.push({
      role: 'assistant',
      content: conv.streamContent || '',
      thinking: conv.streamThinking || ''
    });
  } else if (!save && conv.streamContent) {
    conv.messages.push({
      role: 'assistant',
      content: conv.streamContent,
      thinking: conv.streamThinking || ''
    });
  }

  conv.streaming = false;
  conv.streamContent = '';
  conv.streamThinking = '';
  assistantElByConv.delete(convId);
  saveState();

  if (isCurrentConv(convId)) {
    inputEl.disabled = false;
    sendBtn.classList.remove('hidden');
    stopBtn.classList.add('hidden');
    inputEl.focus();
  }
  renderConversationList();
}

function handleStreamEnd(data) {
  if (!data || !data.convId) return;
  finalizeStream(data.convId, { save: true });

  if (data.cost != null && isCurrentConv(data.convId)) {
    const costStr = `$${data.cost.toFixed(4)}`;
    const durationStr = data.duration ? `${(data.duration / 1000).toFixed(1)}s` : '';
    const modelStr = data.model || '';
    const parts = [costStr, durationStr, modelStr].filter(Boolean);
    costDisplay.textContent = parts.join(' | ');
  }

  if (isCurrentConv(data.convId)) setStatus('ready', 'Ready');
}

function handleStreamError(data) {
  const convId = data && data.convId;
  const errText = (data && (data.error || data)) || 'Unknown error';
  if (!convId) return;
  const conv = getConversation(convId);
  if (!conv) return;

  const el = assistantElByConv.get(convId);
  if (el) {
    el.remove();
    assistantElByConv.delete(convId);
  }
  conv.streaming = false;
  conv.streamContent = '';
  conv.streamThinking = '';

  if (isCurrentConv(convId)) {
    messagesEl.appendChild(createMessageEl('error', `Error: ${errText}`));
    scrollToBottom();
    inputEl.disabled = false;
    sendBtn.classList.remove('hidden');
    stopBtn.classList.add('hidden');
    inputEl.focus();
    setStatus('error', 'Error occurred');
  }
  saveState();
  renderConversationList();
}

function handleStreamClose(data) {
  const convId = data && data.convId;
  const conv = convId ? getConversation(convId) : null;
  if (conv && conv.streaming) {
    finalizeStream(convId, { save: true });
  }
}

function stopGeneration(convId) {
  const target = convId || state.currentConversationId;
  if (!target) return;
  window.claude.stopGeneration(target);
  finalizeStream(target, { save: false });
  if (isCurrentConv(target)) setStatus('ready', 'Stopped');
}

// ===== Status =====
function setStatus(type, text) {
  const dotClass = type === 'streaming' ? 'streaming' : type === 'error' ? 'error' : 'ready';
  statusText.innerHTML = `<span class="status-dot ${dotClass}"></span> ${text}`;
}

// ===== Auto-resize textarea =====
function autoResize() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
}

// ===== Copy code handler =====
function handleCopyClick(e) {
  const btn = e.target.closest('.copy-btn');
  if (!btn) return;

  const code = btn.getAttribute('data-code');
  if (!code) return;

  // Decode HTML entities
  const textarea = document.createElement('textarea');
  textarea.innerHTML = code;
  const decoded = textarea.value;

  navigator.clipboard.writeText(decoded).then(() => {
    const label = btn.querySelector('span');
    const origText = label.textContent;
    label.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => {
      label.textContent = origText;
      btn.classList.remove('copied');
    }, 2000);
  });
}

// ===== External link handler =====
function handleLinkClick(e) {
  const link = e.target.closest('a');
  if (link && link.href && link.href.startsWith('http')) {
    e.preventDefault();
    window.shellAPI.openExternal(link.href);
  }
}

// ===== Permission Dialog =====
const permOverlay = document.getElementById('permission-overlay');
const permToolName = document.getElementById('perm-tool-name');
const permInputDisplay = document.getElementById('perm-input-display');
const permAllowBtn = document.getElementById('perm-allow');
const permDenyBtn = document.getElementById('perm-deny');

function showPermissionDialog(data) {
  permToolName.textContent = data.toolName;

  // Format the tool input for display
  let displayText = '';
  const input = data.input || {};
  if (data.toolName === 'Bash' && input.command) {
    displayText = `$ ${input.command}`;
  } else if (data.toolName === 'Write' && input.file_path) {
    displayText = `File: ${input.file_path}\n\n${(input.content || '').slice(0, 500)}${(input.content || '').length > 500 ? '\n...' : ''}`;
  } else if (data.toolName === 'Edit' && input.file_path) {
    displayText = `File: ${input.file_path}\n\nOld: ${input.old_string || ''}\nNew: ${input.new_string || ''}`;
  } else if (data.toolName === 'Read' && input.file_path) {
    displayText = `File: ${input.file_path}`;
  } else {
    displayText = JSON.stringify(input, null, 2);
  }
  permInputDisplay.textContent = displayText;

  permOverlay.classList.remove('hidden');
  permAllowBtn.focus();
}

function hidePermissionDialog() {
  permOverlay.classList.add('hidden');
}

// ===== Event Listeners =====
// ===== Workspace Panel =====
function workspaceRoots(conv) {
  const c = conv || getCurrentConversation();
  if (!c) return [];
  const roots = [];
  const primary = effectiveProjectPath(c);
  if (primary) roots.push(primary);
  if (Array.isArray(c.extraDirs)) {
    for (const d of c.extraDirs) if (d) roots.push(d);
  }
  return roots;
}

function ensureWsState(conv) {
  if (!conv) return;
  if (!Array.isArray(conv.openFiles)) conv.openFiles = [];
  if (!conv.expandedDirs || typeof conv.expandedDirs !== 'object') conv.expandedDirs = {};
  if (conv.activeWsTab === undefined) conv.activeWsTab = null;
}

function applyWorkspaceVisibility() {
  workspacePanel.classList.toggle('collapsed', !state.workspaceOpen);
  toggleWorkspaceBtn.classList.toggle('active', state.workspaceOpen);
}

function toggleWorkspace() {
  state.workspaceOpen = !state.workspaceOpen;
  applyWorkspaceVisibility();
  saveState();
  if (state.workspaceOpen) {
    renderWsTabs();
    renderWsTree();
  }
}

function renderWsEmpty(msg) {
  wsTabsEl.innerHTML = '';
  wsTreeEl.innerHTML = `<div class="ws-empty">${escapeHtml(msg)}</div>`;
}

function renderWsTabs() {
  const conv = getCurrentConversation();
  if (!conv) { renderWsEmpty('No chat'); return; }
  ensureWsState(conv);
  const roots = workspaceRoots();
  if (roots.length === 0) { renderWsEmpty('No project selected'); return; }
  if (!conv.activeWsTab || !roots.includes(conv.activeWsTab)) {
    conv.activeWsTab = roots[0];
  }
  wsTabsEl.innerHTML = '';
  for (const r of roots) {
    const tab = document.createElement('button');
    tab.className = 'ws-tab' + (r === conv.activeWsTab ? ' active' : '');
    tab.type = 'button';
    tab.title = r;
    tab.textContent = basename(r);
    tab.addEventListener('click', () => {
      const c = getCurrentConversation();
      if (!c) return;
      c.activeWsTab = r;
      saveState();
      renderWsTabs();
      renderWsTree();
    });
    wsTabsEl.appendChild(tab);
  }
}

async function renderWsTree() {
  const conv = getCurrentConversation();
  if (!conv) { wsTreeEl.innerHTML = ''; return; }
  ensureWsState(conv);
  const root = conv.activeWsTab;
  if (!root) { wsTreeEl.innerHTML = '<div class="ws-empty">No project selected</div>'; return; }

  wsTreeEl.innerHTML = '';
  const rootUl = document.createElement('ul');
  rootUl.className = 'ws-tree-list';
  wsTreeEl.appendChild(rootUl);
  await mountTreeChildren(rootUl, root, 0);
}

async function mountTreeChildren(ulEl, dirPath, depth) {
  const conv = getCurrentConversation();
  if (!conv) return;
  const roots = workspaceRoots();
  let entries;
  try {
    entries = await window.files.listDir(roots, dirPath);
  } catch (e) {
    const err = document.createElement('li');
    err.className = 'ws-tree-error';
    err.textContent = `Cannot read: ${e.message || e}`;
    ulEl.appendChild(err);
    return;
  }
  if (entries.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'ws-tree-empty';
    empty.textContent = '(empty)';
    empty.style.paddingLeft = `${12 + depth * 14}px`;
    ulEl.appendChild(empty);
    return;
  }
  for (const entry of entries) {
    const li = document.createElement('li');
    li.className = 'ws-tree-node' + (entry.isDir ? ' is-dir' : ' is-file');
    const row = document.createElement('div');
    row.className = 'ws-tree-row';
    row.style.paddingLeft = `${6 + depth * 14}px`;
    row.title = entry.path;

    const chevron = document.createElement('span');
    chevron.className = 'ws-tree-chevron';
    chevron.innerHTML = entry.isDir
      ? `<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>`
      : '';

    const icon = document.createElement('span');
    icon.className = 'ws-tree-icon';
    icon.innerHTML = entry.isDir
      ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`
      : `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;

    const label = document.createElement('span');
    label.className = 'ws-tree-label';
    label.textContent = entry.name;

    row.appendChild(chevron);
    row.appendChild(icon);
    row.appendChild(label);
    li.appendChild(row);

    if (entry.isDir) {
      const childUl = document.createElement('ul');
      childUl.className = 'ws-tree-list';
      li.appendChild(childUl);
      const expanded = !!conv.expandedDirs[entry.path];
      if (expanded) {
        li.classList.add('expanded');
        mountTreeChildren(childUl, entry.path, depth + 1);
      }
      row.addEventListener('click', async () => {
        const c = getCurrentConversation();
        if (!c) return;
        const isOpen = li.classList.toggle('expanded');
        if (isOpen) {
          c.expandedDirs[entry.path] = true;
          if (!childUl.hasChildNodes()) {
            await mountTreeChildren(childUl, entry.path, depth + 1);
          }
        } else {
          delete c.expandedDirs[entry.path];
          childUl.innerHTML = '';
        }
        saveState();
      });
    } else {
      row.addEventListener('click', () => openFile(entry.path));
    }

    ulEl.appendChild(li);
  }
}

function findPane(filePath) {
  return wsTilesEl.querySelector(`.ws-pane[data-path="${cssEscape(filePath)}"]`);
}

function cssEscape(s) {
  return String(s).replace(/["\\]/g, '\\$&');
}

function pulseHeader(pane) {
  const header = pane.querySelector('.ws-pane-header');
  if (!header) return;
  header.classList.remove('pulse');
  // restart animation
  void header.offsetWidth;
  header.classList.add('pulse');
}

async function openFile(filePath, opts = {}) {
  const conv = getCurrentConversation();
  if (!conv) return;
  ensureWsState(conv);
  const roots = workspaceRoots();
  if (roots.length === 0) return;
  if (!state.workspaceOpen) {
    state.workspaceOpen = true;
    applyWorkspaceVisibility();
    saveState();
  }

  const existing = findPane(filePath);
  if (existing) {
    pulseHeader(existing);
    await refreshPaneBody(existing, filePath);
    existing.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
    return;
  }

  let width = 420;
  const stored = conv.openFiles.find(f => f.path === filePath);
  if (stored && typeof stored.width === 'number') width = stored.width;

  const pane = document.createElement('div');
  pane.className = 'ws-pane';
  pane.dataset.path = filePath;
  pane.style.width = `${width}px`;

  const header = document.createElement('div');
  header.className = 'ws-pane-header';
  const title = document.createElement('div');
  title.className = 'ws-pane-title';
  const name = document.createElement('span');
  name.className = 'ws-pane-name';
  name.textContent = basename(filePath);
  const dir = document.createElement('span');
  dir.className = 'ws-pane-dir';
  dir.textContent = ' · ' + relativeToRoot(filePath, roots);
  title.appendChild(name);
  title.appendChild(dir);
  title.title = filePath;

  const close = document.createElement('button');
  close.className = 'ws-pane-close';
  close.type = 'button';
  close.title = 'Close';
  close.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>`;
  close.addEventListener('click', (e) => {
    e.stopPropagation();
    closeFile(filePath);
  });

  header.appendChild(title);
  header.appendChild(close);

  const body = document.createElement('div');
  body.className = 'ws-pane-body';
  body.innerHTML = '<div class="ws-pane-loading">Loading…</div>';

  const resize = document.createElement('div');
  resize.className = 'ws-pane-resize';

  pane.appendChild(header);
  pane.appendChild(body);
  pane.appendChild(resize);

  wsTilesEl.appendChild(pane);
  setupPaneResize(pane, resize);

  if (!stored) {
    conv.openFiles.push({ path: filePath, width });
    saveState();
  }

  await refreshPaneBody(pane, filePath);
  if (opts.pulse) pulseHeader(pane);
  if (!opts.silent) {
    wsTilesEl.scrollTo({ left: wsTilesEl.scrollWidth, behavior: 'smooth' });
  }
}

async function refreshPaneBody(pane, filePath) {
  const body = pane.querySelector('.ws-pane-body');
  const roots = workspaceRoots();
  try {
    const res = await window.files.readFile(roots, filePath);
    if (res.tooLarge) {
      body.innerHTML = `<div class="ws-pane-notice">File too large to preview (${formatBytes(res.size)})</div>`;
      return;
    }
    if (res.binary) {
      body.innerHTML = `<div class="ws-pane-notice">Binary file (${formatBytes(res.size)})</div>`;
      return;
    }
    const hl = window.libs.highlightCode(res.content, res.lang || '');
    body.innerHTML = `<pre><code class="hljs language-${hl.language || ''}">${hl.html}</code></pre>`;
  } catch (e) {
    body.innerHTML = `<div class="ws-pane-notice error">${escapeHtml(String(e.message || e))}</div>`;
  }
}

function closeFile(filePath) {
  const conv = getCurrentConversation();
  const pane = findPane(filePath);
  if (pane) pane.remove();
  if (conv) {
    conv.openFiles = (conv.openFiles || []).filter(f => f.path !== filePath);
    saveState();
  }
}

function relativeToRoot(filePath, roots) {
  for (const r of roots) {
    if (!r) continue;
    if (filePath === r) return basename(filePath);
    if (filePath.startsWith(r + '/')) {
      return filePath.slice(r.length + 1).split('/').slice(0, -1).join('/') || basename(r);
    }
  }
  return '';
}

function formatBytes(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function setupPaneResize(pane, handle) {
  let startX = 0, startW = 0, dragging = false;
  handle.addEventListener('mousedown', (e) => {
    dragging = true;
    startX = e.clientX;
    startW = pane.getBoundingClientRect().width;
    document.body.classList.add('ws-resizing-col');
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const next = Math.max(260, Math.min(1200, startW + (e.clientX - startX)));
    pane.style.width = `${next}px`;
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('ws-resizing-col');
    const conv = getCurrentConversation();
    if (!conv) return;
    const p = pane.dataset.path;
    const w = pane.getBoundingClientRect().width;
    const entry = (conv.openFiles || []).find(f => f.path === p);
    if (entry) {
      entry.width = Math.round(w);
      saveState();
    }
  });
}

function applyPanelWidths() {
  sidebar.style.width = `${state.sidebarWidth}px`;
  sidebar.style.minWidth = `${state.sidebarWidth}px`;
  workspacePanel.style.width = `${state.workspaceWidth}px`;
}

const CHAT_MIN_WIDTH = 280;

function setupSideResize(handle, panel, onCommit, { min, edge }) {
  let startX = 0, startW = 0, dragging = false;
  handle.addEventListener('mousedown', (e) => {
    dragging = true;
    startX = e.clientX;
    startW = panel.getBoundingClientRect().width;
    document.body.classList.add('ws-resizing-col');
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const delta = edge === 'right' ? (e.clientX - startX) : (startX - e.clientX);
    const otherPanel = panel === sidebar ? workspacePanel : sidebar;
    const otherWidth = otherPanel.classList.contains('collapsed')
      ? 0
      : otherPanel.getBoundingClientRect().width;
    const dynamicMax = Math.max(min, window.innerWidth - otherWidth - CHAT_MIN_WIDTH);
    const next = Math.max(min, Math.min(dynamicMax, startW + delta));
    panel.style.width = `${next}px`;
    if (edge === 'right') panel.style.minWidth = `${next}px`;
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('ws-resizing-col');
    onCommit(Math.round(panel.getBoundingClientRect().width));
  });
}

function setupVerticalSplit() {
  const treeWrap = document.querySelector('.ws-tree-wrap');
  if (treeWrap) treeWrap.style.flexBasis = `${state.wsTreeHeight}px`;
  let startY = 0, startH = 0, dragging = false;
  wsVSplitter.addEventListener('mousedown', (e) => {
    dragging = true;
    startY = e.clientY;
    startH = treeWrap.getBoundingClientRect().height;
    document.body.classList.add('ws-resizing-row');
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const panelRect = workspacePanel.getBoundingClientRect();
    const max = panelRect.height - 140;
    const next = Math.max(120, Math.min(max, startH + (e.clientY - startY)));
    treeWrap.style.flexBasis = `${next}px`;
    state.wsTreeHeight = Math.round(next);
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('ws-resizing-row');
    saveState();
  });
}

function restoreOpenFiles() {
  wsTilesEl.innerHTML = '';
  const conv = getCurrentConversation();
  if (!conv) return;
  ensureWsState(conv);
  for (const entry of conv.openFiles || []) {
    openFile(entry.path, { silent: true });
  }
}

function extractToolFilePath(data) {
  const i = (data && data.input) || {};
  switch (data && data.name) {
    case 'Read':
    case 'Edit':
    case 'Write':
      return i.file_path || null;
    case 'NotebookEdit':
      return i.notebook_path || null;
    default:
      return null;
  }
}

async function handleAgentToolUse(data) {
  const p = extractToolFilePath(data);
  if (!p) return;
  const convId = data && data.convId;
  const conv = convId ? getConversation(convId) : getCurrentConversation();
  if (!conv) return;
  const roots = workspaceRoots(conv);
  if (roots.length === 0) return;
  try {
    const info = await window.files.pathInfo(roots, p);
    if (!info || !info.exists || info.isDir) return;
  } catch (e) {
    return;
  }
  if (isCurrentConv(conv.id)) {
    openFile(p, { pulse: true });
  } else {
    // Background chat: remember the file for when user switches back
    ensureWsState(conv);
    if (!conv.openFiles.includes(p)) conv.openFiles.push(p);
    saveState();
  }
}

// ===== Terminal =====
const xtermByConv = new Map(); // convId -> { term, fit, element }
let currentTerminalConvId = null;
let terminalResizeRaf = null;

function applyTerminalVisibility() {
  terminalPanel.classList.toggle('collapsed', !state.terminalOpen);
  toggleTerminalBtn.classList.toggle('active', state.terminalOpen);
}

function applyTerminalHeight() {
  terminalPanel.style.height = `${state.terminalHeight}px`;
}

function updateTerminalLabel(conv) {
  const p = effectiveProjectPath(conv);
  const suffix = p ? ` — ${basename(p)}` : '';
  terminalLabel.textContent = `Terminal${suffix}`;
}

function ensureTerminalFor(conv) {
  if (!conv) return null;
  let entry = xtermByConv.get(conv.id);
  if (entry) return entry;

  const monoFont = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || 'monospace';
  const term = new Terminal({
    fontFamily: monoFont,
    fontSize: 12,
    theme: {
      background: '#000000',
      foreground: '#f0f0f0',
      cursor: '#00d26a',
      cursorAccent: '#000000',
      selectionBackground: 'rgba(0, 210, 106, 0.25)',
    },
    cursorBlink: true,
    scrollback: 5000,
    convertEol: true,
    allowProposedApi: true,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  try { term.loadAddon(new WebLinksAddon.WebLinksAddon()); } catch (e) {}
  term.onData((data) => window.terminal.input(conv.id, data));

  const element = document.createElement('div');
  element.className = 'xterm-host';
  element.style.width = '100%';
  element.style.height = '100%';

  entry = { term, fit, element, started: false };
  xtermByConv.set(conv.id, entry);
  return entry;
}

function mountTerminal() {
  const conv = getCurrentConversation();
  if (!conv) return;
  const entry = ensureTerminalFor(conv);
  if (!entry) return;

  // Detach any currently mounted host from terminalBody
  while (terminalBody.firstChild) terminalBody.removeChild(terminalBody.firstChild);
  terminalBody.appendChild(entry.element);

  if (!entry.started) {
    entry.term.open(entry.element);
    entry.started = true;
  }
  fitTerminal(entry, conv.id);
  updateTerminalLabel(conv);
  currentTerminalConvId = conv.id;

  // Spawn PTY if not already spawned (idempotent on main side)
  const cols = entry.term.cols;
  const rows = entry.term.rows;
  window.terminal.open({
    sessionId: conv.id,
    cwd: effectiveProjectPath(conv) || null,
    cols,
    rows,
  });

  setTimeout(() => entry.term.focus(), 50);
}

function unmountTerminal() {
  while (terminalBody.firstChild) terminalBody.removeChild(terminalBody.firstChild);
}

function fitTerminal(entry, sessionId) {
  if (!entry || !entry.started) return;
  try {
    entry.fit.fit();
    const cols = entry.term.cols;
    const rows = entry.term.rows;
    if (sessionId) window.terminal.resize(sessionId, cols, rows);
  } catch (e) {}
}

function scheduleTerminalFit() {
  if (terminalResizeRaf) return;
  terminalResizeRaf = requestAnimationFrame(() => {
    terminalResizeRaf = null;
    if (!state.terminalOpen) return;
    const conv = getCurrentConversation();
    if (!conv) return;
    const entry = xtermByConv.get(conv.id);
    if (!entry) return;
    fitTerminal(entry, conv.id);
  });
}

function toggleTerminal() {
  if (state.terminalOpen) {
    state.terminalOpen = false;
    applyTerminalVisibility();
    unmountTerminal();
    saveState();
    return;
  }
  let conv = getCurrentConversation();
  if (!conv) conv = createConversation('New Chat');
  state.terminalOpen = true;
  applyTerminalVisibility();
  applyTerminalHeight();
  mountTerminal();
  saveState();
}

function onTerminalData({ sessionId, data }) {
  const entry = xtermByConv.get(sessionId);
  if (entry) entry.term.write(data);
}

function onTerminalExit({ sessionId, code }) {
  const entry = xtermByConv.get(sessionId);
  if (entry) entry.term.write(`\r\n\x1b[33m[process exited: ${code}]\x1b[0m\r\n`);
}

function killCurrentTerminal() {
  const conv = getCurrentConversation();
  if (!conv) return;
  window.terminal.kill(conv.id);
  const entry = xtermByConv.get(conv.id);
  if (entry) {
    entry.term.write('\r\n\x1b[31m[killed]\x1b[0m\r\n');
    entry.started = true;
  }
}

function setupTerminalResize() {
  let startY = 0, startH = 0, dragging = false;
  terminalHandle.addEventListener('mousedown', (e) => {
    dragging = true;
    startY = e.clientY;
    startH = terminalPanel.getBoundingClientRect().height;
    document.body.classList.add('ws-resizing-row');
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const maxH = Math.max(160, chatArea.clientHeight - 180);
    const next = Math.max(120, Math.min(maxH, startH - (e.clientY - startY)));
    terminalPanel.style.height = `${next}px`;
    state.terminalHeight = Math.round(next);
    scheduleTerminalFit();
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('ws-resizing-row');
    saveState();
    scheduleTerminalFit();
  });
}

function setupTerminalAutoFit() {
  if (typeof ResizeObserver === 'undefined') return;
  const ro = new ResizeObserver(() => scheduleTerminalFit());
  ro.observe(terminalBody);
  window.addEventListener('resize', scheduleTerminalFit);
}

// ===== Inline Prompt Dialog (Electron has no window.prompt) =====
function promptInline(title, description, defaultValue = '') {
  return new Promise((resolve) => {
    const overlay = document.getElementById('prompt-overlay');
    const titleEl = document.getElementById('prompt-title');
    const descEl = document.getElementById('prompt-description');
    const field = document.getElementById('prompt-input-field');
    const okBtn = document.getElementById('prompt-ok');
    const cancelBtn = document.getElementById('prompt-cancel');

    titleEl.textContent = title;
    descEl.textContent = description || '';
    descEl.style.display = description ? '' : 'none';
    field.value = defaultValue;
    overlay.classList.remove('hidden');
    setTimeout(() => { field.focus(); field.select(); }, 0);

    const cleanup = () => {
      overlay.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      field.removeEventListener('keydown', onKey);
    };
    const onOk = () => { const v = field.value; cleanup(); resolve(v || null); };
    const onCancel = () => { cleanup(); resolve(null); };
    const onKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); onOk(); }
      else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    };
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    field.addEventListener('keydown', onKey);
  });
}

// ===== Worktree =====
function restartTerminalForConv(convId) {
  window.terminal.kill(convId);
  const entry = xtermByConv.get(convId);
  if (entry) {
    try { entry.term.dispose(); } catch (e) {}
    xtermByConv.delete(convId);
  }
  if (state.terminalOpen && currentTerminalConvId === convId) {
    currentTerminalConvId = null;
    mountTerminal();
  }
}

async function toggleWorktree() {
  const conv = getCurrentConversation();
  if (!conv || !conv.projectPath) return;

  if (conv.worktreePath) {
    // Removing
    let force = false;
    try {
      const st = await window.worktree.status(conv.worktreePath);
      if (st.dirty || st.unpushed) {
        const parts = [];
        if (st.dirty) parts.push('uncommitted changes');
        if (st.unpushed) parts.push('unpushed commits');
        const ok = confirm(`Worktree has ${parts.join(' and ')}. Remove anyway?`);
        if (!ok) return;
        force = true;
      }
    } catch (e) {
      // Status failed (e.g., worktree already gone on disk). Force remove.
      force = true;
    }
    try {
      await window.worktree.remove(conv.worktreePath, force || true);
    } catch (e) {
      alert('Failed to remove worktree: ' + (e.message || e));
      return;
    }
    conv.worktreePath = null;
    conv.worktreeBranch = null;
    saveState();
    renderProjectPill();
    refreshBranch();
    renderWsTabs();
    renderWsTree();
    renderConversationList();
    restartTerminalForConv(conv.id);
    return;
  }

  // Adding
  const suggestion = `claude/${conv.id.slice(0, 8)}`;
  const branch = await promptInline(
    'New git worktree',
    `Creates a new branch from ${basename(conv.projectPath)} and isolates this chat in it.`,
    suggestion
  );
  if (!branch || !branch.trim()) return;
  try {
    const res = await window.worktree.add(conv.projectPath, conv.id, branch.trim());
    conv.worktreePath = res.worktreePath;
    conv.worktreeBranch = res.branch;
    saveState();
    renderProjectPill();
    refreshBranch();
    renderWsTabs();
    renderWsTree();
    renderConversationList();
    restartTerminalForConv(conv.id);
  } catch (e) {
    alert('Failed to create worktree: ' + (e.message || e));
  }
}

// ===== Sidebar Tabs / Memories =====
let currentSidebarTab = 'chats';
let memorySearchDebounce = null;

function switchSidebarTab(name) {
  if (name !== 'chats' && name !== 'memories') return;
  currentSidebarTab = name;
  sidebarTabs.forEach(t => t.classList.toggle('active', t.getAttribute('data-tab') === name));
  chatsPanelEl.classList.toggle('active', name === 'chats');
  memoriesPanelEl.classList.toggle('active', name === 'memories');
  if (name === 'memories') {
    renderMemories(memorySearchEl.value.trim());
  }
}

function formatMemoryDate(ts) {
  if (!ts) return '';
  const now = Date.now();
  const diff = now - ts;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  if (d < 7) return `${d}d ago`;
  const date = new Date(ts);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

async function renderMemories(query = '') {
  memoryListEl.innerHTML = '<div class="memory-empty">Loading...</div>';
  let res;
  try {
    res = await window.memory.list(query, 200);
  } catch (e) {
    memoryListEl.innerHTML = `<div class="memory-empty">Error: ${escapeHtml(e.message || String(e))}</div>`;
    return;
  }
  const memories = (res && res.memories) || [];
  if (res && res.error) {
    memoryListEl.innerHTML = `<div class="memory-empty">Error: ${escapeHtml(res.error)}</div>`;
    return;
  }
  if (memories.length === 0) {
    memoryListEl.innerHTML = query
      ? `<div class="memory-empty">No memories match "${escapeHtml(query)}"</div>`
      : '<div class="memory-empty">No memories yet. Click "Save memory" after a chat to keep context for next time.</div>';
    return;
  }
  memoryListEl.innerHTML = '';
  memories.forEach(m => {
    const item = document.createElement('div');
    item.className = 'memory-item';
    item.dataset.id = m.id;

    const content = document.createElement('div');
    content.className = 'memory-content';
    content.textContent = m.content || '';
    item.appendChild(content);

    const meta = document.createElement('div');
    meta.className = 'memory-meta';
    if (m.category) {
      const cat = document.createElement('span');
      cat.className = 'memory-category';
      cat.textContent = m.category;
      meta.appendChild(cat);
    }
    (m.tags || []).forEach(tag => {
      const t = document.createElement('span');
      t.className = 'memory-tag';
      t.textContent = tag;
      meta.appendChild(t);
    });
    const date = document.createElement('span');
    date.className = 'memory-date';
    date.textContent = formatMemoryDate(m.createdAt);
    meta.appendChild(date);
    item.appendChild(meta);

    const forget = document.createElement('button');
    forget.className = 'memory-forget';
    forget.title = 'Forget this memory';
    forget.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>';
    forget.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ok = confirm('Forget this memory? This cannot be undone.');
      if (!ok) return;
      try {
        await window.memory.forget(m.id);
        item.remove();
        if (memoryListEl.childElementCount === 0) {
          renderMemories(memorySearchEl.value.trim());
        }
      } catch (err) {
        alert('Failed to forget: ' + (err.message || String(err)));
      }
    });
    item.appendChild(forget);

    item.addEventListener('click', () => {
      item.classList.toggle('expanded');
    });

    memoryListEl.appendChild(item);
  });
}

function init() {
  // Load state
  loadState();
  if (state.currentConversationId) {
    switchConversation(state.currentConversationId);
  }
  renderConversationList();
  renderProjectPill();
  refreshBranch();
  renderModelSelector();
  applyPanelWidths();
  applyWorkspaceVisibility();
  renderWsTabs();
  renderWsTree();
  restoreOpenFiles();
  setupVerticalSplit();
  if (state.terminalOpen && !getCurrentConversation()) state.terminalOpen = false;
  applyTerminalHeight();
  applyTerminalVisibility();
  setupTerminalResize();
  setupTerminalAutoFit();
  window.terminal.onData(onTerminalData);
  window.terminal.onExit(onTerminalExit);

  branchPill.addEventListener('click', refreshBranch);
  if (worktreeBtn) worktreeBtn.addEventListener('click', toggleWorktree);
  window.git.onBranchChanged(({ cwd, branch }) => {
    const conv = getCurrentConversation();
    if (!conv || conv.projectPath !== cwd) return;
    if (branch) {
      branchLabel.textContent = branch;
      branchPill.title = `Branch: ${branch} · click to refresh`;
      branchPill.classList.remove('hidden');
    } else {
      branchPill.classList.add('hidden');
    }
  });
  if (state.terminalOpen) mountTerminal();
  setupSideResize(sidebarResizeEl, sidebar, (w) => {
    state.sidebarWidth = w;
    saveState();
  }, { min: 180, edge: 'right' });
  setupSideResize(workspaceResizeEl, workspacePanel, (w) => {
    state.workspaceWidth = w;
    saveState();
  }, { min: 320, edge: 'left' });

  // IPC listeners
  window.claude.onStreamStart(() => {
    setStatus('streaming', 'Connected...');
  });
  window.claude.onStreamDelta(handleDelta);
  window.claude.onThinkingDelta(handleThinkingDelta);
  window.claude.onStreamEnd(handleStreamEnd);
  window.claude.onStreamError(handleStreamError);
  window.claude.onStreamClose(handleStreamClose);
  window.claude.onToolUse(handleAgentToolUse);

  // Permission dialog
  let currentPermissionData = null;

  window.claude.onPermissionRequest((data) => {
    currentPermissionData = data;
    // If the permission is from a different chat, switch to it so the user has context
    if (data.convId && data.convId !== state.currentConversationId && getConversation(data.convId)) {
      switchConversation(data.convId);
    }
    showPermissionDialog(data);
    setStatus('streaming', 'Waiting for approval...');
  });

  permAllowBtn.addEventListener('click', () => {
    const tid = currentPermissionData?.toolUseId;
    window.claude.respondPermission(tid, { updatedInput: currentPermissionData?.input || {} });
    currentPermissionData = null;
    hidePermissionDialog();
    setStatus('streaming', 'Generating...');
  });

  permDenyBtn.addEventListener('click', () => {
    const tid = currentPermissionData?.toolUseId;
    window.claude.respondPermission(tid, { behavior: 'deny', message: 'User denied permission' });
    currentPermissionData = null;
    hidePermissionDialog();
    setStatus('streaming', 'Generating...');
  });

  // Input
  inputEl.addEventListener('input', autoResize);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(inputEl.value);
    }
  });

  // Buttons
  sendBtn.addEventListener('click', () => sendMessage(inputEl.value));
  stopBtn.addEventListener('click', () => stopGeneration());
  newChatBtn.addEventListener('click', newChat);

  // Sidebar toggle
  toggleSidebarBtn.addEventListener('click', () => {
    sidebar.classList.toggle('collapsed');
  });

  // Sidebar tabs
  sidebarTabs.forEach(tab => {
    tab.addEventListener('click', () => switchSidebarTab(tab.getAttribute('data-tab')));
  });
  memorySearchEl.addEventListener('input', () => {
    clearTimeout(memorySearchDebounce);
    memorySearchDebounce = setTimeout(() => {
      renderMemories(memorySearchEl.value.trim());
    }, 200);
  });

  // Suggestion chips
  document.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const prompt = chip.getAttribute('data-prompt');
      if (prompt) {
        sendMessage(prompt);
      }
    });
  });

  // Copy code blocks (event delegation)
  messagesEl.addEventListener('click', handleCopyClick);

  // External links
  messagesEl.addEventListener('click', handleLinkClick);

  // Model selector
  modelSelector.addEventListener('click', (e) => {
    e.stopPropagation();
    if (modelMenu.classList.contains('hidden')) openModelMenu();
    else closeModelMenu();
  });
  document.addEventListener('click', (e) => {
    if (!modelMenu.classList.contains('hidden') &&
        !modelMenu.contains(e.target) &&
        e.target !== modelSelector) {
      closeModelMenu();
    }
  });

  // Project pill
  projectPill.addEventListener('click', async () => {
    const picked = await window.project.pick();
    if (!picked) return;
    let conv = getCurrentConversation();
    if (!conv) {
      conv = createConversation(basename(picked) || 'New Chat');
    }
    conv.projectPath = picked;
    saveState();
    renderProjectPill();
    refreshBranch();
    renderConversationList();
    renderWsTabs();
    renderWsTree();
    if (state.terminalOpen && currentTerminalConvId === conv.id) updateTerminalLabel(conv);
  });

  // Add extra context folder
  addDirBtn.addEventListener('click', async () => {
    const picked = await window.project.pick();
    if (!picked) return;
    let conv = getCurrentConversation();
    if (!conv) conv = createConversation('New Chat');
    if (!Array.isArray(conv.extraDirs)) conv.extraDirs = [];
    if (picked === conv.projectPath) return;
    if (conv.extraDirs.includes(picked)) return;
    conv.extraDirs.push(picked);
    saveState();
    renderExtraDirs();
    renderWsTabs();
    renderWsTree();
  });

  // Save memory
  const saveMemoryBtn = document.getElementById('btn-save-memory');
  saveMemoryBtn.addEventListener('click', () => {
    const conv = getCurrentConversation();
    if (!conv || conv.messages.length === 0 || conv.streaming) return;
    const prompt =
      "Save the most important takeaways from our conversation as a memory by calling the `remember` tool on the `context` MCP server. " +
      "Write a concise, self-contained summary (what was discussed, what was decided, any facts or preferences worth recalling in future chats). " +
      "Pick an appropriate category and a few tags. Confirm briefly once saved.";
    sendMessage(prompt);
  });

  // YOLO toggle
  const yoloBtn = document.getElementById('btn-yolo');
  const applyYoloUI = () => {
    yoloBtn.classList.toggle('active', state.yolo);
    yoloBtn.title = state.yolo
      ? 'YOLO mode ON — permissions skipped. Click to disable.'
      : 'YOLO mode — skip all permission prompts';
  };
  applyYoloUI();
  yoloBtn.addEventListener('click', () => {
    if (!state.yolo) {
      const ok = confirm(
        'Enable YOLO mode?\n\n' +
        'Claude will run all tools (including shell commands and file writes) ' +
        'without asking for permission. Only use in trusted environments.'
      );
      if (!ok) return;
    }
    state.yolo = !state.yolo;
    applyYoloUI();
    saveState();
  });

  // Titlebar
  document.getElementById('btn-toggle-sidebar').addEventListener('click', () => sidebar.classList.toggle('collapsed'));
  toggleWorkspaceBtn.addEventListener('click', toggleWorkspace);
  toggleTerminalBtn.addEventListener('click', toggleTerminal);
  killTerminalBtn.addEventListener('click', killCurrentTerminal);
  closeTerminalBtn.addEventListener('click', () => {
    if (state.terminalOpen) toggleTerminal();
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    // Ctrl+N: New chat
    if (e.ctrlKey && e.key === 'n') {
      e.preventDefault();
      newChat();
    }
    // Escape: Stop generation for the current chat
    if (e.key === 'Escape') {
      const conv = getCurrentConversation();
      if (conv && conv.streaming) stopGeneration(conv.id);
    }
    // Ctrl+B: Toggle sidebar
    if (e.ctrlKey && !e.shiftKey && e.key === 'b') {
      e.preventDefault();
      sidebar.classList.toggle('collapsed');
    }
    // Ctrl+Shift+B (Cmd+Shift+B on mac): Toggle workspace panel
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'B' || e.key === 'b')) {
      e.preventDefault();
      toggleWorkspace();
    }
    // Ctrl+` / Cmd+`: Toggle terminal
    if ((e.ctrlKey || e.metaKey) && e.key === '`') {
      e.preventDefault();
      toggleTerminal();
    }
  });

  // Initial status
  setStatus('ready', 'Ready');
  inputEl.focus();
}

init();
