// ===== State =====
const state = {
  conversations: [],
  currentConversationId: null,
  yolo: false,
  rightPanel: null, // 'workspace' | 'pr' | null — mutually exclusive right-side slot
  wsTreeHeight: 260,
  sidebarWidth: 260,
  workspaceWidth: 480,
  prPanelWidth: 480,
  prFilter: 'mine', // 'mine' | 'all'
  terminalOpen: false,
  terminalHeight: 240,
  defaultModel: null, // last model the user picked; used as initial model for new conversations
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

// Sync input/send/stop button state from the CURRENT conversation's streaming flag.
// Prevents bug: one chat streaming used to leave input disabled when switching to
// a non-streaming chat.
function updateInputControlsForCurrent() {
  const conv = getCurrentConversation();
  const streaming = !!(conv && conv.streaming);
  inputEl.disabled = streaming;
  sendBtn.classList.toggle('hidden', streaming);
  stopBtn.classList.toggle('hidden', !streaming);
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
const contextUsageEl = document.getElementById('context-usage');
const contextUsageFillEl = contextUsageEl ? contextUsageEl.querySelector('.context-usage-fill') : null;
const contextUsageLabelEl = contextUsageEl ? contextUsageEl.querySelector('.context-usage-label') : null;
const newChatBtn = document.getElementById('new-chat-btn');
const conversationList = document.getElementById('conversation-list');
const toggleSidebarBtn = document.getElementById('toggle-sidebar-btn');
const sidebar = document.getElementById('sidebar');
const projectPill = document.getElementById('project-pill');
const projectLabel = document.getElementById('project-label');
const extraDirsList = document.getElementById('extra-dirs-list');
const addDirBtn = document.getElementById('add-dir-btn');
const attachBtn = document.getElementById('attach-btn');
const attachmentsListEl = document.getElementById('attachments-list');
const modelSelector = document.getElementById('model-selector');
const modelLabel = document.getElementById('model-label');
const modelMenu = document.getElementById('model-menu');
const workspacePanel = document.getElementById('workspace-panel');
const wsTabsEl = document.getElementById('ws-tabs');
const wsTreeEl = document.getElementById('ws-tree');
const wsTilesEl = document.getElementById('ws-tiles');
const wsVSplitter = document.getElementById('ws-vsplitter');
const toggleWorkspaceBtn = document.getElementById('btn-toggle-workspace');
const togglePrBtn = document.getElementById('btn-toggle-pr');
const prPanel = document.getElementById('pr-panel');
const prResizeEl = document.getElementById('pr-resize');
const prBackBtn = document.getElementById('pr-back-btn');
const prRefreshBtn = document.getElementById('pr-refresh-btn');
const prHeaderLabel = document.getElementById('pr-header-label');
const prRepoLabel = document.getElementById('pr-repo-label');
const prFilterRowEl = document.getElementById('pr-filter-row');
const prListEl = document.getElementById('pr-list');
const prDetailEl = document.getElementById('pr-detail');
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
  renderAttachments();
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

function renderAttachments() {
  if (!attachmentsListEl) return;
  attachmentsListEl.innerHTML = '';
  const conv = getCurrentConversation();
  const files = (conv && conv.pendingAttachments) || [];
  if (!files.length) {
    attachmentsListEl.classList.add('hidden');
    return;
  }
  attachmentsListEl.classList.remove('hidden');
  for (const file of files) {
    const chip = document.createElement('div');
    chip.className = 'attachment-chip';
    chip.title = file;

    const ext = (file.split('.').pop() || '').toLowerCase();
    const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext);

    if (isImage) {
      chip.classList.add('attachment-chip-image');
      const thumb = document.createElement('img');
      thumb.className = 'attachment-thumb';
      thumb.src = 'file://' + encodeURI(file).replace(/#/g, '%23').replace(/\?/g, '%3F');
      thumb.alt = '';
      thumb.draggable = false;
      chip.appendChild(thumb);
    } else {
      const icon = document.createElement('span');
      icon.className = 'attachment-icon';
      icon.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
      chip.appendChild(icon);
    }

    const label = document.createElement('span');
    label.className = 'attachment-label';
    label.textContent = basename(file);
    chip.appendChild(label);

    const remove = document.createElement('button');
    remove.className = 'attachment-remove';
    remove.type = 'button';
    remove.title = 'Remove';
    remove.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
      <path d="M18 6L6 18M6 6l12 12"/>
    </svg>`;
    remove.onclick = () => {
      const c = getCurrentConversation();
      if (!c || !c.pendingAttachments) return;
      c.pendingAttachments = c.pendingAttachments.filter(f => f !== file);
      saveState();
      renderAttachments();
    };
    chip.appendChild(remove);

    attachmentsListEl.appendChild(chip);
  }
}

function renderModelSelector() {
  const conv = getCurrentConversation();
  const current = conv ? (conv.model ?? null) : (state.defaultModel ?? null);
  modelLabel.textContent = findModelLabel(current);
  modelSelector.title = current == null
    ? 'Using global default model · click to change'
    : `Model: ${current} · click to change`;
}

function buildModelMenu() {
  const conv = getCurrentConversation();
  const current = conv ? (conv.model ?? null) : (state.defaultModel ?? null);
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
      state.defaultModel = entry.value;
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

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'];

function fileUrl(p) {
  return 'file://' + encodeURI(p).replace(/#/g, '%23').replace(/\?/g, '%3F');
}

function createAttachmentsEl(attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return null;
  const wrap = document.createElement('div');
  wrap.className = 'message-attachments';
  for (const p of attachments) {
    const ext = (p.split('.').pop() || '').toLowerCase();
    const isImage = IMAGE_EXTS.includes(ext);
    if (isImage) {
      const tile = document.createElement('a');
      tile.className = 'message-attachment-image';
      tile.href = fileUrl(p);
      tile.title = p;
      tile.onclick = (e) => {
        e.preventDefault();
        window.shellAPI.openExternal(fileUrl(p));
      };
      const img = document.createElement('img');
      img.src = fileUrl(p);
      img.alt = basename(p);
      img.draggable = false;
      tile.appendChild(img);
      wrap.appendChild(tile);
    } else {
      const tile = document.createElement('div');
      tile.className = 'message-attachment-file';
      tile.title = p;
      tile.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg><span>${escapeHtml(basename(p))}</span>`;
      wrap.appendChild(tile);
    }
  }
  return wrap;
}

function createFilesAccessedBlock(filesAccessed, expanded = false) {
  const wrap = document.createElement('div');
  wrap.className = 'files-accessed-block' + (expanded ? ' expanded' : '');
  wrap.innerHTML = `
    <button class="files-accessed-toggle" type="button">
      <svg class="files-accessed-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="6 9 12 15 18 9"/>
      </svg>
      <span class="files-accessed-label"></span>
    </button>
    <div class="files-accessed-body"></div>
  `;
  wrap.querySelector('.files-accessed-toggle').addEventListener('click', () => {
    wrap.classList.toggle('expanded');
  });
  updateFilesAccessedContents(wrap, filesAccessed || []);
  return wrap;
}

function updateFilesAccessedContents(wrap, filesAccessed) {
  const label = wrap.querySelector('.files-accessed-label');
  const body = wrap.querySelector('.files-accessed-body');
  const count = filesAccessed.length;
  const writeCount = filesAccessed.filter(a => a.kind === 'write').length;
  label.textContent = writeCount
    ? `${count} file${count === 1 ? '' : 's'} accessed · ${writeCount} edited`
    : `${count} file${count === 1 ? '' : 's'} accessed`;
  body.innerHTML = '';
  for (const entry of filesAccessed) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'file-access-chip ' + (entry.kind === 'write' ? 'file-access-write' : 'file-access-read');
    chip.title = entry.path;
    const icon = entry.kind === 'write'
      ? `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`
      : `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>`;
    chip.innerHTML = icon + `<span class="file-access-name">${escapeHtml(basename(entry.path))}</span>`;
    chip.addEventListener('click', () => openFile(entry.path, { pulse: true }));
    body.appendChild(chip);
  }
}

function renderFilesAccessedBlock(msgEl, filesAccessed) {
  if (!msgEl || !Array.isArray(filesAccessed) || !filesAccessed.length) return;
  let block = msgEl.querySelector(':scope > .files-accessed-block');
  if (!block) {
    block = createFilesAccessedBlock(filesAccessed, false);
    msgEl.appendChild(block);
  } else {
    updateFilesAccessedContents(block, filesAccessed);
  }
}

function createMessageEl(role, content, isStreaming = false, thinking = '', attachments = null, filesAccessed = null, toolCalls = null) {
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

  const attachmentsEl = role === 'user' ? createAttachmentsEl(attachments) : null;
  if (attachmentsEl) body.appendChild(attachmentsEl);

  if (content) {
    if (role === 'user') {
      const text = document.createElement('div');
      text.className = 'message-text';
      text.innerHTML = escapeHtml(content).replace(/\n/g, '<br>');
      body.appendChild(text);
    } else {
      body.innerHTML = renderMarkdown(content);
    }
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
  if (role === 'assistant' && Array.isArray(toolCalls) && toolCalls.length) {
    const block = createToolCallsBlock(toolCalls, isStreaming);
    // For finished turns, auto-collapse cleanly-resolved entries.
    if (!isStreaming) {
      const entries = block.querySelectorAll('.tool-call');
      let hasKept = false;
      for (const entry of entries) {
        const status = entry.dataset.status || 'done';
        if (status === 'done' || status === 'canceled' || status === 'unknown') {
          entry.classList.remove('expanded');
        } else {
          hasKept = true;
        }
      }
      if (!hasKept && entries.length > 0) block.classList.remove('expanded');
    }
    msg.appendChild(block);
  }
  msg.appendChild(body);
  if (role === 'assistant' && Array.isArray(filesAccessed) && filesAccessed.length) {
    msg.appendChild(createFilesAccessedBlock(filesAccessed, false));
  }
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
    streamToolCalls: [],
    worktreePath: null,
    worktreeBranch: null,
    pendingNewSession: false,
    model: state.defaultModel ?? null,
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
    if (msg.role === 'compact') {
      messagesEl.appendChild(createCompactBannerEl(msg));
      continue;
    }
    messagesEl.appendChild(createMessageEl(msg.role, msg.content, false, msg.thinking || '', msg.attachments || null, msg.filesAccessed || null, msg.toolCalls || null));
  }

  // If this conversation is streaming, rebuild the live placeholder with accumulated content
  if (conv.streaming) {
    const el = createMessageEl('assistant', conv.streamContent || '', true, conv.streamThinking || '', null, conv.streamFilesAccessed || null, conv.streamToolCalls || null);
    if (conv.streamThinking) {
      const think = el.querySelector(':scope > .thinking-block');
      if (think) think.classList.add('expanded');
    }
    messagesEl.appendChild(el);
    assistantElByConv.set(conv.id, el);
    setStatus('streaming', 'Generating...');
  } else {
    setStatus('ready', 'Ready');
  }
  updateInputControlsForCurrent();

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
  renderContextUsage();
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
  updateInputControlsForCurrent();
  setStatus('ready', 'Ready');
  renderContextUsage();
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
      rightPanel: state.rightPanel,
      wsTreeHeight: state.wsTreeHeight,
      sidebarWidth: state.sidebarWidth,
      workspaceWidth: state.workspaceWidth,
      prPanelWidth: state.prPanelWidth,
      prFilter: state.prFilter,
      terminalOpen: state.terminalOpen,
      terminalHeight: state.terminalHeight,
      defaultModel: state.defaultModel,
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
      // Migrate legacy state.workspaceOpen → state.rightPanel
      if (data.rightPanel === 'workspace' || data.rightPanel === 'pr' || data.rightPanel === null) {
        state.rightPanel = data.rightPanel;
      } else if (data.workspaceOpen) {
        state.rightPanel = 'workspace';
      } else {
        state.rightPanel = null;
      }
      if (data.prFilter === 'all' || data.prFilter === 'mine') {
        state.prFilter = data.prFilter;
      }
      if (typeof data.wsTreeHeight === 'number' && data.wsTreeHeight > 80) {
        state.wsTreeHeight = data.wsTreeHeight;
      }
      if (typeof data.sidebarWidth === 'number' && data.sidebarWidth >= 180) {
        state.sidebarWidth = data.sidebarWidth;
      }
      if (typeof data.workspaceWidth === 'number' && data.workspaceWidth >= 320) {
        state.workspaceWidth = data.workspaceWidth;
      }
      if (typeof data.prPanelWidth === 'number' && data.prPanelWidth >= 340) {
        state.prPanelWidth = data.prPanelWidth;
      }
      state.terminalOpen = !!data.terminalOpen;
      if (typeof data.terminalHeight === 'number' && data.terminalHeight >= 120) {
        state.terminalHeight = data.terminalHeight;
      }
      if (data.defaultModel === null || typeof data.defaultModel === 'string') {
        state.defaultModel = data.defaultModel;
      }

      // Reset any in-flight stream flags — processes don't survive app restarts
      for (const conv of state.conversations) {
        conv.streaming = false;
        conv.streamContent = '';
        conv.streamThinking = '';
        conv.streamFilesAccessed = [];
        conv.streamToolCalls = [];
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
  let conv = getCurrentConversation();
  const attachments = (conv && Array.isArray(conv.pendingAttachments)) ? conv.pendingAttachments.slice() : [];

  if (!prompt.trim() && attachments.length === 0) return;

  if (!conv) {
    const title = prompt.slice(0, 50) + (prompt.length > 50 ? '...' : '');
    conv = createConversation(title);
  }

  if (conv.streaming) return; // don't allow concurrent sends within the same conv

  // Build final prompt with @path references so the Claude CLI reads attached files/images.
  // Paths with spaces are quoted; @ references go first so they're easy to scan in the message bubble.
  const quoteIfNeeded = (p) => (/\s/.test(p) ? `@"${p}"` : `@${p}`);
  const attachmentPrefix = attachments.map(quoteIfNeeded).join(' ');
  const finalPrompt = attachmentPrefix
    ? (prompt.trim() ? `${attachmentPrefix}\n\n${prompt}` : attachmentPrefix)
    : prompt;

  welcomeEl.classList.add('hidden');
  messagesEl.classList.remove('hidden');

  // Store typed text + attachments separately so we can render previews on reload.
  // The @path-prefixed finalPrompt goes only to the CLI.
  const userMessage = { role: 'user', content: prompt };
  if (attachments.length) userMessage.attachments = attachments;
  conv.messages.push(userMessage);
  messagesEl.appendChild(createMessageEl('user', prompt, false, '', attachments));
  scrollToBottom();
  conv.pendingAttachments = [];
  saveState();
  renderAttachments();

  conv.streaming = true;
  conv.streamContent = '';
  conv.streamThinking = '';
  conv.streamFilesAccessed = [];
  conv.streamToolCalls = [];

  const assistantEl = createMessageEl('assistant', '', true);
  messagesEl.appendChild(assistantEl);
  assistantElByConv.set(conv.id, assistantEl);
  scrollToBottom();

  inputEl.value = '';
  autoResize();
  updateInputControlsForCurrent();
  setStatus('streaming', 'Thinking...');

  const isFirstMessage = sessionLogic.shouldStartFreshSession(conv);
  conv.pendingNewSession = false;
  window.claude.sendPrompt(conv.id, finalPrompt, conv.sessionId, isFirstMessage, state.yolo, effectiveProjectPath(conv), conv.model ?? null, conv.extraDirs ?? []);
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

  const filesAccessed = Array.isArray(conv.streamFilesAccessed) ? conv.streamFilesAccessed.slice() : [];
  const toolCalls = Array.isArray(conv.streamToolCalls) ? conv.streamToolCalls.slice() : [];
  // Freeze any lingering 'running' states when we stop/save — the stream is over.
  for (const tc of toolCalls) {
    if (tc.status === 'running') tc.status = save ? 'unknown' : 'canceled';
  }
  const shouldPush = (save && (conv.streamContent || conv.streamThinking || toolCalls.length)) ||
                     (!save && conv.streamContent);
  if (shouldPush) {
    const m = {
      role: 'assistant',
      content: conv.streamContent || '',
      thinking: conv.streamThinking || '',
    };
    if (filesAccessed.length) m.filesAccessed = filesAccessed;
    if (toolCalls.length) m.toolCalls = toolCalls;
    conv.messages.push(m);
  }

  // Finalize any streaming tool-call block UI (stop spinners, collapse cleanly-resolved entries)
  if (el) {
    const block = el.querySelector(':scope > .tool-calls-block');
    if (block) {
      block.classList.remove('tool-calls-streaming');
      const entries = block.querySelectorAll('.tool-call');
      let hasKept = false;
      for (const entry of entries) {
        const status = entry.dataset.status || 'done';
        // Keep errors and still-running expanded — they're the interesting ones.
        if (status === 'done' || status === 'canceled' || status === 'unknown') {
          entry.classList.remove('expanded');
        } else {
          hasKept = true;
        }
      }
      // If every entry is cleanly resolved, collapse the outer block too — the chat
      // summary is what the user usually cares about after the fact.
      if (!hasKept && entries.length > 0) {
        block.classList.remove('expanded');
      }
    }
  }

  conv.streaming = false;
  conv.streamContent = '';
  conv.streamThinking = '';
  conv.streamFilesAccessed = [];
  conv.streamToolCalls = [];
  assistantElByConv.delete(convId);
  saveState();

  if (isCurrentConv(convId)) {
    updateInputControlsForCurrent();
    inputEl.focus();
  }
  renderConversationList();
}

function shouldNotifyFor(convId) {
  // Notify if the user isn't actively watching that specific chat right now.
  if (!isCurrentConv(convId)) return true;
  if (typeof document.hasFocus === 'function' && !document.hasFocus()) return true;
  return false;
}

function notifyChatFinished(convId, { kind = 'done', detail = '' } = {}) {
  if (!shouldNotifyFor(convId)) return;
  if (typeof Notification === 'undefined') return;
  const conv = getConversation(convId);
  const title = conv?.title || 'Chat';
  const body = kind === 'error'
    ? (detail ? `Error: ${detail}` : 'Error')
    : (detail || 'Ready');
  try {
    const n = new Notification(title, { body, tag: convId, silent: false });
    n.onclick = () => {
      try { window.claude.focusWindow(); } catch (e) {}
      if (getConversation(convId)) switchConversation(convId);
      n.close();
    };
  } catch (e) {}
}

function handleStreamEnd(data) {
  if (!data || !data.convId) return;
  finalizeStream(data.convId, { save: true });

  // Fire desktop notification if the user isn't currently watching this chat
  let detail = '';
  if (data.cost != null) {
    detail = `$${Number(data.cost).toFixed(4)}`;
    if (data.duration) detail += ` · ${(data.duration / 1000).toFixed(1)}s`;
  }
  notifyChatFinished(data.convId, { kind: 'done', detail });

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
  conv.streamToolCalls = [];

  if (isCurrentConv(convId)) {
    messagesEl.appendChild(createMessageEl('error', `Error: ${errText}`));
    scrollToBottom();
    updateInputControlsForCurrent();
    inputEl.focus();
    setStatus('error', 'Error occurred');
  }
  notifyChatFinished(convId, { kind: 'error', detail: String(errText).slice(0, 120) });
  saveState();
  renderConversationList();
}

function handleStreamClose(data) {
  const convId = data && data.convId;
  const conv = convId ? getConversation(convId) : null;
  if (conv && conv.streaming) {
    const hadContent = !!(conv.streamContent || conv.streamThinking);
    finalizeStream(convId, { save: true });
    if (isCurrentConv(convId)) {
      setStatus(hadContent ? 'ready' : 'error', hadContent ? 'Ready' : 'No response received');
    }
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

function applyRightPanelVisibility() {
  const isWs = state.rightPanel === 'workspace';
  const isPr = state.rightPanel === 'pr';
  workspacePanel.classList.toggle('collapsed', !isWs);
  toggleWorkspaceBtn.classList.toggle('active', isWs);
  prPanel.classList.toggle('collapsed', !isPr);
  togglePrBtn.classList.toggle('active', isPr);
}

function toggleWorkspace() {
  state.rightPanel = state.rightPanel === 'workspace' ? null : 'workspace';
  applyRightPanelVisibility();
  saveState();
  if (state.rightPanel === 'workspace') {
    renderWsTabs();
    renderWsTree();
  }
}

function togglePrPanel() {
  state.rightPanel = state.rightPanel === 'pr' ? null : 'pr';
  applyRightPanelVisibility();
  saveState();
  if (state.rightPanel === 'pr') {
    openPrPanel();
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

// ===== File modal (expanded view) =====
const fileModalOverlay = document.getElementById('file-modal-overlay');
const fileModalNameEl = document.getElementById('file-modal-name');
const fileModalSubtitleEl = document.getElementById('file-modal-subtitle');
const fileModalBodyEl = document.getElementById('file-modal-body');
const fileModalCloseBtn = document.getElementById('file-modal-close');

function closeFileModal() {
  fileModalOverlay.classList.add('hidden');
  fileModalBodyEl.innerHTML = '';
}

async function openFileInModal(filePath) {
  if (!filePath) return;
  const roots = workspaceRoots();
  fileModalNameEl.textContent = basename(filePath);
  fileModalSubtitleEl.textContent = ' · ' + (relativeToRoot(filePath, roots) || filePath);
  fileModalBodyEl.innerHTML = '<div class="ws-pane-loading">Loading…</div>';
  fileModalOverlay.classList.remove('hidden');

  try {
    const res = await window.files.readFile(roots, filePath);
    if (res.tooLarge) {
      fileModalBodyEl.innerHTML = `<div class="ws-pane-notice">File too large to preview (${formatBytes(res.size)})</div>`;
      return;
    }
    if (res.binary) {
      fileModalBodyEl.innerHTML = `<div class="ws-pane-notice">Binary file (${formatBytes(res.size)})</div>`;
      return;
    }
    const hl = window.libs.highlightCode(res.content, res.lang || '');
    fileModalBodyEl.innerHTML = `<pre><code class="hljs language-${hl.language || ''}">${hl.html}</code></pre>`;
  } catch (e) {
    fileModalBodyEl.innerHTML = `<div class="ws-pane-notice error">${escapeHtml(String(e.message || e))}</div>`;
  }
}

if (fileModalCloseBtn) {
  fileModalCloseBtn.addEventListener('click', closeFileModal);
}
if (fileModalOverlay) {
  fileModalOverlay.addEventListener('click', (e) => {
    if (e.target === fileModalOverlay) closeFileModal();
  });
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && fileModalOverlay && !fileModalOverlay.classList.contains('hidden')) {
    closeFileModal();
  }
});

async function openFile(filePath, opts = {}) {
  const conv = getCurrentConversation();
  if (!conv) return;
  ensureWsState(conv);
  const roots = workspaceRoots();
  if (roots.length === 0) return;
  if (state.rightPanel !== 'workspace') {
    state.rightPanel = 'workspace';
    applyRightPanelVisibility();
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

  const expand = document.createElement('button');
  expand.className = 'ws-pane-expand';
  expand.type = 'button';
  expand.title = 'Open in large view';
  expand.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`;
  expand.addEventListener('click', (e) => {
    e.stopPropagation();
    openFileInModal(filePath);
  });

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
  header.appendChild(expand);
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
  prPanel.style.width = `${state.prPanelWidth}px`;
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
    // When dragging a right-side panel the "other" is the sidebar. When dragging the
    // sidebar the "other" is whichever right-side panel is currently visible.
    let otherPanel;
    if (panel === sidebar) {
      otherPanel = (!prPanel.classList.contains('collapsed')) ? prPanel : workspacePanel;
    } else {
      otherPanel = sidebar;
    }
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

function extractToolFileAccess(data) {
  const i = (data && data.input) || {};
  switch (data && data.name) {
    case 'Read':
      return i.file_path ? { path: i.file_path, kind: 'read' } : null;
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
      return i.file_path ? { path: i.file_path, kind: 'write' } : null;
    case 'NotebookEdit':
      return i.notebook_path ? { path: i.notebook_path, kind: 'write' } : null;
    default:
      return null;
  }
}

function extractToolFilePath(data) {
  const access = extractToolFileAccess(data);
  return access ? access.path : null;
}

function recordFileAccess(conv, path, kind) {
  if (!conv || !path) return;
  if (!Array.isArray(conv.streamFilesAccessed)) conv.streamFilesAccessed = [];
  const existing = conv.streamFilesAccessed.find(a => a.path === path);
  if (existing) {
    // Upgrade read → write if the same file gets edited later in the turn
    if (kind === 'write') existing.kind = 'write';
  } else {
    conv.streamFilesAccessed.push({ path, kind });
  }
  if (isCurrentConv(conv.id)) {
    const el = assistantElByConv.get(conv.id);
    if (el) renderFilesAccessedBlock(el, conv.streamFilesAccessed);
  }
}

async function handleAgentToolUse(data) {
  const convId = data && data.convId;
  const conv = convId ? getConversation(convId) : getCurrentConversation();
  if (!conv) return;

  // Record the tool call so we can render it inline
  recordToolCall(conv, data);

  // Keep legacy files-accessed tracking for Read/Write/Edit
  const access = extractToolFileAccess(data);
  if (access) {
    recordFileAccess(conv, access.path, access.kind);

    const roots = workspaceRoots(conv);
    if (roots.length > 0) {
      try {
        const info = await window.files.pathInfo(roots, access.path);
        if (info && info.exists && !info.isDir) {
          if (isCurrentConv(conv.id)) {
            openFile(access.path, { pulse: true });
          } else {
            ensureWsState(conv);
            if (!(conv.openFiles || []).some(f => (typeof f === 'string' ? f : f.path) === access.path)) {
              conv.openFiles.push({ path: access.path, width: 420 });
            }
            saveState();
          }
        }
      } catch (e) {}
    }
  }
}

function contextWindowFor(modelId) {
  const m = String(modelId || '');
  if (!m) return 200_000;
  // 1M-context variants carry [1m] in the id
  if (/\[1m\]/i.test(m) || /-1m\b/i.test(m)) return 1_000_000;
  return 200_000;
}

function handleUsage(data) {
  if (!data || !data.convId) return;
  const conv = getConversation(data.convId);
  if (!conv) return;
  // Usage.input_tokens + cache_read + cache_creation approximates the full
  // prompt we just sent — i.e. current context occupancy.
  const occupancy = (data.inputTokens || 0)
    + (data.cacheReadTokens || 0)
    + (data.cacheCreationTokens || 0);
  conv.contextTokens = occupancy;
  conv.contextModel = data.model || conv.model || null;
  if (isCurrentConv(conv.id)) renderContextUsage();
}

function renderContextUsage() {
  if (!contextUsageEl) return;
  const conv = getCurrentConversation();
  if (!conv || !conv.contextTokens) {
    contextUsageEl.classList.add('hidden');
    return;
  }
  const max = contextWindowFor(conv.contextModel || conv.model);
  const pct = Math.min(100, Math.max(0, (conv.contextTokens / max) * 100));
  contextUsageFillEl.style.width = `${pct.toFixed(1)}%`;
  contextUsageEl.classList.remove('hidden');
  contextUsageEl.classList.toggle('context-usage-warn', pct >= 70 && pct < 90);
  contextUsageEl.classList.toggle('context-usage-critical', pct >= 90);
  contextUsageLabelEl.textContent = `${Math.round(pct)}% · ${formatTokenCount(conv.contextTokens)}/${formatTokenCount(max)}`;
  contextUsageEl.title = `Context: ${conv.contextTokens.toLocaleString()} / ${max.toLocaleString()} tokens`;
}

function handleCompact(data) {
  if (!data || !data.convId) return;
  const conv = getConversation(data.convId);
  if (!conv) return;
  const marker = {
    role: 'compact',
    trigger: data.trigger || '',
    preTokens: data.preTokens ?? null,
    postTokens: data.postTokens ?? null,
    message: data.message || '',
    ts: Date.now(),
  };
  conv.messages.push(marker);
  saveState();
  if (isCurrentConv(conv.id)) {
    messagesEl.appendChild(createCompactBannerEl(marker));
    scrollToBottom();
  }
}

function createCompactBannerEl(marker) {
  const el = document.createElement('div');
  el.className = 'compact-banner';
  const trigger = marker.trigger ? ` · ${marker.trigger}` : '';
  const tokens = (marker.preTokens != null && marker.postTokens != null)
    ? ` · ${formatTokenCount(marker.preTokens)} → ${formatTokenCount(marker.postTokens)} tokens`
    : '';
  el.innerHTML = `
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="4 14 10 14 10 20"/>
      <polyline points="20 10 14 10 14 4"/>
      <line x1="14" y1="10" x2="21" y2="3"/>
      <line x1="3" y1="21" x2="10" y2="14"/>
    </svg>
    <span>Context compacted${escapeHtml(trigger)}${escapeHtml(tokens)}</span>
  `;
  return el;
}

function formatTokenCount(n) {
  if (n == null) return '';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function handleToolResult(data) {
  if (!data || !data.convId || !data.id) return;
  const conv = getConversation(data.convId);
  if (!conv || !Array.isArray(conv.streamToolCalls)) return;
  const tc = conv.streamToolCalls.find(c => c.id === data.id);
  if (!tc) return;
  tc.result = data.text || '';
  tc.status = data.isError ? 'error' : 'done';
  if (!isCurrentConv(conv.id)) return;
  const msgEl = assistantElByConv.get(conv.id);
  if (!msgEl) return;
  const block = msgEl.querySelector(':scope > .tool-calls-block');
  if (!block) return;
  const entry = block.querySelector(`.tool-call[data-id="${cssEscape(data.id)}"]`);
  if (entry) updateToolCallEntry(entry, tc);
  scrollToBottom();
}

function recordToolCall(conv, data) {
  if (!Array.isArray(conv.streamToolCalls)) conv.streamToolCalls = [];
  const entry = {
    id: data.id || `tc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: data.name || 'Tool',
    input: data.input || {},
    result: null,
    status: 'running',
  };
  conv.streamToolCalls.push(entry);
  if (!isCurrentConv(conv.id)) return;
  const msgEl = assistantElByConv.get(conv.id);
  if (!msgEl) return;
  let block = msgEl.querySelector(':scope > .tool-calls-block');
  if (!block) {
    block = createToolCallsBlock([], true);
    // Insert before the main text body so tool output reads chronologically before final answer.
    const body = msgEl.querySelector('.message-body');
    msgEl.insertBefore(block, body);
  }
  const bodyEl = block.querySelector('.tool-calls-body');
  bodyEl.appendChild(createToolCallEntry(entry));
  updateToolCallsHeader(block);
  scrollToBottom();
}

// ===== Tool-call rendering =====

function toolIconSvg(name) {
  // Simple family-based icons
  const fam = toolFamily(name);
  const map = {
    bash: '<path d="M4 17l6-6-6-6"/><path d="M12 19h8"/>',
    read: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
    write: '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
    task: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    todo: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 10l2 2 4-4"/>',
    web: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/>',
    tool: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.1 2.1-2.2-2.2 2.1-2.1z"/>',
  };
  const d = map[fam] || map.tool;
  return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
}

function toolFamily(name) {
  const n = String(name || '');
  if (n === 'Bash') return 'bash';
  if (n === 'Read') return 'read';
  if (n === 'Edit' || n === 'MultiEdit' || n === 'Write' || n === 'NotebookEdit') return 'write';
  if (n === 'Grep' || n === 'Glob') return 'search';
  if (n === 'Task' || n === 'Agent' || /spawn_task$/i.test(n)) return 'task';
  if (n === 'TodoWrite') return 'todo';
  if (n === 'WebFetch' || n === 'WebSearch') return 'web';
  return 'tool';
}

function toolSummaryText(name, input) {
  const i = input || {};
  switch (name) {
    case 'Bash': {
      const cmd = (i.command || '').trim();
      const first = cmd.split('\n')[0];
      return first.length > 200 ? first.slice(0, 197) + '…' : first;
    }
    case 'Read':
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
      return basename(i.file_path || '') + (i.file_path ? '' : '');
    case 'NotebookEdit':
      return basename(i.notebook_path || '');
    case 'Grep':
      return i.pattern ? `"${i.pattern}"` + (i.glob ? ` · ${i.glob}` : '') : '';
    case 'Glob':
      return i.pattern || '';
    case 'Task':
    case 'Agent':
      return (i.description || i.subagent_type || '').toString();
    case 'TodoWrite':
      if (Array.isArray(i.todos)) {
        const total = i.todos.length;
        const done = i.todos.filter(t => t.status === 'completed').length;
        return `${done}/${total} complete`;
      }
      return '';
    case 'WebFetch':
      return i.url || '';
    case 'WebSearch':
      return i.query || '';
    default:
      try {
        const s = JSON.stringify(i);
        return s.length > 120 ? s.slice(0, 117) + '…' : s;
      } catch (e) { return ''; }
  }
}

function createToolCallsBlock(entries, isStreaming) {
  const wrap = document.createElement('div');
  wrap.className = 'tool-calls-block' + (isStreaming ? ' tool-calls-streaming' : '');
  wrap.innerHTML = `
    <button class="tool-calls-toggle" type="button">
      <svg class="tool-calls-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="6 9 12 15 18 9"/>
      </svg>
      <span class="tool-calls-label"></span>
    </button>
    <div class="tool-calls-body"></div>
  `;
  // Start expanded so users see what Claude is doing live.
  wrap.classList.add('expanded');
  wrap.querySelector('.tool-calls-toggle').addEventListener('click', () => {
    wrap.classList.toggle('expanded');
  });
  const bodyEl = wrap.querySelector('.tool-calls-body');
  for (const entry of entries || []) {
    bodyEl.appendChild(createToolCallEntry(entry));
  }
  updateToolCallsHeader(wrap);
  return wrap;
}

function updateToolCallsHeader(block) {
  if (!block) return;
  const label = block.querySelector('.tool-calls-label');
  if (!label) return;
  const entries = block.querySelectorAll('.tool-call');
  const total = entries.length;
  const running = block.querySelectorAll('.tool-call[data-status="running"]').length;
  const errors = block.querySelectorAll('.tool-call[data-status="error"]').length;
  const parts = [`${total} tool call${total === 1 ? '' : 's'}`];
  if (running) parts.push(`${running} running`);
  if (errors) parts.push(`${errors} error${errors === 1 ? '' : 's'}`);
  label.textContent = parts.join(' · ');
}

function createToolCallEntry(entry) {
  const el = document.createElement('div');
  el.className = 'tool-call';
  el.dataset.id = entry.id;
  el.dataset.status = entry.status || 'running';
  el.dataset.family = toolFamily(entry.name);
  el.innerHTML = `
    <div class="tool-call-header">
      <span class="tool-call-status"></span>
      <span class="tool-call-icon">${toolIconSvg(entry.name)}</span>
      <span class="tool-call-name"></span>
      <span class="tool-call-summary"></span>
      <svg class="tool-call-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="6 9 12 15 18 9"/>
      </svg>
    </div>
    <div class="tool-call-body"></div>
  `;
  el.querySelector('.tool-call-header').addEventListener('click', () => {
    el.classList.toggle('expanded');
  });
  // Auto-expand Task calls so users can watch sub-agents work
  if (toolFamily(entry.name) === 'task') {
    el.classList.add('expanded');
  }
  updateToolCallEntry(el, entry);
  return el;
}

function updateToolCallEntry(el, entry) {
  if (!el) return;
  el.dataset.status = entry.status || 'running';
  el.querySelector('.tool-call-name').textContent = entry.name;
  const summaryEl = el.querySelector('.tool-call-summary');
  summaryEl.textContent = toolSummaryText(entry.name, entry.input);
  summaryEl.title = summaryEl.textContent;

  const statusEl = el.querySelector('.tool-call-status');
  const status = entry.status || 'running';
  statusEl.className = `tool-call-status status-${status}`;
  if (status === 'running') {
    statusEl.innerHTML = '<span class="tc-spinner"></span>';
  } else if (status === 'done') {
    statusEl.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
  } else if (status === 'error') {
    statusEl.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>';
  } else {
    statusEl.innerHTML = '<span class="tc-dot"></span>';
  }

  const body = el.querySelector('.tool-call-body');
  body.innerHTML = renderToolCallBody(entry);
}

function renderToolCallBody(entry) {
  const name = entry.name;
  const i = entry.input || {};
  const fam = toolFamily(name);
  const parts = [];

  // Input section
  if (name === 'TodoWrite' && Array.isArray(i.todos)) {
    parts.push(renderTodoList(i.todos));
  } else if (name === 'Bash') {
    if (i.description) {
      parts.push(`<div class="tc-note">${escapeHtml(i.description)}</div>`);
    }
    parts.push(`<pre class="tc-code tc-code-bash">${escapeHtml(i.command || '')}</pre>`);
  } else if (fam === 'task') {
    const meta = [];
    if (i.subagent_type) meta.push(`<span class="tc-meta-key">agent</span> <span class="tc-meta-val">${escapeHtml(i.subagent_type)}</span>`);
    if (i.description) meta.push(`<span class="tc-meta-key">task</span> <span class="tc-meta-val">${escapeHtml(i.description)}</span>`);
    if (meta.length) parts.push(`<div class="tc-meta">${meta.join('')}</div>`);
    if (i.prompt) {
      parts.push(`<div class="tc-subhead">Prompt</div><pre class="tc-code">${escapeHtml(i.prompt)}</pre>`);
    }
  } else if (name === 'Read' || name === 'Edit' || name === 'MultiEdit' || name === 'Write' || name === 'NotebookEdit') {
    const path = i.file_path || i.notebook_path || '';
    if (path) parts.push(`<div class="tc-path">${escapeHtml(path)}</div>`);
    if (name === 'Edit' && i.old_string != null && i.new_string != null) {
      parts.push(renderUnifiedDiff(i.old_string, i.new_string));
    } else if (name === 'MultiEdit' && Array.isArray(i.edits)) {
      const total = i.edits.length;
      i.edits.forEach((ed, idx) => {
        if (!ed || ed.old_string == null || ed.new_string == null) return;
        parts.push(`<div class="tc-subhead">edit ${idx + 1} / ${total}</div>`);
        parts.push(renderUnifiedDiff(ed.old_string, ed.new_string));
      });
    } else if (name === 'Write' && i.content != null) {
      parts.push(`<div class="tc-subhead">content</div><pre class="tc-code">${escapeHtml(String(i.content).slice(0, 4000))}${String(i.content).length > 4000 ? '\n…(truncated)' : ''}</pre>`);
    }
  } else if (name === 'Grep' || name === 'Glob') {
    const kv = [];
    for (const k of Object.keys(i)) {
      const v = i[k];
      if (v == null || v === '') continue;
      kv.push(`<span class="tc-meta-key">${escapeHtml(k)}</span> <span class="tc-meta-val">${escapeHtml(String(v))}</span>`);
    }
    if (kv.length) parts.push(`<div class="tc-meta">${kv.join('')}</div>`);
  } else {
    // Generic JSON input fallback
    try {
      parts.push(`<pre class="tc-code">${escapeHtml(JSON.stringify(i, null, 2))}</pre>`);
    } catch (e) {}
  }

  // Output section
  if (entry.result != null && entry.result !== '') {
    const isError = entry.status === 'error';
    parts.push(`<div class="tc-subhead${isError ? ' tc-subhead-error' : ''}">output${isError ? ' (error)' : ''}</div>`);
    const text = String(entry.result);
    const truncated = text.length > 8000 ? text.slice(0, 8000) + '\n…(truncated)' : text;
    const cls = name === 'Bash' ? 'tc-code tc-code-bash' : 'tc-code';
    parts.push(`<pre class="${cls}${isError ? ' tc-output-error' : ''}">${escapeHtml(truncated)}</pre>`);
  }

  return parts.join('');
}

function renderTodoList(todos) {
  if (!Array.isArray(todos) || !todos.length) return '';
  const items = todos.map((t) => {
    const status = t.status || 'pending';
    const label = (status === 'in_progress' && t.activeForm) ? t.activeForm : (t.content || '');
    const icon = status === 'completed'
      ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
      : status === 'in_progress'
        ? '<span class="tc-spinner tc-spinner-sm"></span>'
        : '<span class="todo-empty-box"></span>';
    return `<li class="todo-item todo-${status}"><span class="todo-icon">${icon}</span><span class="todo-label">${escapeHtml(label)}</span></li>`;
  }).join('');
  return `<ul class="todo-list">${items}</ul>`;
}

function renderUnifiedDiff(oldText, newText) {
  const patch = window.libs.structuredPatch(oldText || '', newText || '', 3);
  if (!patch || !Array.isArray(patch.hunks) || patch.hunks.length === 0) {
    return `<pre class="tc-code">${escapeHtml(String(newText || ''))}</pre>`;
  }

  const last = patch.hunks[patch.hunks.length - 1];
  const maxLine = Math.max(last.oldStart + last.oldLines, last.newStart + last.newLines);
  const gutterW = Math.max(2, String(maxLine).length);

  const hunks = patch.hunks.map(h => {
    const header = `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`;
    let oldN = h.oldStart;
    let newN = h.newStart;
    const rows = h.lines.map(line => {
      const sign = line.charAt(0);
      const body = line.slice(1);
      let cls = 'diff-ctx';
      let oldCell = '';
      let newCell = '';
      if (sign === '+') {
        cls = 'diff-add';
        newCell = String(newN++);
      } else if (sign === '-') {
        cls = 'diff-del';
        oldCell = String(oldN++);
      } else if (sign === '\\') {
        cls = 'diff-note';
      } else {
        oldCell = String(oldN++);
        newCell = String(newN++);
      }
      return `<div class="diff-line ${cls}">` +
        `<span class="diff-gutter diff-gutter-old" style="min-width:${gutterW}ch">${oldCell}</span>` +
        `<span class="diff-gutter diff-gutter-new" style="min-width:${gutterW}ch">${newCell}</span>` +
        `<span class="diff-sign">${sign ? escapeHtml(sign) : '\u00a0'}</span>` +
        `<span class="diff-body">${escapeHtml(body)}</span>` +
        `</div>`;
    }).join('');
    return `<div class="diff-hunk-header">${escapeHtml(header)}</div>${rows}`;
  }).join('');

  return `<div class="tc-diff-block">${hunks}</div>`;
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

// ===== Inline Confirm Dialog =====
function confirmInline(title, description, { okLabel = 'Continue', cancelLabel = 'Cancel' } = {}) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('confirm-overlay');
    const titleEl = document.getElementById('confirm-title');
    const descEl = document.getElementById('confirm-description');
    const okBtn = document.getElementById('confirm-ok');
    const cancelBtn = document.getElementById('confirm-cancel');

    titleEl.textContent = title;
    descEl.textContent = description || '';
    descEl.style.display = description ? '' : 'none';
    okBtn.textContent = okLabel;
    cancelBtn.textContent = cancelLabel;
    overlay.classList.remove('hidden');
    setTimeout(() => { okBtn.focus(); }, 0);

    const cleanup = () => {
      overlay.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKey);
    };
    const onOk = () => { cleanup(); resolve(true); };
    const onCancel = () => { cleanup(); resolve(false); };
    const onKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); onOk(); }
      else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    };
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey);
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
    sessionLogic.resetSessionForContextSwitch(conv, generateUUID);
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
  const hasHistory = Array.isArray(conv.messages) && conv.messages.length > 0;
  if (hasHistory) {
    const ok = await confirmInline(
      'Enable worktree for this chat?',
      `This chat already has messages. Enabling a worktree switches Claude to a new project context, so Claude will start fresh and won't have access to the prior turns in this conversation.\n\nYour existing messages will still be visible in the UI.`,
      { okLabel: 'Enable worktree', cancelLabel: 'Cancel' }
    );
    if (!ok) return;
  }
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
    sessionLogic.resetSessionForContextSwitch(conv, generateUUID);
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

// ===== PR Panel =====
const prState = {
  repo: null, // { owner, name, url }
  authOk: null, // true | false | null (unknown)
  view: 'list', // 'list' | 'detail'
  currentPr: null, // { number, title, ... } in detail view
  listing: false,
};

function ghProjectPath() {
  const conv = getCurrentConversation();
  return conv ? (conv.projectPath || conv.worktreePath || null) : null;
}

function showPrView(view) {
  prState.view = view;
  prListEl.classList.toggle('hidden', view !== 'list');
  prDetailEl.classList.toggle('hidden', view !== 'detail');
  prBackBtn.classList.toggle('hidden', view !== 'detail');
  prHeaderLabel.textContent = view === 'detail' ? `PR #${prState.currentPr ? prState.currentPr.number : ''}` : 'Pull Requests';
}

async function openPrPanel() {
  const cwd = ghProjectPath();
  if (!cwd) {
    prState.repo = null;
    prListEl.innerHTML = '<div class="pr-state-msg">No project selected. Pick a folder first.</div>';
    prRepoLabel.textContent = '';
    showPrView('list');
    return;
  }
  // Check auth lazily
  if (prState.authOk !== true) {
    const auth = await window.gh.authStatus();
    prState.authOk = !!auth.ok;
    if (!prState.authOk) {
      prListEl.innerHTML = `
        <div class="pr-state-msg">
          GitHub CLI is not authenticated.<br>
          Run <code>gh auth login</code> in your terminal, then refresh.
        </div>`;
      prRepoLabel.textContent = '';
      showPrView('list');
      return;
    }
  }
  // Discover repo
  const repo = await window.gh.repoInfo(cwd);
  prState.repo = repo;
  if (!repo || !repo.owner || !repo.name) {
    prListEl.innerHTML = '<div class="pr-state-msg">This project has no GitHub remote configured.</div>';
    prRepoLabel.textContent = '';
    showPrView('list');
    return;
  }
  prRepoLabel.textContent = `${repo.owner}/${repo.name}`;
  await refreshPrList();
}

async function refreshPrList() {
  const cwd = ghProjectPath();
  if (!cwd || !prState.repo) return;
  if (prState.listing) return;
  prState.listing = true;
  prListEl.innerHTML = '<div class="pr-state-msg">Loading…</div>';
  const res = await window.gh.prList(cwd, state.prFilter);
  prState.listing = false;
  if (!res.ok) {
    prListEl.innerHTML = `<div class="pr-state-msg">Error: ${escapeHtml(res.error)}</div>`;
    return;
  }
  renderPrList(res.prs || []);
}

function reviewDecisionBadge(decision) {
  if (decision === 'APPROVED') return { cls: 'pr-badge-approved', text: 'Approved' };
  if (decision === 'CHANGES_REQUESTED') return { cls: 'pr-badge-changes', text: 'Changes' };
  if (decision === 'REVIEW_REQUIRED') return { cls: 'pr-badge-review', text: 'Review' };
  return null;
}

function formatRelativeTime(isoStr) {
  if (!isoStr) return '';
  const then = new Date(isoStr).getTime();
  if (!Number.isFinite(then)) return '';
  const diff = Date.now() - then;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(isoStr).toLocaleDateString();
}

function renderPrList(prs) {
  prListEl.innerHTML = '';
  if (!prs.length) {
    prListEl.innerHTML = '<div class="pr-state-msg">No open PRs.</div>';
    return;
  }
  for (const pr of prs) {
    const row = document.createElement('div');
    row.className = 'pr-row';
    row.addEventListener('click', () => openPrDetail(pr));

    const titleRow = document.createElement('div');
    titleRow.className = 'pr-row-title';
    const num = document.createElement('span');
    num.className = 'pr-number';
    num.textContent = `#${pr.number}`;
    titleRow.appendChild(num);
    const title = document.createElement('span');
    title.className = 'pr-title-text';
    title.textContent = pr.title || '';
    titleRow.appendChild(title);
    row.appendChild(titleRow);

    const meta = document.createElement('div');
    meta.className = 'pr-row-meta';
    const author = document.createElement('span');
    author.textContent = `@${pr.author && pr.author.login || '?'}`;
    meta.appendChild(author);
    const updated = document.createElement('span');
    updated.textContent = formatRelativeTime(pr.updatedAt);
    meta.appendChild(updated);
    if (pr.isDraft) {
      const badge = document.createElement('span');
      badge.className = 'pr-badge pr-badge-draft';
      badge.textContent = 'Draft';
      meta.appendChild(badge);
    }
    const rev = reviewDecisionBadge(pr.reviewDecision);
    if (rev) {
      const badge = document.createElement('span');
      badge.className = `pr-badge ${rev.cls}`;
      badge.textContent = rev.text;
      meta.appendChild(badge);
    }
    row.appendChild(meta);
    prListEl.appendChild(row);
  }
}

async function openPrDetail(pr) {
  prState.currentPr = pr;
  showPrView('detail');
  prDetailEl.innerHTML = '<div class="pr-state-msg">Loading…</div>';
  const cwd = ghProjectPath();
  const res = await window.gh.prDetail(cwd, pr.number);
  if (!res.ok) {
    prDetailEl.innerHTML = `<div class="pr-state-msg">Error: ${escapeHtml(res.error)}</div>`;
    return;
  }
  renderPrDetail(res.pr, res.reviewComments || [], res.issueComments || [], res.reviews || []);
}

function groupReviewThreads(comments) {
  // GitHub's review comments link replies to a root via `in_reply_to_id`.
  // Build a map from root id → thread (in chronological order).
  const byId = new Map();
  for (const c of comments) byId.set(c.id, c);
  const threads = new Map(); // root id → array of comments
  for (const c of comments) {
    let root = c;
    while (root.in_reply_to_id && byId.has(root.in_reply_to_id)) {
      root = byId.get(root.in_reply_to_id);
    }
    if (!threads.has(root.id)) threads.set(root.id, []);
    threads.get(root.id).push(c);
  }
  for (const list of threads.values()) {
    list.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  }
  return Array.from(threads.values());
}

function renderPrDetail(pr, reviewComments, issueComments, reviews = []) {
  prDetailEl.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'pr-detail-header';
  const title = document.createElement('div');
  title.className = 'pr-detail-title';
  title.textContent = pr.title || '';
  header.appendChild(title);
  const meta = document.createElement('div');
  meta.className = 'pr-detail-meta';
  const author = document.createElement('span');
  author.textContent = `@${pr.author && pr.author.login || '?'}`;
  meta.appendChild(author);
  const branches = document.createElement('span');
  branches.textContent = `${pr.headRefName} → ${pr.baseRefName}`;
  meta.appendChild(branches);
  if (pr.reviewDecision) {
    const rev = reviewDecisionBadge(pr.reviewDecision);
    if (rev) {
      const badge = document.createElement('span');
      badge.className = `pr-badge ${rev.cls}`;
      badge.textContent = rev.text;
      meta.appendChild(badge);
    }
  }
  const openLink = document.createElement('a');
  openLink.href = pr.url;
  openLink.textContent = 'Open on GitHub';
  openLink.style.marginLeft = 'auto';
  openLink.addEventListener('click', (e) => {
    e.preventDefault();
    window.shellAPI.openExternal(pr.url);
  });
  meta.appendChild(openLink);
  header.appendChild(meta);
  prDetailEl.appendChild(header);

  if (pr.body) {
    const body = document.createElement('div');
    body.className = 'pr-detail-body';
    body.textContent = pr.body;
    prDetailEl.appendChild(body);
  }

  // Review summaries (top-level body from submitted reviews — Approve/Request changes/Comment)
  const reviewsWithBody = (reviews || []).filter(r => r && r.body && r.body.trim());
  if (reviewsWithBody.length) {
    const h = document.createElement('div');
    h.className = 'pr-section-header';
    h.textContent = 'Reviews';
    prDetailEl.appendChild(h);
    for (const r of reviewsWithBody) {
      prDetailEl.appendChild(renderReviewSummary(pr, r));
    }
  }

  // Review threads (inline code comments)
  const threads = groupReviewThreads(reviewComments);
  if (threads.length) {
    const h = document.createElement('div');
    h.className = 'pr-section-header';
    h.textContent = 'Review threads';
    prDetailEl.appendChild(h);
    for (const thread of threads) {
      prDetailEl.appendChild(renderReviewThread(pr, thread));
    }
  }

  // Issue-level comments (top of PR discussion)
  if (issueComments.length) {
    const h = document.createElement('div');
    h.className = 'pr-section-header';
    h.textContent = 'Discussion';
    prDetailEl.appendChild(h);
    for (const c of issueComments) {
      prDetailEl.appendChild(renderIssueComment(pr, c));
    }
  }

  // Composer for a new top-level comment
  prDetailEl.appendChild(renderIssueComposer(pr));
}

function renderReviewThread(pr, thread) {
  const root = thread[0];
  const wrap = document.createElement('div');
  wrap.className = 'pr-thread';

  const anchor = document.createElement('div');
  anchor.className = 'pr-thread-anchor';
  const linePart = root.line ? `:${root.line}` : (root.original_line ? `:${root.original_line}` : '');
  anchor.textContent = `${root.path || ''}${linePart}`;
  wrap.appendChild(anchor);

  if (root.diff_hunk) {
    const diff = document.createElement('pre');
    diff.className = 'pr-comment-diff';
    diff.textContent = root.diff_hunk;
    wrap.appendChild(diff);
  }

  for (const c of thread) {
    wrap.appendChild(renderComment(c));
  }

  const actions = document.createElement('div');
  actions.className = 'pr-thread-actions';
  const replyBtn = document.createElement('button');
  replyBtn.className = 'pr-action-btn';
  replyBtn.textContent = 'Reply';
  actions.appendChild(replyBtn);
  const helpBtn = document.createElement('button');
  helpBtn.className = 'pr-action-btn pr-action-btn-primary';
  helpBtn.textContent = 'Help me respond';
  helpBtn.addEventListener('click', () => helpMeRespondThread(pr, thread));
  actions.appendChild(helpBtn);
  wrap.appendChild(actions);

  const composer = renderReplyComposer(pr, root.id);
  composer.classList.add('hidden');
  replyBtn.addEventListener('click', () => composer.classList.toggle('hidden'));
  wrap.appendChild(composer);

  return wrap;
}

function reviewStateBadge(reviewState) {
  switch ((reviewState || '').toUpperCase()) {
    case 'APPROVED': return { cls: 'pr-badge-approved', text: 'Approved' };
    case 'CHANGES_REQUESTED': return { cls: 'pr-badge-changes', text: 'Changes requested' };
    case 'COMMENTED': return { cls: 'pr-badge-review', text: 'Commented' };
    case 'DISMISSED': return { cls: 'pr-badge-draft', text: 'Dismissed' };
    default: return null;
  }
}

function renderReviewSummary(pr, review) {
  const wrap = document.createElement('div');
  wrap.className = 'pr-thread';

  const head = document.createElement('div');
  head.className = 'pr-comment-head';
  head.style.padding = '8px 10px 0';
  const author = document.createElement('span');
  author.className = 'pr-author';
  author.textContent = `@${review.user && review.user.login || '?'}`;
  head.appendChild(author);
  const when = document.createElement('span');
  when.textContent = formatRelativeTime(review.submitted_at);
  head.appendChild(when);
  const badge = reviewStateBadge(review.state);
  if (badge) {
    const b = document.createElement('span');
    b.className = `pr-badge ${badge.cls}`;
    b.textContent = badge.text;
    b.style.marginLeft = 'auto';
    head.appendChild(b);
  }
  wrap.appendChild(head);

  const body = document.createElement('div');
  body.className = 'pr-comment-body';
  body.style.padding = '4px 10px 10px';
  body.textContent = review.body || '';
  wrap.appendChild(body);

  const actions = document.createElement('div');
  actions.className = 'pr-thread-actions';
  const helpBtn = document.createElement('button');
  helpBtn.className = 'pr-action-btn pr-action-btn-primary';
  helpBtn.textContent = 'Help me respond';
  helpBtn.addEventListener('click', () => helpMeRespondReview(pr, review));
  actions.appendChild(helpBtn);
  wrap.appendChild(actions);

  return wrap;
}

function renderIssueComment(pr, c) {
  const wrap = document.createElement('div');
  wrap.className = 'pr-thread';
  wrap.appendChild(renderComment(c));
  const actions = document.createElement('div');
  actions.className = 'pr-thread-actions';
  const helpBtn = document.createElement('button');
  helpBtn.className = 'pr-action-btn pr-action-btn-primary';
  helpBtn.textContent = 'Help me respond';
  helpBtn.addEventListener('click', () => helpMeRespondIssueComment(pr, c));
  actions.appendChild(helpBtn);
  wrap.appendChild(actions);
  return wrap;
}

function renderComment(c) {
  const el = document.createElement('div');
  el.className = 'pr-comment';
  const head = document.createElement('div');
  head.className = 'pr-comment-head';
  const author = document.createElement('span');
  author.className = 'pr-author';
  author.textContent = `@${c.user && c.user.login || '?'}`;
  head.appendChild(author);
  const when = document.createElement('span');
  when.textContent = formatRelativeTime(c.created_at);
  head.appendChild(when);
  el.appendChild(head);
  const body = document.createElement('div');
  body.className = 'pr-comment-body';
  body.textContent = c.body || '';
  el.appendChild(body);
  return el;
}

function renderReplyComposer(pr, inReplyToId) {
  const wrap = document.createElement('div');
  wrap.className = 'pr-reply-composer';
  const ta = document.createElement('textarea');
  ta.placeholder = 'Reply to thread…';
  wrap.appendChild(ta);
  const actions = document.createElement('div');
  actions.className = 'pr-reply-composer-actions';
  const cancel = document.createElement('button');
  cancel.className = 'pr-action-btn';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => {
    ta.value = '';
    wrap.classList.add('hidden');
  });
  actions.appendChild(cancel);
  const submit = document.createElement('button');
  submit.className = 'pr-action-btn pr-action-btn-primary';
  submit.textContent = 'Reply';
  submit.addEventListener('click', async () => {
    const body = ta.value.trim();
    if (!body) return;
    submit.disabled = true;
    submit.textContent = 'Posting…';
    const res = await window.gh.prReplyReview(ghProjectPath(), pr.number, inReplyToId, body);
    submit.disabled = false;
    submit.textContent = 'Reply';
    if (!res.ok) {
      alert(`Reply failed: ${res.error}`);
      return;
    }
    ta.value = '';
    wrap.classList.add('hidden');
    openPrDetail(pr);
  });
  actions.appendChild(submit);
  wrap.appendChild(actions);
  return wrap;
}

function renderIssueComposer(pr) {
  const wrap = document.createElement('div');
  wrap.className = 'pr-issue-composer';
  const label = document.createElement('div');
  label.className = 'pr-section-header';
  label.style.margin = '0';
  label.textContent = 'Add a comment';
  wrap.appendChild(label);
  const ta = document.createElement('textarea');
  ta.placeholder = 'Write a comment…';
  wrap.appendChild(ta);
  const actions = document.createElement('div');
  actions.className = 'pr-issue-composer-actions';
  const submit = document.createElement('button');
  submit.className = 'pr-action-btn pr-action-btn-primary';
  submit.textContent = 'Comment';
  submit.addEventListener('click', async () => {
    const body = ta.value.trim();
    if (!body) return;
    submit.disabled = true;
    submit.textContent = 'Posting…';
    const res = await window.gh.prComment(ghProjectPath(), pr.number, body);
    submit.disabled = false;
    submit.textContent = 'Comment';
    if (!res.ok) {
      alert(`Comment failed: ${res.error}`);
      return;
    }
    ta.value = '';
    openPrDetail(pr);
  });
  actions.appendChild(submit);
  wrap.appendChild(actions);
  return wrap;
}

function helpMeRespondThread(pr, thread) {
  const root = thread[0];
  const anchor = root.path
    ? `${root.path}${root.line ? `:${root.line}` : (root.original_line ? `:${root.original_line}` : '')}`
    : null;
  const lines = [
    `Help me draft a reply to a pull-request review thread.`,
    ``,
    `PR: #${pr.number} "${pr.title}" — ${pr.url}`,
  ];
  if (anchor) lines.push(`Anchor: ${anchor}`);
  if (root.diff_hunk) {
    lines.push('', 'Diff context:', '```', root.diff_hunk, '```');
  }
  lines.push('', 'Thread:');
  for (const c of thread) {
    lines.push(`@${c.user && c.user.login || '?'}: ${c.body || ''}`);
    lines.push('');
  }
  lines.push('Please draft a clear, thoughtful reply I can paste back. Keep it conversational and specific to what was asked.');
  prefillChatInput(lines.join('\n'));
}

function helpMeRespondReview(pr, review) {
  const verdict = reviewStateBadge(review.state);
  const lines = [
    `Help me draft a reply to a pull-request review.`,
    ``,
    `PR: #${pr.number} "${pr.title}" — ${pr.url}`,
    `Reviewer verdict: ${verdict ? verdict.text : (review.state || 'Commented')}`,
    ``,
    `@${review.user && review.user.login || '?'} wrote:`,
    review.body || '',
    ``,
    `Please draft a clear, thoughtful reply I can paste back. Address the reviewer's verdict directly.`,
  ];
  prefillChatInput(lines.join('\n'));
}

function helpMeRespondIssueComment(pr, comment) {
  const lines = [
    `Help me draft a reply to a pull-request comment.`,
    ``,
    `PR: #${pr.number} "${pr.title}" — ${pr.url}`,
    ``,
    `@${comment.user && comment.user.login || '?'}: ${comment.body || ''}`,
    ``,
    `Please draft a clear, thoughtful reply I can paste back.`,
  ];
  prefillChatInput(lines.join('\n'));
}

function prefillChatInput(text) {
  inputEl.value = text;
  autoResize();
  inputEl.focus();
  // Move caret to end
  const end = inputEl.value.length;
  try { inputEl.setSelectionRange(end, end); } catch (e) {}
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
  applyRightPanelVisibility();
  renderWsTabs();
  renderWsTree();
  restoreOpenFiles();
  if (state.rightPanel === 'pr') openPrPanel();
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
  setupSideResize(prResizeEl, prPanel, (w) => {
    state.prPanelWidth = w;
    saveState();
  }, { min: 340, edge: 'left' });

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
  window.claude.onToolResult(handleToolResult);
  window.claude.onCompact(handleCompact);
  window.claude.onUsage(handleUsage);

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

  // Attach files / images to the next message
  attachBtn.addEventListener('click', async () => {
    const picked = await window.files.pickAttachments();
    if (!picked || !picked.length) return;
    let conv = getCurrentConversation();
    if (!conv) conv = createConversation('New Chat');
    if (!Array.isArray(conv.pendingAttachments)) conv.pendingAttachments = [];
    for (const p of picked) {
      if (!conv.pendingAttachments.includes(p)) conv.pendingAttachments.push(p);
    }
    saveState();
    renderAttachments();
    inputEl.focus();
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
  togglePrBtn.addEventListener('click', togglePrPanel);
  prBackBtn.addEventListener('click', () => {
    prState.currentPr = null;
    showPrView('list');
  });
  prRefreshBtn.addEventListener('click', () => {
    if (prState.view === 'detail' && prState.currentPr) {
      openPrDetail(prState.currentPr);
    } else {
      openPrPanel();
    }
  });
  prFilterRowEl.querySelectorAll('.pr-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const f = btn.getAttribute('data-filter');
      if (!f || f === state.prFilter) return;
      state.prFilter = f;
      prFilterRowEl.querySelectorAll('.pr-filter-btn').forEach(b => b.classList.toggle('active', b.getAttribute('data-filter') === f));
      saveState();
      refreshPrList();
    });
  });
  // Initialise filter UI from persisted state
  prFilterRowEl.querySelectorAll('.pr-filter-btn').forEach(b => b.classList.toggle('active', b.getAttribute('data-filter') === state.prFilter));
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
    // Ctrl+Shift+P (Cmd+Shift+P on mac): Toggle PR panel
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'P' || e.key === 'p')) {
      e.preventDefault();
      togglePrPanel();
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
