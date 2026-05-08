// Auto-mode panel.
//
// Renders the polled queue of actionable GitHub items (issues assigned to me,
// unanswered PR comments, PR review requests) plus any saved drafts. Drafting
// content runs an off-screen Claude one-shot in the renderer; the result is
// stored via IPC and only posts to GitHub when the user clicks Send.
//
// Lives in its own classic <script>; shares script-scope with app.js so it
// can read shared state (MODELS, EFFORTS, state, escapeHtml, etc.) and app.js
// can call its entry points (`wireAutoPanelEvents`, `refreshAutoPanel`).
// Load order in index.html: auto-panel.js BEFORE app.js. Reference resolution
// happens at call time, not parse time, so the consts in app.js are visible
// once init() runs.

const autoUI = {
  enabled: false,
  config: null,
  items: { issues: [], commentThreads: [], reviewRequests: [] },
  drafts: [],
  login: null,
  lastPollAt: 0,
  drafting: new Set(), // dedup keys for in-flight drafting work
  // Per-section collapsed state. Drafts default-collapsed since they're
  // less actionable than the queue itself; queue sections default-open.
  collapsedSections: { issues: false, comments: false, reviews: false, drafts: true },
};

const autoEnabledEl = document.getElementById('auto-enabled');
const autoStreamTogglesEl = document.getElementById('auto-stream-toggles');
const autoMetaEl = document.getElementById('auto-meta');
const autoQueueEl = document.getElementById('auto-queue');
const autoDraftsListEl = document.getElementById('auto-drafts-list');
const autoTabBadgeEl = document.getElementById('auto-tab-badge');
const autoPollNowBtn = document.getElementById('auto-poll-now');
const autoSettingsToggleBtn = document.getElementById('auto-settings-toggle');
const autoSettingsEl = document.getElementById('auto-settings');
const autoModelSelectEl = document.getElementById('auto-model');
const autoEffortSelectEl = document.getElementById('auto-effort');
const autoIntervalSelectEl = document.getElementById('auto-interval');

async function refreshAutoPanel() {
  if (!window.auto) return;
  try {
    const status = await window.auto.status();
    autoUI.config = status.config;
    autoUI.items = status.items || { issues: [], commentThreads: [], reviewRequests: [] };
    autoUI.drafts = status.drafts || [];
    autoUI.login = status.login;
    autoUI.lastPollAt = status.lastPollAt;
    renderAutoPanel();
  } catch (e) {}
}

function renderAutoPanel() {
  if (!autoEnabledEl) return;
  autoEnabledEl.checked = !!(autoUI.config && autoUI.config.enabled);
  if (autoStreamTogglesEl && autoUI.config && autoUI.config.streams) {
    for (const cb of autoStreamTogglesEl.querySelectorAll('input[data-stream]')) {
      cb.checked = !!autoUI.config.streams[cb.dataset.stream];
    }
  }
  if (autoMetaEl) {
    const last = autoUI.lastPollAt ? new Date(autoUI.lastPollAt).toLocaleTimeString() : 'never';
    const who = autoUI.login ? `@${autoUI.login}` : 'not signed in';
    autoMetaEl.textContent = `${who} · last poll ${last}`;
  }
  renderAutoSettings();
  renderAutoQueue();
  renderAutoDrafts();
  updateAutoBadge();
}

function renderAutoSettings() {
  // Populate the Model dropdown lazily so it always reflects the current
  // MODELS list. Skip section headers; otherwise option `value=""` round-trips
  // as null (empty string is interchangeable with null on the wire).
  if (autoModelSelectEl && autoModelSelectEl.options.length === 0) {
    for (const m of MODELS) {
      if (m.section) continue;
      const opt = document.createElement('option');
      opt.value = m.value == null ? '' : m.value;
      opt.textContent = m.label;
      autoModelSelectEl.appendChild(opt);
    }
  }
  if (autoEffortSelectEl && autoEffortSelectEl.options.length === 0) {
    for (const e of EFFORTS) {
      const opt = document.createElement('option');
      opt.value = e.value == null ? '' : e.value;
      opt.textContent = e.label;
      autoEffortSelectEl.appendChild(opt);
    }
  }
  if (autoModelSelectEl) {
    autoModelSelectEl.value = (autoUI.config && autoUI.config.draftModel) || '';
  }
  if (autoEffortSelectEl) {
    autoEffortSelectEl.value = (autoUI.config && autoUI.config.draftEffort) || '';
  }
  if (autoIntervalSelectEl) {
    const sec = (autoUI.config && Number(autoUI.config.intervalSec)) || 180;
    // Snap to the nearest preset; if no preset matches, the browser keeps the
    // raw value (so a programmatic config change still round-trips).
    autoIntervalSelectEl.value = String(sec);
  }
}

function updateAutoBadge() {
  if (!autoTabBadgeEl) return;
  const total = (autoUI.items.issues || []).length
    + (autoUI.items.commentThreads || []).length
    + (autoUI.items.reviewRequests || []).length
    + (autoUI.drafts || []).length;
  autoTabBadgeEl.textContent = String(total);
  autoTabBadgeEl.classList.toggle('hidden', total === 0);
}

// Build a collapsible section: header (chevron + title + count badge) and a
// body that renders one item per row. The collapsed state is preserved in
// `autoUI.collapsedSections[key]` so re-renders (poll updates, etc.) don't
// force the section back open.
function renderAutoSection({ key, title, items, renderItem, emptyText }) {
  const wrap = document.createElement('div');
  const collapsed = !!autoUI.collapsedSections[key];
  wrap.className = 'auto-section' + (collapsed ? ' collapsed' : '');

  const header = document.createElement('button');
  header.type = 'button';
  header.className = 'auto-section-header';
  header.innerHTML = `
    <svg class="auto-section-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="6 9 12 15 18 9"/>
    </svg>
    <span class="auto-section-title">${escapeHtml(title)}</span>
    <span class="auto-section-count">${items.length}</span>
  `;
  header.addEventListener('click', () => {
    autoUI.collapsedSections[key] = !autoUI.collapsedSections[key];
    wrap.classList.toggle('collapsed');
  });
  wrap.appendChild(header);

  const body = document.createElement('div');
  body.className = 'auto-section-body';
  if (items.length) {
    for (const item of items) body.appendChild(renderItem(item));
  } else if (emptyText) {
    const empty = document.createElement('div');
    empty.className = 'auto-empty';
    empty.textContent = emptyText;
    body.appendChild(empty);
  }
  wrap.appendChild(body);
  return wrap;
}

function renderAutoQueue() {
  if (!autoQueueEl) return;
  autoQueueEl.innerHTML = '';
  const sections = [
    { key: 'issues',   title: 'Issues',   items: autoUI.items.issues || [],          renderItem: renderIssueRow,   emptyText: 'No issues assigned to you.' },
    { key: 'comments', title: 'Comments', items: autoUI.items.commentThreads || [],  renderItem: renderCommentRow, emptyText: 'No unanswered threads.' },
    { key: 'reviews',  title: 'Reviews',  items: autoUI.items.reviewRequests || [],  renderItem: renderReviewRow,  emptyText: 'No PRs awaiting your review.' },
  ];
  // If the panel is fully empty AND auto-mode is off, show the legacy hint
  // instead of three empty sections — less visual noise for first-run state.
  const totalItems = sections.reduce((n, s) => n + s.items.length, 0);
  if (totalItems === 0 && !(autoUI.config && autoUI.config.enabled)) {
    const empty = document.createElement('div');
    empty.className = 'auto-empty';
    empty.textContent = 'Auto-mode is off. Toggle on to start polling.';
    autoQueueEl.appendChild(empty);
    return;
  }
  for (const section of sections) {
    autoQueueEl.appendChild(renderAutoSection(section));
  }
}

function renderIssueRow(issue) {
  const row = document.createElement('div');
  row.className = 'auto-item';
  row.innerHTML = `
    <div class="auto-item-head">
      <a class="auto-item-title" href="${escapeHtml(issue.url || '#')}" data-extlink>${escapeHtml(issue.title || '')}</a>
      <span class="auto-item-meta">${escapeHtml(issue.repo || '')} #${issue.number}</span>
    </div>
    <div class="auto-item-actions">
      <button class="auto-btn primary" data-action="start-issue">Start in worktree</button>
      <button class="auto-btn" data-action="dismiss">Dismiss</button>
    </div>
  `;
  row.querySelector('[data-action="start-issue"]').addEventListener('click', () => startIssueWorkflow(issue));
  row.querySelector('[data-action="dismiss"]').addEventListener('click', async () => {
    await window.auto.dismiss('issue', issue.repo, issue.number);
    refreshAutoPanel();
  });
  row.querySelector('[data-extlink]').addEventListener('click', (e) => {
    e.preventDefault();
    if (window.shellAPI) window.shellAPI.openExternal(issue.url);
  });
  return row;
}

function renderCommentRow(thread) {
  const row = document.createElement('div');
  row.className = 'auto-item';
  const latest = thread.latest || {};
  const user = (latest.user && latest.user.login) || (latest.author && latest.author.login) || 'someone';
  const summary = (latest.body || '').slice(0, 140).replace(/\s+/g, ' ');
  const where = thread.kind === 'review'
    ? `${thread.path || 'inline'}${thread.line ? ':' + thread.line : ''}`
    : 'top-level';
  row.innerHTML = `
    <div class="auto-item-head">
      <a class="auto-item-title" href="${escapeHtml(thread.prUrl || '#')}" data-extlink>${escapeHtml(thread.prTitle || '')}</a>
      <span class="auto-item-meta">${escapeHtml(thread.repo || '')} #${thread.prNumber} · ${escapeHtml(where)}</span>
    </div>
    <div class="auto-item-quote">@${escapeHtml(user)}: ${escapeHtml(summary)}</div>
    <div class="auto-item-actions">
      <button class="auto-btn primary" data-action="draft-reply">Draft reply</button>
      <button class="auto-btn" data-action="dismiss">Dismiss</button>
    </div>
  `;
  row.querySelector('[data-action="draft-reply"]').addEventListener('click', () => draftReplyForThread(thread));
  row.querySelector('[data-action="dismiss"]').addEventListener('click', async () => {
    const kind = thread.kind === 'review' ? 'review-reply' : 'comment';
    const targetId = thread.kind === 'review' ? thread.rootId : thread.prNumber;
    await window.auto.dismiss(kind, thread.repo, targetId);
    refreshAutoPanel();
  });
  row.querySelector('[data-extlink]').addEventListener('click', (e) => {
    e.preventDefault();
    if (window.shellAPI) window.shellAPI.openExternal(thread.prUrl);
  });
  return row;
}

function renderReviewRow(pr) {
  const row = document.createElement('div');
  row.className = 'auto-item';
  row.innerHTML = `
    <div class="auto-item-head">
      <a class="auto-item-title" href="${escapeHtml(pr.url || '#')}" data-extlink>${escapeHtml(pr.title || '')}</a>
      <span class="auto-item-meta">${escapeHtml(pr.repo || '')} #${pr.number}</span>
    </div>
    <div class="auto-item-actions">
      <button class="auto-btn primary" data-action="draft-review">Draft review</button>
      <button class="auto-btn" data-action="dismiss">Dismiss</button>
    </div>
  `;
  row.querySelector('[data-action="draft-review"]').addEventListener('click', () => draftReviewForPR(pr));
  row.querySelector('[data-action="dismiss"]').addEventListener('click', async () => {
    await window.auto.dismiss('review', pr.repo, pr.number);
    refreshAutoPanel();
  });
  row.querySelector('[data-extlink]').addEventListener('click', (e) => {
    e.preventDefault();
    if (window.shellAPI) window.shellAPI.openExternal(pr.url);
  });
  return row;
}

function renderAutoDrafts() {
  if (!autoDraftsListEl) return;
  autoDraftsListEl.innerHTML = '';
  // Render drafts inside a collapsible section just like the queue ones.
  autoDraftsListEl.appendChild(renderAutoSection({
    key: 'drafts',
    title: 'Drafts',
    items: autoUI.drafts || [],
    renderItem: renderDraftRow,
    emptyText: 'No drafts.',
  }));
}

function renderDraftRow(d) {
  const row = document.createElement('div');
  row.className = 'auto-draft';
  const body = (d.data && d.data.body) || '';
  row.innerHTML = `
    <div class="auto-draft-head">
      <span class="auto-draft-kind">${escapeHtml(d.kind)}</span>
      <span class="auto-draft-target">${escapeHtml(d.repo)} · ${escapeHtml(d.targetId)}</span>
    </div>
    <textarea class="auto-draft-body" rows="4">${escapeHtml(body)}</textarea>
    <div class="auto-draft-actions">
      <button class="auto-btn primary" data-action="send">Send</button>
      <button class="auto-btn" data-action="save">Save edits</button>
      <button class="auto-btn danger" data-action="delete">Delete</button>
    </div>
  `;
  const ta = row.querySelector('textarea');
  row.querySelector('[data-action="send"]').addEventListener('click', async () => {
    const res = await window.auto.sendDraft(d.id);
    if (res && res.ok) {
      refreshAutoPanel();
    } else {
      alert(`Send failed: ${res && res.error || 'unknown'}`);
    }
  });
  row.querySelector('[data-action="save"]').addEventListener('click', async () => {
    const next = { ...(d.data || {}), body: ta.value };
    await window.auto.saveDraft(d.kind, d.repo, d.targetId, next);
    refreshAutoPanel();
  });
  row.querySelector('[data-action="delete"]').addEventListener('click', async () => {
    await window.auto.deleteDraft(d.id);
    refreshAutoPanel();
  });
  return row;
}

// ----- Workflows ----------------------------------------------------------

async function startIssueWorkflow(issue) {
  // Capture the currently-active project BEFORE we create the new conv (because
  // creating it switches `currentConversationId` to the empty new conv).
  const sourceProjectPath = effectiveProjectPath(getCurrentConversation());
  if (!sourceProjectPath) {
    alert('Open a project (the local clone of this repo) in any chat before starting auto-issue work.');
    return;
  }

  const conv = createConversation(`#${issue.number} ${issue.title}`);
  const branch = `${autoUI.login || 'me'}/${issue.number}-${autoSlugify(issue.title || 'issue')}`;
  conv.projectPath = sourceProjectPath;

  try {
    const res = await window.worktree.add(sourceProjectPath, conv.id, branch);
    if (res && res.worktreePath) {
      conv.worktreePath = res.worktreePath;
      conv.worktreeBranch = branch;
    }
  } catch (e) {
    console.warn('worktree create failed:', e);
  }

  // Tag the conv so handleStreamEnd knows to open a draft PR when this agent run finishes.
  conv.autoIssue = {
    repo: issue.repo,
    number: issue.number,
    title: issue.title,
    body: issue.body || '',
    url: issue.url || '',
    branch,
    prCreated: false,
  };
  saveState();
  switchConversation(conv.id);

  // Prime the chat with a prompt that asks the agent to commit + push.
  // Phase 2 finisher: when this stream ends successfully, the renderer auto-
  // opens a draft PR and adds it to the CI watch list (Phase 3).
  const prompt = [
    `You're picking up GitHub issue #${issue.number} "${issue.title}" in ${issue.repo}.`,
    `Issue body:`,
    issue.body || '(no body)',
    ``,
    `Please:`,
    `1. Explore the repo to understand the relevant code.`,
    `2. Implement the change. Iterate until you're confident it's correct.`,
    `3. Run the project's tests / typecheck / lint locally and make them pass.`,
    `4. Commit your changes with a message like "Closes #${issue.number}: <short description>".`,
    `5. Push the branch with: git push -u origin ${branch}`,
    ``,
    `When you've pushed, you're done — I'll automatically open a draft PR and watch CI.`,
  ].join('\n');
  inputEl.value = prompt;
  autoResize();
  // Don't auto-send — let the user kick it off so they can edit if needed.
}

// Slug helper local to auto-panel; named distinctly from `slugify` callers
// that may add their own one-letter helper.
function autoSlugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().split(/\s+/).slice(0, 6).join('-');
}

async function draftReplyForThread(thread) {
  const key = `${thread.repo}:${thread.kind}:${thread.kind === 'review' ? thread.rootId : thread.prNumber}`;
  if (autoUI.drafting.has(key)) return;
  autoUI.drafting.add(key);
  try {
    const targetId = thread.kind === 'review' ? thread.rootId : thread.prNumber;
    const kind = thread.kind === 'review' ? 'review-reply' : 'comment';
    // Show a placeholder draft so the user sees something happening
    await window.auto.saveDraft(kind, thread.repo, targetId, {
      body: '(drafting…)',
      prNumber: thread.prNumber,
      inReplyTo: thread.kind === 'review' ? thread.rootId : null,
    });
    await refreshAutoPanel();
    // Spin a one-shot Claude call in a background conversation. Reuse the
    // existing send-prompt machinery: create a hidden conversation, prompt it,
    // collect the result, save as draft body.
    const draftBody = await runOneShotClaude(buildReplyPrompt(thread));
    await window.auto.saveDraft(kind, thread.repo, targetId, {
      body: draftBody,
      prNumber: thread.prNumber,
      inReplyTo: thread.kind === 'review' ? thread.rootId : null,
    });
  } finally {
    autoUI.drafting.delete(key);
    refreshAutoPanel();
  }
}

async function draftReviewForPR(pr) {
  const key = `${pr.repo}:review:${pr.number}`;
  if (autoUI.drafting.has(key)) return;
  autoUI.drafting.add(key);
  try {
    await window.auto.saveDraft('review', pr.repo, pr.number, { body: '(drafting…)', event: 'COMMENT' });
    await refreshAutoPanel();
    const detail = await window.auto.prDetail(pr.repo, pr.number);
    const files = await window.auto.prFiles(pr.repo, pr.number);
    const draftBody = await runOneShotClaude(buildReviewPrompt(pr, detail, files));
    await window.auto.saveDraft('review', pr.repo, pr.number, { body: draftBody, event: 'COMMENT' });
  } finally {
    autoUI.drafting.delete(key);
    refreshAutoPanel();
  }
}

function buildReplyPrompt(thread) {
  const recent = (thread.comments || []).slice(-6).map(c => {
    const u = (c.user && c.user.login) || (c.author && c.author.login) || '?';
    return `@${u}: ${(c.body || '').slice(0, 800)}`;
  }).join('\n---\n');
  return [
    `Draft a reply to the latest message in this PR thread, written as me (first person, no AI attribution, no signoff).`,
    `Thread context (oldest → newest):`,
    recent,
    ``,
    `Reply ONLY with the body of the comment, nothing else.`,
  ].join('\n');
}

function buildReviewPrompt(pr, detail, files) {
  const filesSummary = (files && files.files || []).slice(0, 25).map(f =>
    `${f.filename} (+${f.additions} -${f.deletions})`
  ).join('\n');
  const body = (detail && detail.pr && detail.pr.body) || '';
  return [
    `Draft a code review for PR #${pr.number} "${pr.title}" in ${pr.repo}, written as me.`,
    `PR body:`,
    body.slice(0, 4000),
    ``,
    `Files touched:`,
    filesSummary,
    ``,
    `Reply ONLY with the body of the review comment. Be specific and constructive. No AI attribution, no signoff.`,
  ].join('\n');
}

// Run a single-shot Claude prompt without polluting the visible chat list.
// We reuse the existing send-prompt + stream-end pipeline, scoped to a
// throwaway conv id that the renderer never displays.
function runOneShotClaude(prompt) {
  return new Promise((resolve) => {
    const convId = `auto-oneshot-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
    let buffered = '';
    const onDelta = (data) => {
      if (data.convId !== convId) return;
      buffered += data.text || '';
    };
    const onEnd = (data) => {
      if (data.convId !== convId) return;
      cleanup();
      resolve((data.result || buffered || '').trim());
    };
    const onError = (data) => {
      if (data.convId !== convId) return;
      cleanup();
      resolve(buffered.trim() || '(draft failed — please type a reply)');
    };
    function cleanup() {
      // The IPC API doesn't have per-id off, so we use a guard inside the listeners.
      cleanedUp = true;
    }
    let cleanedUp = false;
    window.claude.onStreamDelta((data) => { if (!cleanedUp) onDelta(data); });
    window.claude.onStreamEnd((data) => { if (!cleanedUp) onEnd(data); });
    window.claude.onStreamError((data) => { if (!cleanedUp) onError(data); });

    const sessionId = generateUUID();
    window.claude.sendPrompt(
      convId, prompt, sessionId, true,
      true, // yolo — we don't want permission prompts for one-shot drafting
      null, // projectPath (none — pure text generation)
      (autoUI.config && autoUI.config.draftModel) || null,
      [],
      (autoUI.config && autoUI.config.draftEffort) || null,
    );
    // Safety timeout — never hang the UI
    setTimeout(() => { if (!cleanedUp) { cleanup(); resolve('(timed out drafting)'); } }, 120_000);
  });
}

// ----- Wire-up ------------------------------------------------------------

function wireAutoPanelEvents() {
  if (!autoEnabledEl) return;
  autoEnabledEl.addEventListener('change', async () => {
    const next = { ...(autoUI.config || {}), enabled: autoEnabledEl.checked };
    await window.auto.setConfig(next);
    autoUI.config = next;
    if (autoEnabledEl.checked) await window.auto.pollNow();
    refreshAutoPanel();
  });
  if (autoStreamTogglesEl) {
    autoStreamTogglesEl.addEventListener('change', async (e) => {
      const target = e.target;
      if (!target || !target.dataset || !target.dataset.stream) return;
      const next = {
        ...(autoUI.config || {}),
        streams: {
          ...((autoUI.config && autoUI.config.streams) || {}),
          [target.dataset.stream]: target.checked,
        },
      };
      await window.auto.setConfig(next);
      autoUI.config = next;
      refreshAutoPanel();
    });
  }
  if (autoPollNowBtn) {
    autoPollNowBtn.addEventListener('click', async () => {
      autoPollNowBtn.classList.add('spinning');
      try {
        await window.auto.pollNow();
        await refreshAutoPanel();
      } finally {
        autoPollNowBtn.classList.remove('spinning');
      }
    });
  }
  if (autoSettingsToggleBtn && autoSettingsEl) {
    autoSettingsToggleBtn.addEventListener('click', () => {
      autoSettingsEl.classList.toggle('hidden');
      autoSettingsToggleBtn.classList.toggle('open', !autoSettingsEl.classList.contains('hidden'));
    });
  }
  // Settings → config changes; use change events so we don't fire-on-every-keystroke
  async function pushSettingDelta(delta) {
    const next = { ...(autoUI.config || {}), ...delta };
    await window.auto.setConfig(next);
    autoUI.config = next;
    renderAutoPanel();
  }
  if (autoModelSelectEl) {
    autoModelSelectEl.addEventListener('change', () => {
      pushSettingDelta({ draftModel: autoModelSelectEl.value || null });
    });
  }
  if (autoEffortSelectEl) {
    autoEffortSelectEl.addEventListener('change', () => {
      pushSettingDelta({ draftEffort: autoEffortSelectEl.value || null });
    });
  }
  if (autoIntervalSelectEl) {
    autoIntervalSelectEl.addEventListener('change', () => {
      const sec = Number(autoIntervalSelectEl.value) || 180;
      pushSettingDelta({ intervalSec: sec });
    });
  }
  if (window.auto && window.auto.onItemsUpdated) {
    window.auto.onItemsUpdated(({ items, lastPollAt, login }) => {
      autoUI.items = items;
      autoUI.lastPollAt = lastPollAt;
      if (login) autoUI.login = login;
      renderAutoPanel();
    });
  }
  if (window.auto && window.auto.onPRReady) {
    window.auto.onPRReady(({ repo, number, reviewers }) => {
      const url = `https://github.com/${repo}/pull/${number}`;
      const reviewerStr = (reviewers && reviewers.length)
        ? ` · requested ${reviewers.map(r => '@' + r).join(', ')}`
        : '';
      // Desktop notification (only if window not focused — same rule as chat-finished notifs).
      if (typeof Notification !== 'undefined' &&
          (typeof document.hasFocus !== 'function' || !document.hasFocus())) {
        try {
          const n = new Notification(`PR ready for review`, {
            body: `${repo}#${number}${reviewerStr}`,
            tag: `auto-pr-ready:${repo}#${number}`,
            silent: false,
          });
          n.onclick = () => {
            try { window.claude.focusWindow(); } catch (e) {}
            if (window.shellAPI) window.shellAPI.openExternal(url);
            n.close();
          };
        } catch (e) {}
      }
      // Always refresh the panel and surface a small inline banner for the
      // currently-visible chat (handy when the user IS at their desk).
      refreshAutoPanel();
      const banner = document.createElement('div');
      banner.className = 'compact-banner';
      banner.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
        </svg>
        <span>PR ready: <a href="#" data-pr-url>${escapeHtml(repo)}#${number}</a>${escapeHtml(reviewerStr)}</span>
      `;
      const link = banner.querySelector('[data-pr-url]');
      link.addEventListener('click', (e) => {
        e.preventDefault();
        if (window.shellAPI) window.shellAPI.openExternal(url);
      });
      messagesEl.appendChild(banner);
      scrollToBottom();
    });
  }
}
