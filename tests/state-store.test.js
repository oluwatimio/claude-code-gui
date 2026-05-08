const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const {
  loadAll,
  saveAll,
  upsertConversation,
  deleteConversation,
  setSetting,
} = require('../lib/state-store');

function freshDb() {
  return new DatabaseSync(':memory:');
}

test('loadAll: empty db returns empty conversations + settings', () => {
  const db = freshDb();
  const out = loadAll(db);
  assert.deepEqual(out.conversations, []);
  assert.deepEqual(out.settings, {});
});

test('saveAll: persists conversations in given order', () => {
  const db = freshDb();
  saveAll(db, {
    conversations: [
      { id: 'a', title: 'Alpha', messages: [] },
      { id: 'b', title: 'Bravo', messages: [{ role: 'user', content: 'hi' }] },
    ],
    settings: {},
  });
  const { conversations } = loadAll(db);
  assert.equal(conversations.length, 2);
  assert.equal(conversations[0].id, 'a');
  assert.equal(conversations[1].id, 'b');
  assert.equal(conversations[1].messages.length, 1);
});

test('saveAll: deletes conversations not in the new payload (mirrors in-memory truth)', () => {
  const db = freshDb();
  saveAll(db, { conversations: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], settings: {} });
  saveAll(db, { conversations: [{ id: 'a' }, { id: 'c' }], settings: {} });
  const { conversations } = loadAll(db);
  assert.deepEqual(conversations.map(c => c.id), ['a', 'c']);
});

test('saveAll: upserts settings without nuking existing keys', () => {
  const db = freshDb();
  saveAll(db, {
    conversations: [],
    settings: { yolo: true, sidebarWidth: 260 },
  });
  saveAll(db, {
    conversations: [],
    settings: { yolo: false }, // partial
  });
  const { settings } = loadAll(db);
  assert.equal(settings.yolo, false);
  assert.equal(settings.sidebarWidth, 260, 'unrelated key preserved');
});

test('saveAll: round-trips complex setting values (objects, null, arrays)', () => {
  const db = freshDb();
  saveAll(db, {
    conversations: [],
    settings: {
      themePreference: 'dark',
      defaultModel: null,
      prFilter: 'mine',
      nested: { a: 1, b: [2, 3] },
    },
  });
  const { settings } = loadAll(db);
  assert.equal(settings.themePreference, 'dark');
  assert.equal(settings.defaultModel, null);
  assert.deepEqual(settings.nested, { a: 1, b: [2, 3] });
});

test('upsertConversation: inserts new conv at end, updates existing in place', () => {
  const db = freshDb();
  saveAll(db, {
    conversations: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }],
    settings: {},
  });
  upsertConversation(db, { id: 'c', title: 'C' });
  upsertConversation(db, { id: 'a', title: 'A!' }); // existing — keep position
  const { conversations } = loadAll(db);
  assert.deepEqual(conversations.map(c => c.id), ['a', 'b', 'c']);
  assert.equal(conversations[0].title, 'A!');
});

test('deleteConversation: removes a single row', () => {
  const db = freshDb();
  saveAll(db, {
    conversations: [{ id: 'a' }, { id: 'b' }],
    settings: {},
  });
  deleteConversation(db, 'a');
  const { conversations } = loadAll(db);
  assert.deepEqual(conversations.map(c => c.id), ['b']);
});

test('setSetting: upserts a single setting', () => {
  const db = freshDb();
  setSetting(db, 'sidebarWidth', 320);
  setSetting(db, 'sidebarWidth', 400); // override
  setSetting(db, 'yolo', true);
  const { settings } = loadAll(db);
  assert.equal(settings.sidebarWidth, 400);
  assert.equal(settings.yolo, true);
});

test('saveAll: skips conversations without an id (defensive)', () => {
  const db = freshDb();
  saveAll(db, {
    conversations: [{ title: 'no id' }, { id: 'good', title: 'ok' }],
    settings: {},
  });
  const { conversations } = loadAll(db);
  assert.deepEqual(conversations.map(c => c.id), ['good']);
});
