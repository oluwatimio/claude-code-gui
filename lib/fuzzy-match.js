// Pure fuzzy-match scoring and ranking for file-path strings.
// Shared by the @-picker in the chat input and the spotlight file-opener,
// so ranking is consistent and testable in one place.
//
// Dual-mode: require()-able from tests and main.js, or loaded via <script>
// in the renderer (attaches `fuzzyMatch` on the global).

(function (global) {
  // Subsequence match with bonuses for boundary/prefix matches.
  // Returns { score, positions } or null if the query is not a subsequence.
  function fuzzyScore(query, target) {
    const q = String(query || '').toLowerCase();
    const t = String(target || '').toLowerCase();
    if (!q) return { score: 0, positions: [] };
    const tl = t.length;
    let ti = 0;
    let score = 0;
    let streak = 0;
    const positions = [];
    for (let qi = 0; qi < q.length; qi++) {
      const qc = q[qi];
      let found = -1;
      while (ti < tl) {
        if (t[ti] === qc) { found = ti; break; }
        ti++;
      }
      if (found === -1) return null;
      positions.push(found);
      // Prefix of filename (after last '/')
      const lastSlash = t.lastIndexOf('/', found);
      if (found === lastSlash + 1) score += 6;
      // Start of whole path
      if (found === 0) score += 4;
      // Boundary (after '/', '-', '_', '.')
      else if (/[\/\-_\.]/.test(t[found - 1])) score += 3;
      // Contiguous streak bonus
      if (found === ti) { streak++; score += streak * 2; } else { streak = 1; }
      // Small penalty for gaps
      score -= Math.min(ti - (found - 1), 4);
      ti = found + 1;
    }
    // Shorter paths win ties
    score -= Math.min(tl * 0.05, 4);
    return { score, positions };
  }

  // Rank a list of `{ rel, type?, ... }` entries against a query.
  // When `query` is empty, sort files before dirs then by shortest path.
  // Files outrank folders of the same fuzzy score (dir penalty of -2).
  // Options: `limit` caps the number of results returned.
  function rankFiles(files, query, options) {
    const opts = options || {};
    const limit = typeof opts.limit === 'number' ? opts.limit : 50;
    const list = Array.isArray(files) ? files : [];
    if (!query) {
      return list
        .slice()
        .sort((a, b) => {
          const aType = (a && a.type) || 'file';
          const bType = (b && b.type) || 'file';
          if (aType !== bType) return aType === 'file' ? -1 : 1;
          return ((a && a.rel) || '').length - ((b && b.rel) || '').length;
        })
        .slice(0, limit);
    }
    const scored = [];
    for (const f of list) {
      if (!f || typeof f.rel !== 'string') continue;
      const res = fuzzyScore(query, f.rel);
      if (!res) continue;
      const penalty = f.type === 'dir' ? 2 : 0;
      scored.push({ f, score: res.score - penalty, positions: res.positions });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => Object.assign({}, s.f, { _positions: s.positions }));
  }

  // Given a target string and a sorted list of match positions, return a
  // segment list [{ text, match }] the renderer can turn into DOM safely
  // (instead of building HTML strings).
  function highlightSegments(text, positions) {
    const str = String(text || '');
    const marks = new Set(Array.isArray(positions) ? positions : []);
    const segments = [];
    let buffer = '';
    let inMatch = false;
    for (let i = 0; i < str.length; i++) {
      const hit = marks.has(i);
      if (hit !== inMatch && buffer) {
        segments.push({ text: buffer, match: inMatch });
        buffer = '';
      }
      inMatch = hit;
      buffer += str[i];
    }
    if (buffer) segments.push({ text: buffer, match: inMatch });
    return segments;
  }

  const api = { fuzzyScore, rankFiles, highlightSegments };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.fuzzyMatch = api;
})(typeof window !== 'undefined' ? window : globalThis);
