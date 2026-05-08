const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const {
  upsertDraft,
  listDrafts,
  getDraft,
  deleteDraft,
  dismiss,
  isDismissed,
  clearDismiss,
  addWatchedPR,
  listWatchedPRs,
  setWatchedPRStatus,
  removeWatchedPR,
} = require('../lib/auto-drafts-store');

function freshDb() { return new DatabaseSync(':memory:'); }

test('upsertDraft + listDrafts: round-trip', () => {
  const db = freshDb();
  upsertDraft(db, { kind: 'comment', repo: 'a/b', targetId: 1, data: { body: 'hi' } });
  upsertDraft(db, { kind: 'review', repo: 'a/b', targetId: 2, data: { body: 'review' } });
  const all = listDrafts(db);
  assert.equal(all.length, 2);
  // Both drafts present, regardless of timestamp tie-break order
  const byKind = Object.fromEntries(all.map(d => [d.kind, d]));
  assert.equal(byKind.comment.data.body, 'hi');
  assert.equal(byKind.review.data.body, 'review');
});

test('upsertDraft: same (kind, repo, targetId) replaces', () => {
  const db = freshDb();
  upsertDraft(db, { kind: 'comment', repo: 'a/b', targetId: 1, data: { body: 'first' } });
  upsertDraft(db, { kind: 'comment', repo: 'a/b', targetId: 1, data: { body: 'second' } });
  const drafts = listDrafts(db);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].data.body, 'second');
});

test('getDraft / deleteDraft', () => {
  const db = freshDb();
  upsertDraft(db, { kind: 'comment', repo: 'a/b', targetId: 9, data: { body: 'x' } });
  const drafts = listDrafts(db);
  const id = drafts[0].id;
  assert.ok(getDraft(db, id));
  deleteDraft(db, id);
  assert.equal(getDraft(db, id), null);
});

test('dismiss / isDismissed / clearDismiss', () => {
  const db = freshDb();
  assert.equal(isDismissed(db, 'issue', 'a/b', 5), false);
  dismiss(db, 'issue', 'a/b', 5);
  assert.equal(isDismissed(db, 'issue', 'a/b', 5), true);
  clearDismiss(db, 'issue', 'a/b', 5);
  assert.equal(isDismissed(db, 'issue', 'a/b', 5), false);
});

test('addWatchedPR + listWatchedPRs: round-trip', () => {
  const db = freshDb();
  addWatchedPR(db, {
    repo: 'a/b', number: 1, branch: 'me/1-fix', issueNumber: 1,
    projectPath: '/tmp/repo', data: { title: 'Fix it' },
  });
  addWatchedPR(db, { repo: 'a/b', number: 2, branch: 'me/2-bug' });
  const all = listWatchedPRs(db);
  assert.equal(all.length, 2);
  assert.equal(all[0].number, 1);
  assert.equal(all[0].status, 'watching');
  assert.equal(all[0].data.title, 'Fix it');
});

test('listWatchedPRs: filters by status', () => {
  const db = freshDb();
  addWatchedPR(db, { repo: 'a/b', number: 1, branch: 'x' });
  addWatchedPR(db, { repo: 'a/b', number: 2, branch: 'y' });
  setWatchedPRStatus(db, 'a/b', 2, 'ready', Date.now());
  const watching = listWatchedPRs(db, { status: 'watching' });
  assert.equal(watching.length, 1);
  assert.equal(watching[0].number, 1);
});

test('addWatchedPR: re-adding same (repo, number) preserves identity, updates fields', () => {
  const db = freshDb();
  addWatchedPR(db, { repo: 'a/b', number: 1, branch: 'old' });
  addWatchedPR(db, { repo: 'a/b', number: 1, branch: 'new' });
  const all = listWatchedPRs(db);
  assert.equal(all.length, 1);
  assert.equal(all[0].branch, 'new');
});

test('removeWatchedPR: deletes the row', () => {
  const db = freshDb();
  addWatchedPR(db, { repo: 'a/b', number: 1, branch: 'x' });
  removeWatchedPR(db, 'a/b', 1);
  assert.equal(listWatchedPRs(db).length, 0);
});

test('addWatchedPR: rejects missing required fields', () => {
  const db = freshDb();
  assert.throws(() => addWatchedPR(db, { repo: 'a/b', number: 1 }), /required/);
  assert.throws(() => addWatchedPR(db, { number: 1, branch: 'x' }), /required/);
  assert.throws(() => addWatchedPR(db, { repo: 'a/b', branch: 'x' }), /required/);
});

test('upsertDraft: rejects missing required fields', () => {
  const db = freshDb();
  assert.throws(() => upsertDraft(db, { repo: 'a/b', targetId: 1 }), /required/);
  assert.throws(() => upsertDraft(db, { kind: 'comment', targetId: 1 }), /required/);
  assert.throws(() => upsertDraft(db, { kind: 'comment', repo: 'a/b' }), /required/);
});
