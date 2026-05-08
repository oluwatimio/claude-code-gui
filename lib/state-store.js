// SQLite-backed persistent store for the GUI state (replaces localStorage).
//
// Schema:
//   conversations(id PK, data TEXT, position INTEGER, updated_at INTEGER)
//   app_settings(key PK, value TEXT)
//
// `data` is a JSON blob holding the full conversation object; we store as-is
// rather than schemafying because conversation shape evolves and we don't
// query individual fields server-side. `position` preserves the user-visible
// order (newest-first) without relying on createdAt.
//
// All functions are pure-ish — they take a `db` (DatabaseSync) so tests can
// pass `new DatabaseSync(':memory:')`.

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id         TEXT PRIMARY KEY,
      data       TEXT NOT NULL,
      position   INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_conversations_position ON conversations(position ASC);

    CREATE TABLE IF NOT EXISTS app_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

function loadAll(db) {
  ensureSchema(db);
  const convRows = db
    .prepare('SELECT data FROM conversations ORDER BY position ASC, updated_at DESC')
    .all();
  const conversations = [];
  for (const row of convRows) {
    try { conversations.push(JSON.parse(row.data)); }
    catch (e) { /* skip corrupt row */ }
  }
  const settingRows = db.prepare('SELECT key, value FROM app_settings').all();
  const settings = {};
  for (const row of settingRows) {
    try { settings[row.key] = JSON.parse(row.value); }
    catch (e) { /* skip corrupt row */ }
  }
  return { conversations, settings };
}

function saveAll(db, payload) {
  ensureSchema(db);
  const conversations = Array.isArray(payload && payload.conversations) ? payload.conversations : [];
  const settings = (payload && payload.settings && typeof payload.settings === 'object') ? payload.settings : {};
  const now = Date.now();

  db.exec('BEGIN');
  try {
    // Replace conversations atomically. We delete-then-insert because the user
    // may have removed conversations and we want the on-disk set to mirror the
    // in-memory truth exactly.
    db.exec('DELETE FROM conversations');
    const insertConv = db.prepare(
      'INSERT INTO conversations (id, data, position, updated_at) VALUES (?, ?, ?, ?)'
    );
    conversations.forEach((conv, idx) => {
      if (!conv || !conv.id) return;
      insertConv.run(String(conv.id), JSON.stringify(conv), idx, now);
    });

    // Upsert settings (preserve existing keys not present in the partial payload —
    // callers can pass settings: {...}; we don't blow away unrelated keys).
    const upsertSetting = db.prepare(
      'INSERT INTO app_settings (key, value) VALUES (?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    );
    for (const key of Object.keys(settings)) {
      upsertSetting.run(key, JSON.stringify(settings[key]));
    }

    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Single-conversation upsert. `position` is optional; if omitted we keep the
// current position or append.
function upsertConversation(db, conv, position) {
  ensureSchema(db);
  if (!conv || !conv.id) return;
  const now = Date.now();
  let pos = position;
  if (pos == null) {
    const row = db
      .prepare('SELECT position FROM conversations WHERE id = ?')
      .get(String(conv.id));
    if (row) {
      pos = row.position;
    } else {
      const max = db
        .prepare('SELECT COALESCE(MAX(position), -1) AS m FROM conversations')
        .get();
      pos = (max && typeof max.m === 'number') ? max.m + 1 : 0;
    }
  }
  db.prepare(
    'INSERT INTO conversations (id, data, position, updated_at) VALUES (?, ?, ?, ?) ' +
    'ON CONFLICT(id) DO UPDATE SET data = excluded.data, position = excluded.position, updated_at = excluded.updated_at'
  ).run(String(conv.id), JSON.stringify(conv), pos, now);
}

function deleteConversation(db, id) {
  ensureSchema(db);
  if (!id) return;
  db.prepare('DELETE FROM conversations WHERE id = ?').run(String(id));
}

function setSetting(db, key, value) {
  ensureSchema(db);
  if (!key) return;
  db.prepare(
    'INSERT INTO app_settings (key, value) VALUES (?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(String(key), JSON.stringify(value));
}

module.exports = {
  ensureSchema,
  loadAll,
  saveAll,
  upsertConversation,
  deleteConversation,
  setSetting,
};
