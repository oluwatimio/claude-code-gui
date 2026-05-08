const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  slugifyIssueTitle,
  branchNameForIssue,
  selectActionableIssues,
  issueAlreadyHasMyPR,
  selectUnansweredCommentThreads,
  groupReviewCommentsIntoThreads,
  selectPRsNeedingReview,
  myReviewSatisfied,
  selectReviewers,
  codeownersMatches,
  shouldFlipPRReadyForReview,
} = require('../lib/auto-mode');

// ===== slugifyIssueTitle =====

test('slugifyIssueTitle: basic kebab + lowercase', () => {
  assert.equal(slugifyIssueTitle('Fix the login bug'), 'fix-login-bug');
});

test('slugifyIssueTitle: strips punctuation, drops stopwords', () => {
  assert.equal(slugifyIssueTitle('[Bug]: A test of the system!!!'), 'bug-test-system');
});

test('slugifyIssueTitle: caps length on word boundary', () => {
  const t = 'super long title that goes on and on with many many descriptive words here';
  const s = slugifyIssueTitle(t, { maxLen: 30 });
  assert.ok(s.length <= 30, 'within cap');
  assert.ok(!s.endsWith('-'), 'no trailing dash');
});

test('slugifyIssueTitle: empty / non-string falls back to "issue"', () => {
  assert.equal(slugifyIssueTitle(''), 'issue');
  assert.equal(slugifyIssueTitle(null), 'issue');
  assert.equal(slugifyIssueTitle(123), 'issue');
});

test('branchNameForIssue: prefixes with login + issue number', () => {
  assert.equal(
    branchNameForIssue('timi', { number: 42, title: 'Fix the auth flow' }),
    'timi/42-fix-auth-flow'
  );
});

// ===== issueAlreadyHasMyPR =====

test('issueAlreadyHasMyPR: matches on body containing #N', () => {
  const issue = { number: 7, title: 'Refactor the worker' };
  const myPRs = [{ author: { login: 'timi' }, title: 'Refactor', body: 'Closes #7', headRefName: 'fix' }];
  assert.equal(issueAlreadyHasMyPR(issue, myPRs, 'timi'), true);
});

test('issueAlreadyHasMyPR: matches on branch starting with login/N-', () => {
  const issue = { number: 7, title: 'X' };
  const myPRs = [{ author: { login: 'timi' }, title: 'Stuff', body: '', headRefName: 'timi/7-something' }];
  assert.equal(issueAlreadyHasMyPR(issue, myPRs, 'timi'), true);
});

test('issueAlreadyHasMyPR: ignores PRs by other authors', () => {
  const issue = { number: 7, title: 'X' };
  const myPRs = [{ author: { login: 'someone-else' }, title: 'Closes #7', body: '', headRefName: 'a' }];
  assert.equal(issueAlreadyHasMyPR(issue, myPRs, 'timi'), false);
});

test('issueAlreadyHasMyPR: returns false when no match', () => {
  const issue = { number: 7, title: 'X' };
  const myPRs = [{ author: { login: 'timi' }, title: 'unrelated', body: '', headRefName: 'main' }];
  assert.equal(issueAlreadyHasMyPR(issue, myPRs, 'timi'), false);
});

// ===== selectActionableIssues =====

test('selectActionableIssues: filters closed and already-PRd', () => {
  const issues = [
    { number: 1, title: 'open one', state: 'OPEN' },
    { number: 2, title: 'closed one', state: 'CLOSED' },
    { number: 3, title: 'has PR', state: 'open' },
  ];
  const myPRs = [{ author: { login: 'timi' }, title: '', body: 'Fixes #3', headRefName: 'a' }];
  const got = selectActionableIssues({ issues, myPRs, login: 'timi' });
  assert.deepEqual(got.map(i => i.number), [1]);
});

// ===== Comment threads =====

test('selectUnansweredCommentThreads: latest by other user → thread surfaces', () => {
  const t = selectUnansweredCommentThreads({
    issueComments: [
      { user: { login: 'timi' }, body: 'thoughts?', created_at: '2026-05-01T10:00:00Z' },
      { user: { login: 'alice' }, body: 'reply', created_at: '2026-05-02T10:00:00Z' },
    ],
    reviewComments: [],
    login: 'timi',
  });
  assert.equal(t.length, 1);
  assert.equal(t[0].kind, 'issue');
  assert.equal(t[0].latest.user.login, 'alice');
});

test('selectUnansweredCommentThreads: latest by login → no thread', () => {
  const t = selectUnansweredCommentThreads({
    issueComments: [
      { user: { login: 'alice' }, created_at: '2026-05-01T10:00:00Z' },
      { user: { login: 'timi' }, created_at: '2026-05-02T10:00:00Z' },
    ],
    reviewComments: [],
    login: 'timi',
  });
  assert.deepEqual(t, []);
});

test('selectUnansweredCommentThreads: my reply newer than latest other → no thread', () => {
  const t = selectUnansweredCommentThreads({
    issueComments: [
      { user: { login: 'alice' }, created_at: '2026-05-01T10:00:00Z' },
      { user: { login: 'alice' }, created_at: '2026-05-02T10:00:00Z' },
      { user: { login: 'timi' }, created_at: '2026-05-03T10:00:00Z' },
    ],
    reviewComments: [],
    login: 'timi',
  });
  assert.deepEqual(t, []);
});

test('selectUnansweredCommentThreads: review thread groups by reply chain', () => {
  const t = selectUnansweredCommentThreads({
    issueComments: [],
    reviewComments: [
      { id: 1, in_reply_to_id: null, user: { login: 'alice' }, path: 'a.js', line: 10, created_at: '2026-05-01T10:00:00Z' },
      { id: 2, in_reply_to_id: 1, user: { login: 'timi' }, path: 'a.js', line: 10, created_at: '2026-05-02T10:00:00Z' },
      { id: 3, in_reply_to_id: 2, user: { login: 'alice' }, path: 'a.js', line: 10, created_at: '2026-05-03T10:00:00Z' },
      // separate thread:
      { id: 10, in_reply_to_id: null, user: { login: 'bob' }, path: 'b.js', line: 5, created_at: '2026-05-01T10:00:00Z' },
      { id: 11, in_reply_to_id: 10, user: { login: 'timi' }, path: 'b.js', line: 5, created_at: '2026-05-04T10:00:00Z' },
    ],
    login: 'timi',
  });
  // Only the first thread is unanswered (alice replied after timi).
  assert.equal(t.length, 1);
  assert.equal(t[0].kind, 'review');
  assert.equal(t[0].rootId, 1);
  assert.equal(t[0].path, 'a.js');
});

test('groupReviewCommentsIntoThreads: handles missing parents defensively', () => {
  const groups = groupReviewCommentsIntoThreads([
    { id: 5, in_reply_to_id: 999, path: 'a.js' }, // parent missing → treat as root
    { id: 6, in_reply_to_id: 5, path: 'a.js' },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].rootId, 5);
  assert.equal(groups[0].comments.length, 2);
});

// ===== PR reviews =====

test('selectPRsNeedingReview: drops PRs I already approved', () => {
  const out = selectPRsNeedingReview({
    requestedPRs: [
      { repo: 'a/b', number: 1 },
      { repo: 'a/b', number: 2 },
    ],
    reviewsByKey: {
      'a/b#1': [{ user: { login: 'timi' }, state: 'APPROVED' }],
      'a/b#2': [{ user: { login: 'alice' }, state: 'APPROVED' }],
    },
    login: 'timi',
  });
  assert.deepEqual(out.map(p => p.number), [2]);
});

test('selectPRsNeedingReview: same PR number in different repos is not clobbered', () => {
  // Regression: keying by pr.number alone made `c/d#1`'s reviews shadow `a/b#1`.
  const out = selectPRsNeedingReview({
    requestedPRs: [
      { repo: 'a/b', number: 1 },
      { repo: 'c/d', number: 1 },
    ],
    reviewsByKey: {
      'a/b#1': [{ user: { login: 'timi' }, state: 'APPROVED' }],
      'c/d#1': [], // no reviews from me yet — should still surface
    },
    login: 'timi',
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].repo, 'c/d');
});

test('myReviewSatisfied: COMMENTED reviews don\'t count as "engaged"', () => {
  // GitHub treats a COMMENTED review as ambiguous — we still want to surface
  // these so the user can decide whether to approve / request changes.
  const ok = myReviewSatisfied(
    [{ user: { login: 'timi' }, state: 'COMMENTED' }],
    {},
    'timi'
  );
  assert.equal(ok, false);
});

// ===== Reviewer picks =====

test('selectReviewers: CODEOWNERS direct path match wins', () => {
  const picks = selectReviewers({
    touchedFiles: ['src/api/users.ts'],
    codeowners: '/src/api/ @api-team @alice\n* @generic',
    recentAuthorsByFile: {},
    prAuthor: 'timi',
    login: 'timi',
    n: 2,
  });
  // Excludes login + author, accepts both team + user
  assert.deepEqual(picks, ['api-team', 'alice']);
});

test('selectReviewers: extension glob matches', () => {
  const picks = selectReviewers({
    touchedFiles: ['lib/foo.go', 'lib/bar.go'],
    codeowners: '*.go @go-team',
    recentAuthorsByFile: {},
    prAuthor: 'me',
    login: 'me',
  });
  assert.deepEqual(picks, ['go-team']);
});

test('selectReviewers: falls back to recent authors when CODEOWNERS empty', () => {
  const picks = selectReviewers({
    touchedFiles: ['x.js'],
    codeowners: '',
    recentAuthorsByFile: { 'x.js': ['alice', 'bob', 'timi'] },
    prAuthor: 'timi',
    login: 'timi',
    n: 2,
  });
  // 'timi' is excluded as author/self; remaining picks in order
  assert.deepEqual(picks, ['alice', 'bob']);
});

test('selectReviewers: never picks the PR author or login', () => {
  const picks = selectReviewers({
    touchedFiles: ['x.js'],
    codeowners: 'x.js @timi @other-author @alice',
    recentAuthorsByFile: {},
    prAuthor: 'other-author',
    login: 'timi',
    n: 5,
  });
  assert.deepEqual(picks, ['alice']);
});

test('codeownersMatches: covers common patterns', () => {
  assert.equal(codeownersMatches('*', 'anything.txt'), true);
  assert.equal(codeownersMatches('/src/api/', 'src/api/x.ts'), true);
  assert.equal(codeownersMatches('*.ts', 'lib/foo.ts'), true);
  assert.equal(codeownersMatches('*.ts', 'lib/foo.js'), false);
});

// ===== CI ready-for-review =====

test('shouldFlipPRReadyForReview: green checks → true', () => {
  assert.equal(shouldFlipPRReadyForReview({ pass: 5, fail: 0, pending: 0, total: 5 }), true);
});

test('shouldFlipPRReadyForReview: any fail/pending → false', () => {
  assert.equal(shouldFlipPRReadyForReview({ pass: 4, fail: 1, pending: 0, total: 5 }), false);
  assert.equal(shouldFlipPRReadyForReview({ pass: 4, fail: 0, pending: 1, total: 5 }), false);
});

test('shouldFlipPRReadyForReview: zero total → false', () => {
  assert.equal(shouldFlipPRReadyForReview({ pass: 0, fail: 0, pending: 0, total: 0 }), false);
});
