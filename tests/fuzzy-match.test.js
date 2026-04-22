const { test } = require('node:test');
const assert = require('node:assert/strict');

const fm = require('../lib/fuzzy-match');

// ===== fuzzyScore =====

test('fuzzyScore: empty query returns score 0 with no positions', () => {
  const r = fm.fuzzyScore('', 'renderer/app.js');
  assert.equal(r.score, 0);
  assert.deepEqual(r.positions, []);
});

test('fuzzyScore: non-subsequence returns null', () => {
  assert.equal(fm.fuzzyScore('xyz', 'renderer/app.js'), null);
});

test('fuzzyScore: filename prefix outranks mid-filename match', () => {
  // 'app' as filename prefix in app.js beats 'app' buried inside snapping.js
  const prefix = fm.fuzzyScore('app', 'renderer/app.js');
  const mid = fm.fuzzyScore('app', 'snapping.js');
  assert.ok(prefix);
  assert.ok(mid);
  assert.ok(prefix.score > mid.score, `prefix ${prefix.score} should beat mid ${mid.score}`);
});

test('fuzzyScore: shorter path outscores longer path for same match', () => {
  const a = fm.fuzzyScore('app', 'app.js');
  const b = fm.fuzzyScore('app', 'renderer/components/very/deep/app.js');
  assert.ok(a.score > b.score);
});

test('fuzzyScore: positions land on matched characters in order', () => {
  const r = fm.fuzzyScore('rap', 'renderer/app.js');
  assert.ok(r);
  for (let i = 1; i < r.positions.length; i++) {
    assert.ok(r.positions[i] > r.positions[i - 1], 'positions must be strictly increasing');
  }
  assert.equal('renderer/app.js'[r.positions[0]].toLowerCase(), 'r');
});

test('fuzzyScore: case-insensitive', () => {
  const lower = fm.fuzzyScore('readme', 'README.md');
  const mixed = fm.fuzzyScore('ReAdMe', 'README.md');
  assert.ok(lower);
  assert.ok(mixed);
  assert.equal(lower.score, mixed.score);
});

// ===== rankFiles =====

test('rankFiles: empty query places files before dirs, sorted by path length', () => {
  const files = [
    { rel: 'z/long/nested/file.js', type: 'file' },
    { rel: 'a', type: 'dir' },
    { rel: 'b.js', type: 'file' },
  ];
  const ranked = fm.rankFiles(files, '');
  assert.equal(ranked[0].rel, 'b.js');
  assert.equal(ranked[1].rel, 'z/long/nested/file.js');
  assert.equal(ranked[2].rel, 'a'); // dir pushed after files
});

test('rankFiles: query filters to subsequence matches only', () => {
  const files = [
    { rel: 'renderer/app.js', type: 'file' },
    { rel: 'main.js', type: 'file' },
    { rel: 'readme.md', type: 'file' },
  ];
  const ranked = fm.rankFiles(files, 'app');
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].rel, 'renderer/app.js');
});

test('rankFiles: files outrank folders at equal match score', () => {
  const files = [
    { rel: 'config', type: 'dir' },
    { rel: 'config.js', type: 'file' },
  ];
  const ranked = fm.rankFiles(files, 'config');
  assert.equal(ranked[0].rel, 'config.js');
  assert.equal(ranked[1].rel, 'config');
});

test('rankFiles: attaches match positions for highlighting', () => {
  const files = [{ rel: 'app.js', type: 'file' }];
  const ranked = fm.rankFiles(files, 'ap');
  assert.ok(Array.isArray(ranked[0]._positions));
  assert.equal(ranked[0]._positions.length, 2);
});

test('rankFiles: respects limit option', () => {
  const files = Array.from({ length: 100 }, (_, i) => ({ rel: `f${i}.js`, type: 'file' }));
  const ranked = fm.rankFiles(files, '', { limit: 10 });
  assert.equal(ranked.length, 10);
});

test('rankFiles: skips malformed entries defensively', () => {
  const files = [null, { rel: 'ok.js', type: 'file' }, { rel: 123 }, undefined];
  const ranked = fm.rankFiles(files, 'ok');
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].rel, 'ok.js');
});

test('rankFiles: defaults type to file when missing', () => {
  const files = [
    { rel: 'b' },           // no type -> treated as file
    { rel: 'a', type: 'dir' },
  ];
  const ranked = fm.rankFiles(files, '');
  assert.equal(ranked[0].rel, 'b');
  assert.equal(ranked[1].rel, 'a');
});

// ===== highlightSegments =====

test('highlightSegments: splits into contiguous match/non-match runs', () => {
  const segments = fm.highlightSegments('foo-bar', [0, 1, 4]);
  assert.deepEqual(segments, [
    { text: 'fo', match: true },
    { text: 'o-', match: false },
    { text: 'b', match: true },
    { text: 'ar', match: false },
  ]);
});

test('highlightSegments: no positions returns single non-match segment', () => {
  const segments = fm.highlightSegments('hello', []);
  assert.deepEqual(segments, [{ text: 'hello', match: false }]);
});

test('highlightSegments: empty input returns empty list', () => {
  assert.deepEqual(fm.highlightSegments('', [0]), []);
});
