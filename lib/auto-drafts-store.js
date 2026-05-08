// SQLite-backed store for auto-mode artefacts that survive restarts.
//
// Two tables:
//   auto_drafts — comment / review / review-comment drafts awaiting send
//   auto_dismissed — items the user explicitly hid from the queue
//
// Drafts are keyed by (kind, repo, target_id) so re-drafting the same item
// upserts rather than piling up.

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS auto_drafts (
      id          TEXT PRIMARY KEY,
      kind        TEXT NOT NULL,        -- 'comment' | 'review-reply' | 'review'
      repo        TEXT NOT NULL,        -- 'owner/name'
      target_id   TEXT NOT NULL,        -- PR number, comment id, etc.
      data        TEXT NOT NULL,        -- JSON blob (body, in_reply_to, etc.)
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_auto_drafts_key
      ON auto_drafts(kind, repo, target_id);
    CREATE INDEX IF NOT EXISTS idx_auto_drafts_updated
      ON auto_drafts(updated_at DESC);

    CREATE TABLE IF NOT EXISTS auto_dismissed (
      key         TEXT PRIMARY KEY,     -- '<kind>:<repo>:<id>'
      dismissed_at INTEGER NOT NULL
    );

    -- PRs the loop opened that we should watch CI on. When checks go green
    -- we pick reviewers and flip them ready-for-review. status moves through:
    --   'watching' → 'ready' (final) | 'failed' (final) | 'abandoned' (manual)
    CREATE TABLE IF NOT EXISTS auto_watched_prs (
      id           TEXT PRIMARY KEY,    -- '<repo>#<number>'
      repo         TEXT NOT NULL,
      number       INTEGER NOT NULL,
      branch       TEXT NOT NULL,
      issue_number INTEGER,
      project_path TEXT,
      status       TEXT NOT NULL,
      last_checked_at INTEGER,
      created_at   INTEGER NOT NULL,
      data         TEXT NOT NULL        -- JSON: title, body, etc.
    );
    CREATE INDEX IF NOT EXISTS idx_auto_watched_status
      ON auto_watched_prs(status);
  `);
}

function draftKey(kind, repo, targetId) {
  return `${kind}:${repo}:${targetId}`;
}

function upsertDraft(db, { kind, repo, targetId, data }) {
  ensureSchema(db);
  if (!kind || !repo || targetId == null) throw new Error('upsertDraft: kind, repo, targetId required');
  const id = draftKey(kind, repo, targetId);
  const now = Date.now();
  db.prepare(
    'INSERT INTO auto_drafts (id, kind, repo, target_id, data, created_at, updated_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?) ' +
    'ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at'
  ).run(id, kind, repo, String(targetId), JSON.stringify(data || {}), now, now);
  return id;
}

function listDrafts(db) {
  ensureSchema(db);
  const rows = db
    .prepare('SELECT id, kind, repo, target_id, data, created_at, updated_at FROM auto_drafts ORDER BY updated_at DESC')
    .all();
  return rows.map(r => ({
    id: r.id,
    kind: r.kind,
    repo: r.repo,
    targetId: r.target_id,
    data: safeParse(r.data),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

function getDraft(db, id) {
  ensureSchema(db);
  const row = db.prepare('SELECT * FROM auto_drafts WHERE id = ?').get(id);
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    repo: row.repo,
    targetId: row.target_id,
    data: safeParse(row.data),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function deleteDraft(db, id) {
  ensureSchema(db);
  db.prepare('DELETE FROM auto_drafts WHERE id = ?').run(id);
}

function dismiss(db, kind, repo, targetId) {
  ensureSchema(db);
  const key = draftKey(kind, repo, targetId);
  db.prepare(
    'INSERT INTO auto_dismissed (key, dismissed_at) VALUES (?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET dismissed_at = excluded.dismissed_at'
  ).run(key, Date.now());
}

function isDismissed(db, kind, repo, targetId) {
  ensureSchema(db);
  const row = db
    .prepare('SELECT 1 FROM auto_dismissed WHERE key = ?')
    .get(draftKey(kind, repo, targetId));
  return !!row;
}

function clearDismiss(db, kind, repo, targetId) {
  ensureSchema(db);
  db.prepare('DELETE FROM auto_dismissed WHERE key = ?').run(draftKey(kind, repo, targetId));
}

function safeParse(text) {
  try { return JSON.parse(text); } catch (e) { return {}; }
}

// ---- Watched PRs ----------------------------------------------------------

function watchedPRId(repo, number) {
  return `${repo}#${number}`;
}

function addWatchedPR(db, { repo, number, branch, issueNumber = null, projectPath = null, data = {} }) {
  ensureSchema(db);
  if (!repo || !number || !branch) throw new Error('addWatchedPR: repo/number/branch required');
  const id = watchedPRId(repo, number);
  const now = Date.now();
  db.prepare(
    'INSERT INTO auto_watched_prs (id, repo, number, branch, issue_number, project_path, status, last_checked_at, created_at, data) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
    'ON CONFLICT(id) DO UPDATE SET ' +
    '  branch = excluded.branch, issue_number = excluded.issue_number, ' +
    '  project_path = excluded.project_path, status = excluded.status, ' +
    '  data = excluded.data'
  ).run(id, repo, Number(number), branch, issueNumber, projectPath, 'watching', null, now, JSON.stringify(data));
  return id;
}

function listWatchedPRs(db, { status } = {}) {
  ensureSchema(db);
  const rows = status
    ? db.prepare('SELECT * FROM auto_watched_prs WHERE status = ? ORDER BY created_at ASC').all(status)
    : db.prepare('SELECT * FROM auto_watched_prs ORDER BY created_at ASC').all();
  return rows.map(r => ({
    id: r.id,
    repo: r.repo,
    number: r.number,
    branch: r.branch,
    issueNumber: r.issue_number,
    projectPath: r.project_path,
    status: r.status,
    lastCheckedAt: r.last_checked_at,
    createdAt: r.created_at,
    data: safeParse(r.data),
  }));
}

function setWatchedPRStatus(db, repo, number, status, lastCheckedAt) {
  ensureSchema(db);
  const id = watchedPRId(repo, number);
  db.prepare(
    'UPDATE auto_watched_prs SET status = ?, last_checked_at = COALESCE(?, last_checked_at) WHERE id = ?'
  ).run(status, lastCheckedAt || null, id);
}

function removeWatchedPR(db, repo, number) {
  ensureSchema(db);
  db.prepare('DELETE FROM auto_watched_prs WHERE id = ?').run(watchedPRId(repo, number));
}

module.exports = {
  ensureSchema,
  draftKey,
  upsertDraft,
  listDrafts,
  getDraft,
  deleteDraft,
  dismiss,
  isDismissed,
  clearDismiss,
  // watched PRs
  watchedPRId,
  addWatchedPR,
  listWatchedPRs,
  setWatchedPRStatus,
  removeWatchedPR,
};
