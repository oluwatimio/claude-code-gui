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
  prPollMinutes: 2, // 0 = off; otherwise polling cadence for CI checks on the open PR
  preferredIde: null, // last IDE the user picked from the file modal's "Open in" menu
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
const filePickerEl = document.getElementById('file-picker');
const sendBtn = document.getElementById('send-btn');
const stopBtn = document.getElementById('stop-btn');
const statusText = document.getElementById('status-text');
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
const wsToolsListEl = document.getElementById('ws-tools-list');
const wsToolsFiltersEl = document.getElementById('ws-tools-filters');
const wsToolsCountEl = document.getElementById('ws-tools-count');
const wsFilesDotEl = document.getElementById('ws-files-dot');
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
const terminalTabsEl = document.getElementById('terminal-tabs');
const terminalNewTabBtn = document.getElementById('btn-terminal-new-tab');
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

function renderAssistantStats(msgEl, stats) {
  if (!msgEl || !stats) return;
  const existing = msgEl.querySelector(':scope > .message-stats');
  if (existing) existing.remove();
  const parts = [];
  if (stats.cost != null) parts.push(`$${Number(stats.cost).toFixed(4)}`);
  if (stats.duration) parts.push(`${(stats.duration / 1000).toFixed(1)}s`);
  if (stats.model) parts.push(String(stats.model));
  if (!parts.length) return;
  const footer = document.createElement('div');
  footer.className = 'message-stats';
  footer.textContent = parts.join(' · ');
  if (stats.cost != null) {
    footer.title = `${Number(stats.cost).toFixed(6)} USD` +
      (stats.duration ? ` · ${(stats.duration / 1000).toFixed(2)}s` : '') +
      (stats.model ? ` · ${stats.model}` : '');
  }
  msgEl.appendChild(footer);
}

function createMessageEl(role, content, isStreaming = false, thinking = '', attachments = null, filesAccessed = null, toolCalls = null, messageIndex = null, stats = null) {
  const msg = document.createElement('div');
  msg.className = `message message-${role}`;
  if (messageIndex != null) msg.dataset.msgIndex = String(messageIndex);

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

  if (role === 'user' && messageIndex != null) {
    const rewindBtn = document.createElement('button');
    rewindBtn.type = 'button';
    rewindBtn.className = 'message-rewind-btn';
    rewindBtn.title = 'Rewind to this point';
    rewindBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="1 4 1 10 7 10"/>
      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
    </svg>`;
    rewindBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = Number(msg.dataset.msgIndex);
      if (Number.isFinite(idx)) requestRewindTo(idx);
    });
    header.appendChild(rewindBtn);
  }

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
  if (role === 'assistant' && stats && !isStreaming) {
    renderAssistantStats(msg, stats);
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
  conv.messages.forEach((msg, idx) => {
    if (msg.role === 'compact') {
      messagesEl.appendChild(createCompactBannerEl(msg));
      return;
    }
    messagesEl.appendChild(createMessageEl(msg.role, msg.content, false, msg.thinking || '', msg.attachments || null, msg.filesAccessed || null, msg.toolCalls || null, idx, msg.stats || null));
  });

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
  renderToolsView();
  renderRewindBanner();
  setFilesActivityDot(false);
  if (state.terminalOpen) mountTerminal();
  saveState();
}

async function requestRewindTo(messageIndex) {
  const conv = getCurrentConversation();
  if (!conv) return;
  if (conv.streaming) {
    await confirmInline(
      'Chat is still streaming',
      'Stop the current generation before rewinding.',
      { okLabel: 'OK', cancelLabel: ' ' }
    );
    return;
  }
  if (!Array.isArray(conv.messages) || messageIndex < 0 || messageIndex >= conv.messages.length) return;
  const target = conv.messages[messageIndex];
  if (!target || target.role !== 'user') return;
  const preview = (target.content || '').split('\n')[0].slice(0, 80);
  const ok = await confirmInline(
    'Rewind to this point?',
    `Messages from "${preview || '(empty)'}" onward will be removed. Files on disk aren’t touched — run "git status" after to inspect changes. You can undo from the banner.`,
    { okLabel: 'Rewind', cancelLabel: 'Cancel' }
  );
  if (!ok) return;
  rewindConversation(conv, messageIndex);
}

function rewindConversation(conv, messageIndex) {
  const target = conv.messages[messageIndex];
  const stashed = conv.messages.slice(messageIndex);
  conv.rewindStash = {
    messages: stashed,
    sessionId: conv.sessionId,
    pendingNewSession: !!conv.pendingNewSession,
    at: Date.now(),
    preview: (target.content || '').split('\n')[0].slice(0, 80),
  };
  conv.messages = conv.messages.slice(0, messageIndex);
  sessionLogic.resetSessionForContextSwitch(conv, generateUUID);
  // Pre-fill the input with the rewound prompt for easy re-steering
  inputEl.value = target.content || '';
  autoResize();
  inputEl.focus();
  // Re-render
  messagesEl.innerHTML = '';
  conv.messages.forEach((msg, idx) => {
    if (msg.role === 'compact') {
      messagesEl.appendChild(createCompactBannerEl(msg));
      return;
    }
    messagesEl.appendChild(createMessageEl(msg.role, msg.content, false, msg.thinking || '', msg.attachments || null, msg.filesAccessed || null, msg.toolCalls || null, idx, msg.stats || null));
  });
  if (conv.messages.length === 0) {
    welcomeEl.classList.remove('hidden');
    messagesEl.classList.add('hidden');
  }
  saveState();
  renderConversationList();
  renderRewindBanner();
  renderContextUsage();
}

function undoRewind(conv) {
  if (!conv || !conv.rewindStash) return;
  const stash = conv.rewindStash;
  conv.messages = conv.messages.concat(stash.messages);
  conv.sessionId = stash.sessionId;
  conv.pendingNewSession = stash.pendingNewSession;
  conv.rewindStash = null;
  // Re-render
  if (isCurrentConv(conv.id)) {
    messagesEl.innerHTML = '';
    conv.messages.forEach((msg, idx) => {
      if (msg.role === 'compact') {
        messagesEl.appendChild(createCompactBannerEl(msg));
        return;
      }
      messagesEl.appendChild(createMessageEl(msg.role, msg.content, false, msg.thinking || '', msg.attachments || null, msg.filesAccessed || null, msg.toolCalls || null, idx, msg.stats || null));
    });
    welcomeEl.classList.add('hidden');
    messagesEl.classList.remove('hidden');
    scrollToBottom();
    inputEl.value = '';
    autoResize();
    renderRewindBanner();
    renderContextUsage();
  }
  saveState();
  renderConversationList();
}

function renderRewindBanner() {
  const conv = getCurrentConversation();
  let banner = document.getElementById('rewind-banner');
  if (!conv || !conv.rewindStash) {
    if (banner) banner.remove();
    return;
  }
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'rewind-banner';
    banner.className = 'rewind-banner';
    const inputArea = document.getElementById('input-area');
    inputArea.insertBefore(banner, inputArea.firstChild);
  }
  const stash = conv.rewindStash;
  const count = stash.messages.length;
  banner.innerHTML = '';
  const label = document.createElement('span');
  label.className = 'rewind-banner-label';
  label.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="1 4 1 10 7 10"/>
    <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
  </svg>Rewound ${count} message${count === 1 ? '' : 's'}. Files on disk unchanged.`;
  banner.appendChild(label);
  const undoBtn = document.createElement('button');
  undoBtn.type = 'button';
  undoBtn.className = 'rewind-banner-btn';
  undoBtn.textContent = 'Undo';
  undoBtn.addEventListener('click', () => undoRewind(conv));
  banner.appendChild(undoBtn);
  const dismissBtn = document.createElement('button');
  dismissBtn.type = 'button';
  dismissBtn.className = 'rewind-banner-btn rewind-banner-dismiss';
  dismissBtn.title = 'Dismiss (keeps the rewind)';
  dismissBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>`;
  dismissBtn.addEventListener('click', () => {
    if (conv) conv.rewindStash = null;
    saveState();
    renderRewindBanner();
  });
  banner.appendChild(dismissBtn);
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
  if (conv) killAllTerminalsForConv(conv);

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

function renameConversation(id, newTitle) {
  const conv = state.conversations.find((c) => c.id === id);
  if (!conv) return;
  const trimmed = (newTitle || '').trim();
  if (!trimmed || trimmed === conv.title) return;
  conv.title = trimmed.slice(0, 200);
  saveState();
  renderConversationList();
}

function startRenameConversation(id, titleEl) {
  const conv = state.conversations.find((c) => c.id === id);
  if (!conv) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'conv-title-input';
  input.value = conv.title;
  input.spellcheck = false;
  titleEl.replaceWith(input);
  input.focus();
  input.select();

  let committed = false;
  const commit = (save) => {
    if (committed) return;
    committed = true;
    if (save) {
      renameConversation(id, input.value);
    } else {
      renderConversationList();
    }
  };
  input.onclick = (e) => e.stopPropagation();
  input.ondblclick = (e) => e.stopPropagation();
  input.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      commit(false);
    }
  };
  input.onblur = () => commit(true);
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
    title.ondblclick = (e) => {
      e.stopPropagation();
      startRenameConversation(conv.id, title);
    };
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

    const renameBtn = document.createElement('button');
    renameBtn.className = 'rename-btn';
    renameBtn.title = 'Rename chat';
    renameBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 20h9"/>
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
    </svg>`;
    renameBtn.onclick = (e) => {
      e.stopPropagation();
      startRenameConversation(conv.id, title);
    };
    item.appendChild(renameBtn);

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
  renderToolsView();
  renderRewindBanner();
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
      prPollMinutes: state.prPollMinutes,
      preferredIde: state.preferredIde,
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
      if (typeof data.prPollMinutes === 'number' && data.prPollMinutes >= 0 && data.prPollMinutes <= 60) {
        state.prPollMinutes = data.prPollMinutes;
      }
      if (typeof data.preferredIde === 'string' && data.preferredIde) {
        state.preferredIde = data.preferredIde;
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
  // Commit any pending rewind — sending a new message means we're moving on.
  if (conv.rewindStash) {
    conv.rewindStash = null;
    renderRewindBanner();
  }
  messagesEl.appendChild(createMessageEl('user', prompt, false, '', attachments, null, null, conv.messages.length - 1));
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

function finalizeStream(convId, { save = true, stats = null } = {}) {
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
    if (stats) m.stats = stats;
    conv.messages.push(m);
    if (el && stats) renderAssistantStats(el, stats);
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
    updateToolsCountBadge(conv);
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
  const stats = (data.cost != null || data.duration || data.model)
    ? { cost: data.cost ?? null, duration: data.duration ?? null, model: data.model || null }
    : null;
  finalizeStream(data.convId, { save: true, stats });

  // Fire desktop notification if the user isn't currently watching this chat
  let detail = '';
  if (data.cost != null) {
    detail = `$${Number(data.cost).toFixed(4)}`;
    if (data.duration) detail += ` · ${(data.duration / 1000).toFixed(1)}s`;
  }
  notifyChatFinished(data.convId, { kind: 'done', detail });

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
  if (currentAskData && (!currentAskData.convId || currentAskData.convId === convId)) {
    hideAskDialog();
  }
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
  // If the ask dialog is open for this conv, close it — the process is gone.
  if (currentAskData && (!currentAskData.convId || currentAskData.convId === convId)) {
    hideAskDialog();
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

// ===== Ask-User Dialog =====
const askOverlay = document.getElementById('ask-overlay');
const askQuestionEl = document.getElementById('ask-question');
const askContextEl = document.getElementById('ask-context');
const askOptionsEl = document.getElementById('ask-options');
const askAnswerInput = document.getElementById('ask-answer-input');
const askSubmitBtn = document.getElementById('ask-submit');
const askCancelBtn = document.getElementById('ask-cancel');

let currentAskData = null;

function showAskDialog(data) {
  currentAskData = data;
  askQuestionEl.textContent = data.question || '';
  if (data.context) {
    askContextEl.textContent = data.context;
    askContextEl.classList.remove('hidden');
  } else {
    askContextEl.textContent = '';
    askContextEl.classList.add('hidden');
  }
  askOptionsEl.innerHTML = '';
  const options = Array.isArray(data.options) ? data.options : [];
  if (options.length) {
    for (const opt of options) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ask-option';
      btn.textContent = opt;
      btn.addEventListener('click', () => submitAskAnswer(opt));
      askOptionsEl.appendChild(btn);
    }
    askOptionsEl.classList.remove('hidden');
  } else {
    askOptionsEl.classList.add('hidden');
  }
  askAnswerInput.value = '';
  askOverlay.classList.remove('hidden');
  askAnswerInput.focus();
}

function hideAskDialog() {
  askOverlay.classList.add('hidden');
  currentAskData = null;
}

function submitAskAnswer(answerText) {
  if (!currentAskData) return;
  const askId = currentAskData.askId;
  const answer = (answerText ?? askAnswerInput.value ?? '').trim();
  if (!answer) {
    askAnswerInput.focus();
    return;
  }
  window.claude.respondAsk(askId, { answer });
  hideAskDialog();
  setStatus('streaming', 'Generating...');
}

function cancelAskAnswer() {
  if (!currentAskData) return;
  window.claude.respondAsk(currentAskData.askId, { canceled: true });
  hideAskDialog();
  setStatus('streaming', 'Generating...');
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

// ===== @-mention file picker =====

const filePicker = {
  open: false,
  anchor: -1,       // index of '@' in textarea value
  query: '',
  results: [],      // [{ root, rel }]
  selected: 0,
  cache: new Map(), // rootsKey -> Promise<Array<{root, rel}>>
};

function getRootsKey(roots) {
  return roots.slice().sort().join('|');
}

async function loadFileListForCurrent() {
  const roots = workspaceRoots();
  if (!roots.length) return [];
  const key = getRootsKey(roots);
  if (!filePicker.cache.has(key)) {
    filePicker.cache.set(key, window.files.listAll(roots).catch(() => []));
  }
  return filePicker.cache.get(key);
}

function invalidateFilePickerCache() {
  filePicker.cache.clear();
}

// Fuzzy scoring + ranking live in lib/fuzzy-match.js (shared with Spotlight
// and tested in isolation). These thin aliases keep the in-file call sites
// readable.
const fuzzyScore = fuzzyMatch.fuzzyScore;
const rankFiles = (files, query) => fuzzyMatch.rankFiles(files, query, { limit: 50 });

function detectFilePickerTrigger() {
  if (!inputEl) return;
  const val = inputEl.value;
  const caret = inputEl.selectionStart;
  if (caret !== inputEl.selectionEnd) { closeFilePicker(); return; }
  // Walk back from caret to find an unescaped '@' preceded by start-of-input or whitespace
  let i = caret - 1;
  let atPos = -1;
  while (i >= 0) {
    const ch = val[i];
    if (ch === '@') {
      const prev = i > 0 ? val[i - 1] : '';
      if (i === 0 || /\s/.test(prev)) atPos = i;
      break;
    }
    if (/\s/.test(ch)) break;
    i--;
  }
  if (atPos === -1) { closeFilePicker(); return; }
  const query = val.slice(atPos + 1, caret);
  // Only letters/digits/._-/ are valid in a file query; space / other chars close
  if (!/^[a-zA-Z0-9._\-\/]*$/.test(query)) { closeFilePicker(); return; }
  openFilePicker(atPos, query);
}

async function openFilePicker(anchor, query) {
  filePicker.open = true;
  filePicker.anchor = anchor;
  filePicker.query = query;
  filePicker.selected = 0;
  const files = await loadFileListForCurrent();
  // If the picker was closed while awaiting, bail
  if (!filePicker.open || filePicker.anchor !== anchor) return;
  filePicker.results = rankFiles(files, query);
  filePicker.selected = 0;
  renderFilePicker();
}

function closeFilePicker() {
  if (!filePicker.open) return;
  filePicker.open = false;
  filePicker.anchor = -1;
  filePicker.query = '';
  filePicker.results = [];
  filePicker.selected = 0;
  if (filePickerEl) filePickerEl.classList.add('hidden');
}

function moveFilePickerSelection(delta) {
  if (!filePicker.open || !filePicker.results.length) return;
  const n = filePicker.results.length;
  filePicker.selected = ((filePicker.selected + delta) % n + n) % n;
  renderFilePicker();
}

function acceptFilePickerSelection() {
  if (!filePicker.open || !filePicker.results.length) return false;
  const pick = filePicker.results[filePicker.selected];
  if (!pick) return false;
  const anchor = filePicker.anchor;
  const caret = inputEl.selectionStart;
  const before = inputEl.value.slice(0, anchor);
  const after = inputEl.value.slice(caret);
  const suffix = pick.type === 'dir' ? '/' : '';
  const insertion = `@${pick.rel}${suffix}`;
  const needsSpace = pick.type === 'file' && !after.startsWith(' ');
  const newVal = before + insertion + (needsSpace ? ' ' : '') + after;
  inputEl.value = newVal;
  const newCaret = (before + insertion + (needsSpace ? ' ' : '')).length;
  inputEl.setSelectionRange(newCaret, newCaret);
  closeFilePicker();
  autoResize();
  return true;
}

function highlightMatches(text, positions) {
  if (!positions || !positions.length) return escapeHtml(text);
  const set = new Set(positions);
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = escapeHtml(text[i]);
    out += set.has(i) ? `<mark>${ch}</mark>` : ch;
  }
  return out;
}

function renderFilePicker() {
  if (!filePickerEl) return;
  if (!filePicker.open) { filePickerEl.classList.add('hidden'); return; }
  filePickerEl.innerHTML = '';
  if (!filePicker.results.length) {
    const empty = document.createElement('div');
    empty.className = 'file-picker-empty';
    empty.textContent = filePicker.query
      ? `No files match “${filePicker.query}”`
      : 'No files found in this project.';
    filePickerEl.appendChild(empty);
    filePickerEl.classList.remove('hidden');
    return;
  }
  filePicker.results.forEach((entry, idx) => {
    const item = document.createElement('div');
    item.className = 'file-picker-item' + (idx === filePicker.selected ? ' selected' : '') + (entry.type === 'dir' ? ' is-dir' : '');
    const slash = entry.rel.lastIndexOf('/');
    const dir = slash >= 0 ? entry.rel.slice(0, slash) : '';
    const name = slash >= 0 ? entry.rel.slice(slash + 1) : entry.rel;
    const baseOffset = slash >= 0 ? slash + 1 : 0;
    const namePositions = (entry._positions || []).filter((p) => p >= baseOffset).map((p) => p - baseOffset);
    const dirPositions = (entry._positions || []).filter((p) => p < baseOffset);

    const icon = document.createElement('span');
    icon.className = 'file-picker-icon';
    icon.innerHTML = entry.type === 'dir'
      ? `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`
      : `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
    item.appendChild(icon);

    const nameEl = document.createElement('span');
    nameEl.className = 'file-picker-name';
    nameEl.innerHTML = highlightMatches(name, namePositions) + (entry.type === 'dir' ? '/' : '');
    item.appendChild(nameEl);

    if (dir) {
      const dirEl = document.createElement('span');
      dirEl.className = 'file-picker-dir';
      dirEl.innerHTML = highlightMatches(dir, dirPositions);
      item.appendChild(dirEl);
    }
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      filePicker.selected = idx;
      acceptFilePickerSelection();
      inputEl.focus();
    });
    filePickerEl.appendChild(item);
  });
  filePickerEl.classList.remove('hidden');
  const selEl = filePickerEl.children[filePicker.selected];
  if (selEl && selEl.scrollIntoView) selEl.scrollIntoView({ block: 'nearest' });
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
  } else {
    // Panel closed — stop polling; next open will restart it.
    stopPrPoll();
  }
}

// ===== Spotlight (Cmd+Shift+O file-open, Cmd+Shift+F content-search) =====
//
// Shared UI component lives in renderer/components/spotlight.js. Each
// "mode" is a small config factory that plugs in a data source, a row
// renderer, a preview renderer, and an accept handler. The component
// takes care of all focus / keyboard / debouncing chrome.

let spotlightInstance = null;

function ensureSpotlight() {
  if (!spotlightInstance && typeof Spotlight !== 'undefined') {
    spotlightInstance = Spotlight.create(document.body);
  }
  return spotlightInstance;
}

function appendHighlighted(container, text, positions, className) {
  const segments = fuzzyMatch.highlightSegments(text, positions);
  for (const seg of segments) {
    if (seg.match) {
      const mark = document.createElement('mark');
      mark.textContent = seg.text;
      container.appendChild(mark);
    } else {
      container.appendChild(document.createTextNode(seg.text));
    }
  }
  if (className) container.className = className;
}

function splitRel(rel) {
  const slash = (rel || '').lastIndexOf('/');
  return {
    dir: slash >= 0 ? rel.slice(0, slash) : '',
    name: slash >= 0 ? rel.slice(slash + 1) : (rel || ''),
    baseOffset: slash >= 0 ? slash + 1 : 0,
  };
}

function fileOpenerConfig() {
  return {
    icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
    </svg>`,
    placeholder: 'Open file…',
    debounce: 0,
    emptyText: 'No matching files',
    typeHint: 'Start typing to find a file in the project',
    async search(query) {
      const files = await loadFileListForCurrent();
      // File-opener skips directories — the workspace panel has its own tree.
      const onlyFiles = files.filter((f) => f.type !== 'dir');
      return fuzzyMatch.rankFiles(onlyFiles, query || '', { limit: 60 });
    },
    renderRow(result, container) {
      const { dir, name, baseOffset } = splitRel(result.rel);
      const namePositions = (result._positions || []).filter((p) => p >= baseOffset).map((p) => p - baseOffset);
      const dirPositions = (result._positions || []).filter((p) => p < baseOffset);
      const nameEl = document.createElement('div');
      nameEl.className = 'spotlight-row-name';
      appendHighlighted(nameEl, name, namePositions, 'spotlight-row-name');
      container.appendChild(nameEl);
      if (dir) {
        const dirEl = document.createElement('div');
        appendHighlighted(dirEl, dir, dirPositions, 'spotlight-row-sub');
        container.appendChild(dirEl);
      }
    },
    async renderPreview(result, container) {
      const roots = workspaceRoots();
      const absPath = `${result.root}/${result.rel}`;
      container.innerHTML = '';
      const header = document.createElement('div');
      header.className = 'spotlight-preview-header';
      header.textContent = result.rel;
      container.appendChild(header);
      let res;
      try { res = await window.files.readFile(roots, absPath); } catch (e) {
        const err = document.createElement('div');
        err.className = 'spotlight-preview-error';
        err.textContent = `Cannot read: ${e.message || e}`;
        container.appendChild(err);
        return;
      }
      if (res && res.tooLarge) {
        const note = document.createElement('div');
        note.className = 'spotlight-preview-error';
        note.textContent = `File is too large to preview (${Math.round(res.size / 1024)} kB).`;
        container.appendChild(note);
        return;
      }
      const text = (res && res.content) || '';
      const lines = text.split('\n').slice(0, 200);
      const pre = document.createElement('pre');
      pre.className = 'spotlight-preview-code';
      for (let i = 0; i < lines.length; i++) {
        const line = document.createElement('div');
        line.className = 'line';
        const num = document.createElement('span');
        num.className = 'line-no';
        num.textContent = String(i + 1);
        const body = document.createElement('span');
        body.className = 'line-text';
        body.textContent = lines[i];
        line.appendChild(num);
        line.appendChild(body);
        pre.appendChild(line);
      }
      container.appendChild(pre);
    },
    onAccept(result) {
      const absPath = `${result.root}/${result.rel}`;
      try { openFileInModal(absPath); } catch (e) {}
    },
  };
}

function contentSearchConfig() {
  return {
    icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="11" cy="11" r="7"/>
      <path d="M21 21l-4.3-4.3"/>
    </svg>`,
    placeholder: 'Search in files…',
    debounce: 180,
    emptyText: 'No matches in project files',
    typeHint: 'Type a word or phrase to search across the project',
    async search(query) {
      const q = (query || '').trim();
      if (q.length < 2) return [];
      const roots = workspaceRoots();
      if (!roots.length) return [];
      const res = await window.files.searchContent(roots, q);
      return (res && Array.isArray(res.results)) ? res.results : [];
    },
    renderRow(result, container, query) {
      const { dir, name } = splitRel(result.rel);
      const nameEl = document.createElement('div');
      nameEl.className = 'spotlight-row-name';
      nameEl.textContent = `${name}:${result.line}`;
      container.appendChild(nameEl);
      if (dir) {
        const dirEl = document.createElement('div');
        dirEl.className = 'spotlight-row-sub';
        dirEl.textContent = dir;
        container.appendChild(dirEl);
      }
      // Inline snippet of the matched line with the query highlighted
      const snippet = document.createElement('div');
      snippet.className = 'spotlight-row-snippet';
      const q = (query || '').toLowerCase();
      const text = result.text || '';
      const lower = text.toLowerCase();
      const idx = q ? lower.indexOf(q) : -1;
      if (idx === -1 || !q) {
        snippet.textContent = text;
      } else {
        snippet.appendChild(document.createTextNode(text.slice(Math.max(0, idx - 16), idx)));
        const mark = document.createElement('mark');
        mark.textContent = text.slice(idx, idx + q.length);
        snippet.appendChild(mark);
        snippet.appendChild(document.createTextNode(text.slice(idx + q.length, idx + q.length + 80)));
      }
      container.appendChild(snippet);
    },
    renderPreview(result, container, query) {
      container.innerHTML = '';
      const header = document.createElement('div');
      header.className = 'spotlight-preview-header';
      header.textContent = `${result.rel}:${result.line}`;
      container.appendChild(header);
      const pre = document.createElement('pre');
      pre.className = 'spotlight-preview-code';
      const startLine = result.ctxStart || 1;
      const matchLine = result.line;
      const q = (query || '').toLowerCase();
      (result.ctxLines || []).forEach((lineText, i) => {
        const absLine = startLine + i;
        const row = document.createElement('div');
        row.className = 'line' + (absLine === matchLine ? ' match' : '');
        const num = document.createElement('span');
        num.className = 'line-no';
        num.textContent = String(absLine);
        const body = document.createElement('span');
        body.className = 'line-text';
        if (absLine === matchLine && q) {
          const lower = lineText.toLowerCase();
          let cursor = 0;
          let hit = lower.indexOf(q, cursor);
          while (hit !== -1) {
            if (hit > cursor) body.appendChild(document.createTextNode(lineText.slice(cursor, hit)));
            const mark = document.createElement('mark');
            mark.textContent = lineText.slice(hit, hit + q.length);
            body.appendChild(mark);
            cursor = hit + q.length;
            hit = lower.indexOf(q, cursor);
          }
          if (cursor < lineText.length) body.appendChild(document.createTextNode(lineText.slice(cursor)));
        } else {
          body.textContent = lineText;
        }
        row.appendChild(num);
        row.appendChild(body);
        pre.appendChild(row);
      });
      container.appendChild(pre);
    },
    onAccept(result) {
      const absPath = `${result.root}/${result.rel}`;
      try { openFileInModal(absPath); } catch (e) {}
    },
  };
}

function openSpotlightFileOpener() {
  const s = ensureSpotlight();
  if (!s) return;
  s.open(fileOpenerConfig());
}

function openSpotlightContentSearch() {
  const s = ensureSpotlight();
  if (!s) return;
  s.open(contentSearchConfig());
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
const fileModalIdeBtn = document.getElementById('file-modal-ide-btn');
const fileModalIdeLabel = document.getElementById('file-modal-ide-label');
const fileModalIdeMenu = document.getElementById('file-modal-ide-menu');

// Track the path currently in the modal so the IDE button knows what to open.
let fileModalPath = null;
let cachedIdeList = null;

function closeFileModal() {
  fileModalOverlay.classList.add('hidden');
  fileModalBodyEl.innerHTML = '';
  if (fileModalIdeMenu) fileModalIdeMenu.classList.add('hidden');
  fileModalPath = null;
}

async function ensureIdeList() {
  if (cachedIdeList) return cachedIdeList;
  try { cachedIdeList = await window.ide.list(); }
  catch (e) { cachedIdeList = []; }
  return cachedIdeList;
}

function updateIdeBtnLabel() {
  if (!fileModalIdeLabel) return;
  const preferred = state.preferredIde;
  if (!preferred) { fileModalIdeLabel.textContent = 'Open in…'; return; }
  const match = (cachedIdeList || []).find((i) => i.id === preferred);
  fileModalIdeLabel.textContent = match ? `Open in ${match.label}` : 'Open in…';
}

async function renderIdeMenu() {
  if (!fileModalIdeMenu) return;
  const ides = await ensureIdeList();
  fileModalIdeMenu.innerHTML = '';
  for (const ide of ides) {
    const opt = document.createElement('button');
    opt.type = 'button';
    opt.className = 'file-modal-ide-option' + (state.preferredIde === ide.id ? ' preferred' : '');
    opt.textContent = ide.label;
    opt.addEventListener('click', () => {
      state.preferredIde = ide.id;
      saveState();
      updateIdeBtnLabel();
      fileModalIdeMenu.classList.add('hidden');
      launchPreferredIde();
    });
    fileModalIdeMenu.appendChild(opt);
  }
}

async function launchPreferredIde() {
  if (!fileModalPath) return;
  const id = state.preferredIde;
  if (!id) { toggleIdeMenu(true); return; }
  try {
    const res = await window.ide.open(id, fileModalPath);
    if (res && !res.ok) showIdeError(res.error || 'Failed to launch');
  } catch (e) { showIdeError(e && e.message || String(e)); }
}

function showIdeError(message) {
  const existing = document.querySelector('.file-modal-ide-error');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.className = 'file-modal-ide-error';
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => { el.remove(); }, 4200);
}

function toggleIdeMenu(force) {
  if (!fileModalIdeMenu) return;
  const willShow = force !== undefined ? force : fileModalIdeMenu.classList.contains('hidden');
  if (willShow) {
    renderIdeMenu();
    fileModalIdeMenu.classList.remove('hidden');
  } else {
    fileModalIdeMenu.classList.add('hidden');
  }
}

async function openFileInModal(filePath) {
  if (!filePath) return;
  fileModalPath = filePath;
  const roots = workspaceRoots();
  fileModalNameEl.textContent = basename(filePath);
  fileModalSubtitleEl.textContent = ' · ' + (relativeToRoot(filePath, roots) || filePath);
  fileModalBodyEl.innerHTML = '<div class="ws-pane-loading">Loading…</div>';
  fileModalOverlay.classList.remove('hidden');
  ensureIdeList().then(updateIdeBtnLabel);

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
if (fileModalIdeBtn) {
  fileModalIdeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    // Split interaction: if there's a preferred IDE, primary click launches it.
    // The dropdown chevron (any part of the button with a modifier) opens the menu.
    // We keep it simple here: click always opens the menu on first use, and
    // once a preference exists clicking launches directly; hold Alt to re-open the menu.
    if (state.preferredIde && !e.altKey) {
      launchPreferredIde();
    } else {
      toggleIdeMenu();
    }
  });
}
document.addEventListener('click', (e) => {
  if (!fileModalIdeMenu || fileModalIdeMenu.classList.contains('hidden')) return;
  if (fileModalIdeBtn && fileModalIdeBtn.contains(e.target)) return;
  if (fileModalIdeMenu.contains(e.target)) return;
  fileModalIdeMenu.classList.add('hidden');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && fileModalOverlay && !fileModalOverlay.classList.contains('hidden')) {
    if (fileModalIdeMenu && !fileModalIdeMenu.classList.contains('hidden')) {
      fileModalIdeMenu.classList.add('hidden');
      return;
    }
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
  if (!opts.silent) markFilesActivity();

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

// The API-reported model (conv.contextModel) strips the `[1m]` suffix, so
// it alone under-counts 1M-context chats. Prefer the larger of the selected
// id and the reported id, and grow to 1M if we already observe more tokens
// than the estimate allows.
function effectiveContextWindow(conv) {
  const fromSelected = contextWindowFor(conv && conv.model);
  const fromReported = contextWindowFor(conv && conv.contextModel);
  let max = Math.max(fromSelected, fromReported);
  if (conv && conv.contextTokens && conv.contextTokens > max) {
    max = 1_000_000;
  }
  return max;
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
  const max = effectiveContextWindow(conv);
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
  updateToolCallInToolsView(conv.id, data);
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
  appendToolCallToToolsView(conv, entry);
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

// ===== Tools view (right panel) =====

let currentWorkspaceView = 'workspace';
let toolsFilter = 'all';

const TOOLS_FILTER_DEFS = [
  { id: 'all',     label: 'All' },
  { id: 'errors',  label: 'Errors' },
  { id: 'running', label: 'Running' },
  { id: 'bash',    label: 'Bash' },
  { id: 'write',   label: 'Edits' },
  { id: 'read',    label: 'Reads' },
  { id: 'search',  label: 'Search' },
  { id: 'task',    label: 'Agents' },
  { id: 'todo',    label: 'Todo' },
  { id: 'web',     label: 'Web' },
];

function matchesToolsFilter(entry, filter) {
  if (!filter || filter === 'all') return true;
  if (filter === 'errors') return entry.status === 'error';
  if (filter === 'running') return entry.status === 'running';
  return toolFamily(entry.name) === filter;
}

function computeToolsCounts(entries) {
  const counts = { all: entries.length, errors: 0, running: 0 };
  for (const e of entries) {
    if (e.status === 'error') counts.errors++;
    if (e.status === 'running') counts.running++;
    const fam = toolFamily(e.name);
    counts[fam] = (counts[fam] || 0) + 1;
  }
  return counts;
}

function renderToolsFilterChips(entries) {
  if (!wsToolsFiltersEl) return;
  const counts = computeToolsCounts(entries);
  wsToolsFiltersEl.innerHTML = '';
  if (!entries.length) return;
  // If the active filter now has zero entries, fall back to 'all'
  if (toolsFilter !== 'all' && !counts[toolsFilter]) toolsFilter = 'all';
  for (const def of TOOLS_FILTER_DEFS) {
    const n = counts[def.id] || 0;
    if (def.id !== 'all' && n === 0) continue;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'ws-tools-chip' + (toolsFilter === def.id ? ' active' : '');
    chip.dataset.filter = def.id;
    const label = document.createElement('span');
    label.textContent = def.label;
    const count = document.createElement('span');
    count.className = 'ws-tools-chip-count';
    count.textContent = String(n);
    chip.appendChild(label);
    chip.appendChild(count);
    chip.addEventListener('click', () => {
      if (toolsFilter === def.id) return;
      toolsFilter = def.id;
      renderToolsView();
    });
    wsToolsFiltersEl.appendChild(chip);
  }
}

function jumpToToolCallMessage(toolCallId) {
  if (!toolCallId) return;
  const target = messagesEl.querySelector(`.tool-call[data-id="${cssEscape(toolCallId)}"]`);
  if (!target) return;
  // Make sure any ancestor tool-calls-block is expanded and the entry itself
  const block = target.closest('.tool-calls-block');
  if (block) block.classList.add('expanded');
  target.classList.add('expanded');
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.remove('tc-jump-highlight');
  // Force reflow so animation restarts on repeated jumps
  void target.offsetWidth;
  target.classList.add('tc-jump-highlight');
  setTimeout(() => target.classList.remove('tc-jump-highlight'), 1500);
}

function createPanelToolCallEntry(entry) {
  const el = createToolCallEntry(entry);
  const header = el.querySelector('.tool-call-header');
  if (header) {
    const jumpBtn = document.createElement('button');
    jumpBtn.type = 'button';
    jumpBtn.className = 'tc-jump-btn';
    jumpBtn.title = 'Jump to message';
    jumpBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <line x1="7" y1="17" x2="17" y2="7"/>
      <polyline points="7 7 17 7 17 17"/>
    </svg>`;
    jumpBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      jumpToToolCallMessage(entry.id);
    });
    const chevron = header.querySelector('.tool-call-chevron');
    if (chevron) header.insertBefore(jumpBtn, chevron);
    else header.appendChild(jumpBtn);
  }
  return el;
}

function switchWorkspaceView(name) {
  if (name !== 'workspace' && name !== 'tools') return;
  currentWorkspaceView = name;
  document.querySelectorAll('.ws-view-tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.view === name);
  });
  document.querySelectorAll('#workspace-panel .ws-view').forEach((v) => {
    v.classList.toggle('active', v.dataset.view === name);
  });
  if (name === 'workspace') setFilesActivityDot(false);
  if (name === 'tools') renderToolsView();
}

function setFilesActivityDot(on) {
  if (!wsFilesDotEl) return;
  wsFilesDotEl.hidden = !on;
}

function markFilesActivity() {
  if (currentWorkspaceView !== 'workspace') setFilesActivityDot(true);
}

function collectConversationToolCalls(conv) {
  const out = [];
  if (!conv) return out;
  for (const msg of (conv.messages || [])) {
    if (Array.isArray(msg.toolCalls)) out.push(...msg.toolCalls);
  }
  if (Array.isArray(conv.streamToolCalls)) out.push(...conv.streamToolCalls);
  return out;
}

function updateToolsCountBadge(conv) {
  if (!wsToolsCountEl) return;
  const count = collectConversationToolCalls(conv).length;
  if (count > 0) {
    wsToolsCountEl.textContent = count > 99 ? '99+' : String(count);
    wsToolsCountEl.hidden = false;
  } else {
    wsToolsCountEl.textContent = '';
    wsToolsCountEl.hidden = true;
  }
}

function renderToolsView() {
  if (!wsToolsListEl) return;
  const conv = getCurrentConversation();
  const entries = collectConversationToolCalls(conv);
  updateToolsCountBadge(conv);
  renderToolsFilterChips(entries);
  wsToolsListEl.innerHTML = '';
  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'ws-tools-empty';
    empty.textContent = conv
      ? 'No tools have run in this chat yet.'
      : 'Start a chat to see tool activity here.';
    wsToolsListEl.appendChild(empty);
    return;
  }
  const filtered = entries.filter((e) => matchesToolsFilter(e, toolsFilter));
  if (!filtered.length) {
    const empty = document.createElement('div');
    empty.className = 'ws-tools-empty';
    empty.textContent = 'No tool calls match this filter.';
    wsToolsListEl.appendChild(empty);
    return;
  }
  for (const entry of filtered) {
    wsToolsListEl.appendChild(createPanelToolCallEntry(entry));
  }
  wsToolsListEl.scrollTop = wsToolsListEl.scrollHeight;
}

function appendToolCallToToolsView(conv, entry) {
  if (!wsToolsListEl) return;
  updateToolsCountBadge(conv);
  if (!isCurrentConv(conv.id)) return;
  renderToolsFilterChips(collectConversationToolCalls(conv));
  if (!matchesToolsFilter(entry, toolsFilter)) return;
  const empty = wsToolsListEl.querySelector('.ws-tools-empty');
  if (empty) empty.remove();
  wsToolsListEl.appendChild(createPanelToolCallEntry(entry));
  wsToolsListEl.scrollTop = wsToolsListEl.scrollHeight;
}

function updateToolCallInToolsView(convId, data) {
  if (!wsToolsListEl) return;
  const conv = getConversation(convId);
  updateToolsCountBadge(conv);
  if (!isCurrentConv(convId)) return;
  // Status-based filters can re-partition the list on result; simpler to re-render.
  if (toolsFilter === 'running' || toolsFilter === 'errors') {
    renderToolsView();
    return;
  }
  renderToolsFilterChips(collectConversationToolCalls(conv));
  const el = wsToolsListEl.querySelector(`.tool-call[data-id="${cssEscape(data.id)}"]`);
  if (!el) return;
  const tc = (conv?.streamToolCalls || []).find((c) => c.id === data.id);
  if (tc) updateToolCallEntry(el, tc);
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

// ===== Terminal (multi-tab) =====
// A conversation owns an array of terminal tabs stored on the conversation
// object (`conv.terminalTabs`, `conv.activeTerminalTabId`). Each tab has a
// unique `termId`; the renderer keeps an xterm/fit/host element per termId
// in `xtermByTerm`. The main process keys its PTY map on the same termId.
const xtermByTerm = new Map(); // termId -> { term, fit, element, started, exited }
let currentMountedTermId = null;
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

function ensureTerminalTabs(conv) {
  if (!conv) return;
  if (!Array.isArray(conv.terminalTabs)) conv.terminalTabs = [];
  if (conv.terminalTabs.length && !terminalTabs.findTab(conv.terminalTabs, conv.activeTerminalTabId)) {
    conv.activeTerminalTabId = conv.terminalTabs[0].id;
  }
}

function getActiveTab(conv) {
  if (!conv || !Array.isArray(conv.terminalTabs)) return null;
  return terminalTabs.findTab(conv.terminalTabs, conv.activeTerminalTabId);
}

function ensureXtermForTab(convId, tab) {
  let entry = xtermByTerm.get(tab.id);
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
  term.onData((data) => window.terminal.input(tab.id, data));

  const element = document.createElement('div');
  element.className = 'xterm-host';
  element.style.width = '100%';
  element.style.height = '100%';

  entry = { term, fit, element, started: false, exited: false, convId };
  xtermByTerm.set(tab.id, entry);
  return entry;
}

function mountTerminal() {
  const conv = getCurrentConversation();
  if (!conv) return;
  ensureTerminalTabs(conv);
  // If the chat has no tabs yet, create an initial one.
  if (!conv.terminalTabs.length) {
    createTerminalTab(conv, { mount: false });
  }
  const tab = getActiveTab(conv);
  if (!tab) return;
  const entry = ensureXtermForTab(conv.id, tab);

  while (terminalBody.firstChild) terminalBody.removeChild(terminalBody.firstChild);
  terminalBody.appendChild(entry.element);

  if (!entry.started) {
    entry.term.open(entry.element);
    entry.started = true;
  }
  fitTerminal(entry, tab.id);
  updateTerminalLabel(conv);
  currentMountedTermId = tab.id;

  window.terminal.open({
    termId: tab.id,
    cwd: effectiveProjectPath(conv) || null,
    cols: entry.term.cols,
    rows: entry.term.rows,
  });

  renderTerminalTabs(conv);
  setTimeout(() => entry.term.focus(), 50);
}

function unmountTerminal() {
  while (terminalBody.firstChild) terminalBody.removeChild(terminalBody.firstChild);
  currentMountedTermId = null;
}

function fitTerminal(entry, termId) {
  if (!entry || !entry.started) return;
  try {
    entry.fit.fit();
    const cols = entry.term.cols;
    const rows = entry.term.rows;
    if (termId) window.terminal.resize(termId, cols, rows);
  } catch (e) {}
}

function scheduleTerminalFit() {
  if (terminalResizeRaf) return;
  terminalResizeRaf = requestAnimationFrame(() => {
    terminalResizeRaf = null;
    if (!state.terminalOpen || !currentMountedTermId) return;
    const entry = xtermByTerm.get(currentMountedTermId);
    if (!entry) return;
    fitTerminal(entry, currentMountedTermId);
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

function createTerminalTab(conv, opts = {}) {
  if (!conv) return null;
  ensureTerminalTabs(conv);
  const name = terminalTabs.generateDefaultName(conv.terminalTabs);
  const tab = { id: generateUUID(), name };
  conv.terminalTabs = terminalTabs.addTab(conv.terminalTabs, tab);
  conv.activeTerminalTabId = tab.id;
  saveState();
  if (opts.mount !== false && state.terminalOpen && isCurrentConv(conv.id)) {
    mountTerminal();
  } else if (isCurrentConv(conv.id)) {
    renderTerminalTabs(conv);
  }
  return tab;
}

function switchTerminalTab(conv, termId) {
  if (!conv) return;
  if (conv.activeTerminalTabId === termId) return;
  if (!terminalTabs.findTab(conv.terminalTabs, termId)) return;
  conv.activeTerminalTabId = termId;
  saveState();
  if (state.terminalOpen && isCurrentConv(conv.id)) {
    mountTerminal();
  } else if (isCurrentConv(conv.id)) {
    renderTerminalTabs(conv);
  }
}

function closeTerminalTab(conv, termId) {
  if (!conv) return;
  // Kill the PTY and dispose of the xterm
  try { window.terminal.kill(termId); } catch (e) {}
  const entry = xtermByTerm.get(termId);
  if (entry) {
    try { entry.term.dispose(); } catch (e) {}
    xtermByTerm.delete(termId);
  }
  const { tabs, activeId } = terminalTabs.removeTab(conv.terminalTabs, conv.activeTerminalTabId, termId);
  conv.terminalTabs = tabs;
  conv.activeTerminalTabId = activeId;
  saveState();
  if (!isCurrentConv(conv.id)) return;
  if (!tabs.length) {
    // No tabs left — unmount and auto-close the panel.
    unmountTerminal();
    state.terminalOpen = false;
    applyTerminalVisibility();
    saveState();
    renderTerminalTabs(conv);
    return;
  }
  if (state.terminalOpen) mountTerminal();
  else renderTerminalTabs(conv);
}

function renameTerminalTab(conv, termId, newName) {
  if (!conv) return;
  const before = conv.terminalTabs;
  conv.terminalTabs = terminalTabs.renameTab(conv.terminalTabs, termId, newName);
  if (conv.terminalTabs !== before) saveState();
  if (isCurrentConv(conv.id)) renderTerminalTabs(conv);
}

function cycleTerminalTab(direction) {
  const conv = getCurrentConversation();
  if (!conv || !Array.isArray(conv.terminalTabs) || conv.terminalTabs.length < 2) return;
  const next = terminalTabs.moveActiveIndex(conv.terminalTabs, conv.activeTerminalTabId, direction);
  if (next && next !== conv.activeTerminalTabId) switchTerminalTab(conv, next);
}

function onTerminalData({ termId, data }) {
  const entry = xtermByTerm.get(termId);
  if (entry) entry.term.write(data);
}

function onTerminalExit({ termId, code }) {
  const entry = xtermByTerm.get(termId);
  if (entry) {
    entry.exited = true;
    entry.term.write(`\r\n\x1b[33m[process exited: ${code}]\x1b[0m\r\n`);
  }
  const conv = getCurrentConversation();
  if (conv && terminalTabs.findTab(conv.terminalTabs, termId)) renderTerminalTabs(conv);
}

function killCurrentTerminal() {
  const conv = getCurrentConversation();
  if (!conv) return;
  const tab = getActiveTab(conv);
  if (!tab) return;
  window.terminal.kill(tab.id);
  const entry = xtermByTerm.get(tab.id);
  if (entry) {
    entry.term.write('\r\n\x1b[31m[killed]\x1b[0m\r\n');
    entry.started = true;
  }
}

function startRenameTerminalTab(conv, tab, nameEl) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'terminal-tab-name-input';
  input.value = tab.name;
  input.spellcheck = false;
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  let committed = false;
  const commit = (save) => {
    if (committed) return;
    committed = true;
    if (save) renameTerminalTab(conv, tab.id, input.value);
    else renderTerminalTabs(conv);
  };
  input.onclick = (e) => e.stopPropagation();
  input.ondblclick = (e) => e.stopPropagation();
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
  };
  input.onblur = () => commit(true);
}

function renderTerminalTabs(conv) {
  if (!terminalTabsEl) return;
  terminalTabsEl.innerHTML = '';
  if (!conv || !Array.isArray(conv.terminalTabs)) return;
  for (const tab of conv.terminalTabs) {
    const entry = xtermByTerm.get(tab.id);
    const item = document.createElement('div');
    item.className = 'terminal-tab' +
      (tab.id === conv.activeTerminalTabId ? ' active' : '') +
      (entry && entry.exited ? ' exited' : '');

    const name = document.createElement('span');
    name.className = 'terminal-tab-name';
    name.textContent = tab.name;
    name.ondblclick = (e) => {
      e.stopPropagation();
      startRenameTerminalTab(conv, tab, name);
    };
    item.appendChild(name);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'terminal-tab-close';
    closeBtn.title = 'Close tab';
    closeBtn.innerHTML = `<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>`;
    closeBtn.onclick = (e) => {
      e.stopPropagation();
      closeTerminalTab(conv, tab.id);
    };
    item.appendChild(closeBtn);

    item.onclick = () => switchTerminalTab(conv, tab.id);
    terminalTabsEl.appendChild(item);
  }
}

function killAllTerminalsForConv(conv) {
  if (!conv || !Array.isArray(conv.terminalTabs)) return;
  for (const tab of conv.terminalTabs) {
    try { window.terminal.kill(tab.id); } catch (e) {}
    const entry = xtermByTerm.get(tab.id);
    if (entry) {
      try { entry.term.dispose(); } catch (e) {}
      xtermByTerm.delete(tab.id);
    }
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
// Worktree toggle changes cwd; restart every terminal tab for the chat so
// new tabs pick up the new working directory.
function restartTerminalForConv(convId) {
  const conv = getConversation(convId);
  if (!conv) return;
  killAllTerminalsForConv(conv);
  conv.terminalTabs = [];
  conv.activeTerminalTabId = null;
  saveState();
  if (state.terminalOpen && isCurrentConv(convId)) {
    mountTerminal(); // will create a fresh tab
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
  // CI checks: polled while the detail view is open on a PR.
  checks: null,        // last successful fetch: { ok, checks, summary, fetchedAt }
  checksError: null,   // last error message (if any)
  checksLoading: false,
  pollTimer: null,     // setInterval handle
  pollExpanded: false, // user toggled check list open
};

const PR_POLL_OPTIONS = [
  { value: 0,  label: 'Off' },
  { value: 1,  label: '1m' },
  { value: 2,  label: '2m' },
  { value: 5,  label: '5m' },
  { value: 10, label: '10m' },
];

function prPollIntervalMs() {
  const m = Math.max(0, Number(state.prPollMinutes) || 0);
  if (m <= 0) return 0;
  // Floor at 30s so we can't accidentally slam the CLI.
  return Math.max(30_000, Math.round(m * 60_000));
}

function startPrPoll() {
  stopPrPoll();
  const ms = prPollIntervalMs();
  if (!ms) return;
  prState.pollTimer = setInterval(() => {
    if (prState.view !== 'detail' || !prState.currentPr) { stopPrPoll(); return; }
    fetchPrChecks(prState.currentPr, { quiet: true });
  }, ms);
}

function stopPrPoll() {
  if (prState.pollTimer) {
    clearInterval(prState.pollTimer);
    prState.pollTimer = null;
  }
}

async function fetchPrChecks(pr, opts = {}) {
  const cwd = ghProjectPath();
  if (!cwd || !pr || !pr.number) return;
  if (!opts.quiet) prState.checksLoading = true;
  renderPrChecksBlock();
  let res;
  try { res = await window.gh.prChecks(cwd, pr.number); }
  catch (e) { res = { ok: false, error: String(e && e.message || e) }; }
  // Stale check — user moved on.
  if (!prState.currentPr || prState.currentPr.number !== pr.number) return;
  prState.checksLoading = false;
  if (res && res.ok) {
    prState.checks = res;
    prState.checksError = null;
  } else {
    prState.checksError = (res && res.error) || 'Failed to fetch checks';
  }
  renderPrChecksBlock();
}

function checkStatusDot(bucket) {
  const dot = document.createElement('span');
  dot.className = `pr-check-dot pr-check-${bucket || 'other'}`;
  return dot;
}

function renderPrChecksBlock() {
  const block = document.getElementById('pr-checks-block');
  if (!block) return;
  block.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'pr-checks-header';

  const titleRow = document.createElement('button');
  titleRow.type = 'button';
  titleRow.className = 'pr-checks-title';
  const chev = document.createElement('span');
  chev.className = 'pr-checks-chevron' + (prState.pollExpanded ? ' open' : '');
  chev.innerHTML = `<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
  titleRow.appendChild(chev);
  const label = document.createElement('span');
  label.textContent = 'CI';
  titleRow.appendChild(label);

  const summary = prState.checks && prState.checks.summary;
  const summaryEl = document.createElement('span');
  summaryEl.className = 'pr-checks-summary';
  if (prState.checksLoading && !prState.checks) {
    summaryEl.textContent = 'Loading…';
  } else if (prState.checksError && !prState.checks) {
    summaryEl.className += ' pr-check-fail';
    summaryEl.textContent = 'unavailable';
  } else if (summary && summary.total === 0) {
    summaryEl.textContent = 'no checks';
  } else if (summary) {
    const parts = [];
    if (summary.pass)     parts.push({ cls: 'pr-check-pass',     text: `✓ ${summary.pass}` });
    if (summary.fail)     parts.push({ cls: 'pr-check-fail',     text: `✗ ${summary.fail}` });
    if (summary.pending)  parts.push({ cls: 'pr-check-pending',  text: `● ${summary.pending}` });
    if (summary.skipping) parts.push({ cls: 'pr-check-skipping', text: `↷ ${summary.skipping}` });
    if (summary.cancel)   parts.push({ cls: 'pr-check-cancel',   text: `⨯ ${summary.cancel}` });
    for (const p of parts) {
      const seg = document.createElement('span');
      seg.className = p.cls;
      seg.textContent = p.text;
      summaryEl.appendChild(seg);
    }
  } else {
    summaryEl.textContent = '—';
  }
  titleRow.appendChild(summaryEl);
  titleRow.addEventListener('click', () => {
    prState.pollExpanded = !prState.pollExpanded;
    renderPrChecksBlock();
  });
  header.appendChild(titleRow);

  // Right-side controls: age, refresh button, poll-interval selector
  const controls = document.createElement('div');
  controls.className = 'pr-checks-controls';

  const age = document.createElement('span');
  age.className = 'pr-checks-age';
  age.textContent = prState.checks && prState.checks.fetchedAt
    ? `updated ${formatRelativeAge(prState.checks.fetchedAt)}`
    : '';
  controls.appendChild(age);

  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.className = 'pr-checks-btn';
  refreshBtn.title = 'Refresh now';
  refreshBtn.disabled = !!prState.checksLoading;
  refreshBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="23 4 23 10 17 10"/>
    <polyline points="1 20 1 14 7 14"/>
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
  </svg>`;
  refreshBtn.addEventListener('click', () => {
    if (prState.currentPr) fetchPrChecks(prState.currentPr);
  });
  controls.appendChild(refreshBtn);

  const select = document.createElement('select');
  select.className = 'pr-checks-interval';
  select.title = 'Auto-refresh interval';
  for (const opt of PR_POLL_OPTIONS) {
    const o = document.createElement('option');
    o.value = String(opt.value);
    o.textContent = opt.label;
    if (opt.value === (state.prPollMinutes || 0)) o.selected = true;
    select.appendChild(o);
  }
  select.addEventListener('change', () => {
    const v = Number(select.value);
    state.prPollMinutes = Number.isFinite(v) ? v : 0;
    saveState();
    startPrPoll();
    renderPrChecksBlock();
  });
  controls.appendChild(select);

  header.appendChild(controls);
  block.appendChild(header);

  if (!prState.pollExpanded) return;

  // Expanded list
  const list = document.createElement('div');
  list.className = 'pr-checks-list';
  if (prState.checksError && (!prState.checks || !prState.checks.checks || !prState.checks.checks.length)) {
    const err = document.createElement('div');
    err.className = 'pr-checks-error';
    err.textContent = prState.checksError;
    list.appendChild(err);
  } else if (prState.checks && prState.checks.checks && prState.checks.checks.length) {
    for (const c of prState.checks.checks) {
      const row = document.createElement('div');
      row.className = 'pr-check-row';
      row.appendChild(checkStatusDot(c.bucket));
      const nameEl = document.createElement('span');
      nameEl.className = 'pr-check-name';
      nameEl.textContent = c.name + (c.workflow ? ` · ${c.workflow}` : '');
      row.appendChild(nameEl);
      if (c.description) {
        const desc = document.createElement('span');
        desc.className = 'pr-check-desc';
        desc.textContent = c.description;
        row.appendChild(desc);
      }
      if (c.link) {
        const link = document.createElement('a');
        link.href = c.link;
        link.className = 'pr-check-link';
        link.textContent = 'logs';
        link.addEventListener('click', (e) => {
          e.preventDefault();
          if (window.shellAPI && window.shellAPI.openExternal) window.shellAPI.openExternal(c.link);
        });
        row.appendChild(link);
      }
      list.appendChild(row);
    }
  } else {
    const empty = document.createElement('div');
    empty.className = 'pr-checks-empty';
    empty.textContent = 'No checks on this PR.';
    list.appendChild(empty);
  }
  block.appendChild(list);
}

function formatRelativeAge(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

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
  if (view !== 'detail') {
    stopPrPoll();
    prState.checks = null;
    prState.checksError = null;
    prState.checksLoading = false;
  }
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
  // Reset checks state for the new PR.
  prState.checks = null;
  prState.checksError = null;
  prState.checksLoading = false;
  showPrView('detail');
  prDetailEl.innerHTML = '<div class="pr-state-msg">Loading…</div>';
  const cwd = ghProjectPath();
  const res = await window.gh.prDetail(cwd, pr.number);
  if (!res.ok) {
    prDetailEl.innerHTML = `<div class="pr-state-msg">Error: ${escapeHtml(res.error)}</div>`;
    return;
  }
  renderPrDetail(res.pr, res.reviewComments || [], res.issueComments || [], res.reviews || []);
  // Fire-and-forget first checks fetch; start the polling loop if enabled.
  fetchPrChecks(pr);
  startPrPoll();
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

  // CI checks block — renderPrChecksBlock() paints into this each refresh.
  const checksBlock = document.createElement('div');
  checksBlock.id = 'pr-checks-block';
  checksBlock.className = 'pr-checks-block';
  prDetailEl.appendChild(checksBlock);
  renderPrChecksBlock();

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
  renderToolsView();
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

  // Ask-user dialog
  window.claude.onAskRequest((data) => {
    if (data.convId && data.convId !== state.currentConversationId && getConversation(data.convId)) {
      switchConversation(data.convId);
    }
    showAskDialog(data);
    setStatus('streaming', 'Waiting for your answer...');
  });

  askSubmitBtn.addEventListener('click', () => submitAskAnswer());
  askCancelBtn.addEventListener('click', () => cancelAskAnswer());
  askAnswerInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submitAskAnswer();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelAskAnswer();
    }
  });

  // Input
  inputEl.addEventListener('input', () => {
    autoResize();
    detectFilePickerTrigger();
  });
  inputEl.addEventListener('click', detectFilePickerTrigger);
  inputEl.addEventListener('keyup', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
      detectFilePickerTrigger();
    }
  });
  inputEl.addEventListener('blur', () => {
    // Delay so mousedown on a picker item can fire first
    setTimeout(() => closeFilePicker(), 120);
  });
  inputEl.addEventListener('keydown', (e) => {
    if (filePicker.open) {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveFilePickerSelection(1); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); moveFilePickerSelection(-1); return; }
      if (e.key === 'Enter' || e.key === 'Tab') {
        if (acceptFilePickerSelection()) { e.preventDefault(); return; }
      }
      if (e.key === 'Escape') { e.preventDefault(); closeFilePicker(); return; }
    }
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

  // Workspace view tabs (Files / Tools)
  document.querySelectorAll('.ws-view-tab').forEach((tab) => {
    tab.addEventListener('click', () => switchWorkspaceView(tab.dataset.view));
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
    if (state.terminalOpen && isCurrentConv(conv.id)) updateTerminalLabel(conv);
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
  if (terminalNewTabBtn) {
    terminalNewTabBtn.addEventListener('click', () => {
      let conv = getCurrentConversation();
      if (!conv) conv = createConversation('New Chat');
      if (!state.terminalOpen) {
        state.terminalOpen = true;
        applyTerminalVisibility();
        applyTerminalHeight();
      }
      createTerminalTab(conv);
    });
  }

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
    // Ctrl/Cmd + Shift + O: Spotlight file opener
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'O' || e.key === 'o')) {
      e.preventDefault();
      openSpotlightFileOpener();
    }
    // Ctrl/Cmd + Shift + F: Spotlight content search
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'F' || e.key === 'f')) {
      e.preventDefault();
      openSpotlightContentSearch();
    }
  });

  // Initial status
  setStatus('ready', 'Ready');
  inputEl.focus();
}

init();
