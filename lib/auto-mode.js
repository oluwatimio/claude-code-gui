// Pure logic for auto-mode.
//
// Everything in here is deterministic and IO-free so we can unit-test it
// without spinning up gh/git. Callers pass in pre-fetched data; we return
// queues, decisions, and the strings we need to feed GitHub.

// ----- Slugs ---------------------------------------------------------------

const STOPWORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'in',
  'is', 'it', 'of', 'on', 'or', 'the', 'to', 'with',
]);

// Issue title → branch suffix. Lowercase, alphanumerics + dashes, capped.
function slugifyIssueTitle(title, { maxLen = 40 } = {}) {
  if (!title || typeof title !== 'string') return 'issue';
  const cleaned = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w && !STOPWORDS.has(w));
  if (!cleaned.length) return 'issue';
  let out = cleaned.join('-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (out.length > maxLen) {
    out = out.slice(0, maxLen).replace(/-[^-]*$/, '');
  }
  return out || 'issue';
}

function branchNameForIssue(login, issue) {
  const slug = slugifyIssueTitle(issue && issue.title);
  const num = (issue && issue.number) || 0;
  return `${login}/${num}-${slug}`;
}

// ----- Issue triage --------------------------------------------------------

// Filter the user's assigned issues to those that look actionable: open, no
// existing PR opened by `login` referencing the issue (heuristic: PR title /
// body / branch contains `#<num>` or the issue's branch slug).
function selectActionableIssues({ issues = [], myPRs = [], login }) {
  const out = [];
  for (const issue of issues) {
    if (!issue || issue.state !== 'OPEN' && issue.state !== 'open') continue;
    if (issueAlreadyHasMyPR(issue, myPRs, login)) continue;
    out.push(issue);
  }
  return out;
}

function issueAlreadyHasMyPR(issue, myPRs, login) {
  const num = issue && issue.number;
  if (!num) return false;
  const slug = slugifyIssueTitle(issue.title);
  const branchPrefix = `${login}/${num}-`;
  for (const pr of myPRs || []) {
    if (!pr) continue;
    if (pr.author && pr.author.login && pr.author.login !== login) continue;
    const text = [pr.title, pr.body, pr.headRefName].filter(Boolean).join('\n');
    if (
      text.includes(`#${num}`) ||
      (pr.headRefName && pr.headRefName.startsWith(branchPrefix)) ||
      (pr.headRefName && pr.headRefName.includes(slug))
    ) {
      return true;
    }
  }
  return false;
}

// ----- PR comment triage ---------------------------------------------------

// A "thread" we should consider replying to:
//   - The latest message in the thread is NOT by `login`.
//   - The latest message is newer than `login`'s last reply on that thread.
// `comments` may be top-level issue comments OR inline review comments.
// We compute one decision per thread:
//   - issue comments form a single thread
//   - inline review comments are grouped by the root comment id (or path+line if absent)
function selectUnansweredCommentThreads({ issueComments = [], reviewComments = [], login }) {
  const threads = [];

  // Top-level (issue) thread
  if (issueComments.length) {
    const sorted = [...issueComments].sort(byCreatedAtAsc);
    const decision = decideThread(sorted, login);
    if (decision) {
      threads.push({
        kind: 'issue',
        rootId: 'issue',
        latest: decision.latest,
        sinceMs: decision.sinceMs,
        comments: sorted,
      });
    }
  }

  // Inline review threads, grouped by in_reply_to_id chain
  const groups = groupReviewCommentsIntoThreads(reviewComments);
  for (const g of groups) {
    const decision = decideThread(g.comments, login);
    if (!decision) continue;
    threads.push({
      kind: 'review',
      rootId: g.rootId,
      path: g.path,
      line: g.line,
      latest: decision.latest,
      sinceMs: decision.sinceMs,
      comments: g.comments,
    });
  }

  return threads;
}

function byCreatedAtAsc(a, b) {
  return new Date(a.created_at || a.createdAt || 0) - new Date(b.created_at || b.createdAt || 0);
}

// Return { latest, sinceMs } if the thread needs a reply from `login`, else null.
function decideThread(sortedComments, login) {
  if (!sortedComments.length) return null;
  const latest = sortedComments[sortedComments.length - 1];
  const latestUser = (latest.user && latest.user.login) || latest.author && latest.author.login;
  if (!latestUser) return null;
  if (latestUser === login) return null; // we already had the last word
  // Find login's most recent reply in this thread; if it predates latest, we owe one.
  let lastByMe = null;
  for (const c of sortedComments) {
    const u = (c.user && c.user.login) || (c.author && c.author.login);
    if (u === login) lastByMe = c;
  }
  const latestTs = new Date(latest.created_at || latest.createdAt || 0).getTime();
  const myTs = lastByMe ? new Date(lastByMe.created_at || lastByMe.createdAt || 0).getTime() : 0;
  if (myTs >= latestTs) return null;
  return { latest, sinceMs: latestTs };
}

function groupReviewCommentsIntoThreads(comments) {
  const byId = new Map();
  for (const c of comments || []) {
    if (c && c.id != null) byId.set(c.id, c);
  }
  // root = comment with no in_reply_to_id (or whose parent is missing)
  const groups = new Map(); // rootId -> { rootId, path, line, comments[] }
  for (const c of comments || []) {
    let cur = c;
    let safety = 50;
    while (cur && cur.in_reply_to_id != null && byId.has(cur.in_reply_to_id) && safety-- > 0) {
      cur = byId.get(cur.in_reply_to_id);
    }
    const rootId = cur && cur.id;
    if (rootId == null) continue;
    if (!groups.has(rootId)) {
      groups.set(rootId, {
        rootId,
        path: cur.path || '',
        line: cur.line || cur.original_line || null,
        comments: [],
      });
    }
    groups.get(rootId).comments.push(c);
  }
  for (const g of groups.values()) {
    g.comments.sort(byCreatedAtAsc);
  }
  return Array.from(groups.values());
}

// ----- PR review triage ----------------------------------------------------

// PRs requesting `login` as a reviewer that haven't been reviewed yet by them.
// Reviews are keyed by `<repo>#<number>` so two PRs with the same number in
// different repos don't clobber each other. (Earlier the key was just
// pr.number — bug fix while we were here.)
function reviewKeyForPR(pr) {
  return pr ? `${pr.repo}#${pr.number}` : '';
}

function selectPRsNeedingReview({ requestedPRs = [], reviewsByKey = {}, login }) {
  const out = [];
  for (const pr of requestedPRs) {
    if (!pr) continue;
    const reviews = reviewsByKey[reviewKeyForPR(pr)] || [];
    if (myReviewSatisfied(reviews, pr, login)) continue;
    out.push(pr);
  }
  return out;
}

function myReviewSatisfied(reviews, pr, login) {
  // If I have a non-COMMENTED review submitted after pr.headSha (or after my
  // last review), we consider it handled. Without commit-sha-per-review data
  // we conservatively treat any APPROVED / CHANGES_REQUESTED review as
  // "I've engaged" — the user can always re-review manually.
  for (const r of reviews) {
    if (!r) continue;
    const u = (r.user && r.user.login) || (r.author && r.author.login);
    if (u !== login) continue;
    if (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED' || r.state === 'DISMISSED') return true;
  }
  return false;
}

// ----- Reviewer selection --------------------------------------------------

// Pick up to `n` reviewers based on:
//   1. CODEOWNERS lines that match any touched file path
//   2. Most recent committers to the touched files (excluding the PR author)
// Strip `@` prefixes; never pick the PR author or `login` itself.
function selectReviewers({
  touchedFiles = [],
  codeowners = '',
  recentAuthorsByFile = {},
  prAuthor,
  login,
  n = 2,
}) {
  const exclude = new Set([login, prAuthor].filter(Boolean));
  const out = [];

  function add(name) {
    if (!name) return;
    const clean = name.replace(/^@/, '').trim();
    if (!clean || exclude.has(clean) || out.includes(clean)) return;
    out.push(clean);
  }

  // CODEOWNERS — line-based, simple-glob matching against touched paths.
  const ownerLines = String(codeowners || '')
    .split('\n')
    .map(l => l.replace(/#.*/, '').trim())
    .filter(Boolean);
  for (const file of touchedFiles) {
    for (const line of ownerLines) {
      const parts = line.split(/\s+/);
      const pattern = parts[0];
      const owners = parts.slice(1);
      if (codeownersMatches(pattern, file)) {
        for (const o of owners) add(o);
      }
    }
    if (out.length >= n) break;
  }

  // Fall back to recent authors (most-recent first)
  if (out.length < n) {
    const seen = new Set();
    for (const file of touchedFiles) {
      const list = recentAuthorsByFile[file] || [];
      for (const author of list) {
        if (seen.has(author)) continue;
        seen.add(author);
        add(author);
        if (out.length >= n) break;
      }
      if (out.length >= n) break;
    }
  }

  return out.slice(0, n);
}

function codeownersMatches(pattern, file) {
  if (!pattern || !file) return false;
  // The simplest cases that cover the bulk of CODEOWNERS files. We don't
  // claim full git-ignore semantics; user can always override the picks.
  if (pattern === '*') return true;
  if (pattern.startsWith('/')) {
    pattern = pattern.slice(1);
    if (file.startsWith(pattern)) return true;
  }
  if (pattern.endsWith('/')) {
    return file.startsWith(pattern) || file.includes('/' + pattern);
  }
  // Wildcard suffix like *.ts
  if (pattern.startsWith('*.')) {
    return file.endsWith(pattern.slice(1));
  }
  // Substring fallback
  return file.includes(pattern);
}

// ----- CI ready-for-review --------------------------------------------------

// Decide whether to flip a draft auto-PR to ready-for-review.
// Inputs are normalized check buckets: { pass, fail, pending, total }.
// We require: at least one check, no failures, nothing pending.
function shouldFlipPRReadyForReview(checksSummary) {
  if (!checksSummary || typeof checksSummary !== 'object') return false;
  const total = checksSummary.total || 0;
  if (total === 0) return false;
  if ((checksSummary.fail || 0) > 0) return false;
  if ((checksSummary.pending || 0) > 0) return false;
  return (checksSummary.pass || 0) > 0;
}

module.exports = {
  STOPWORDS,
  slugifyIssueTitle,
  branchNameForIssue,
  selectActionableIssues,
  issueAlreadyHasMyPR,
  selectUnansweredCommentThreads,
  groupReviewCommentsIntoThreads,
  selectPRsNeedingReview,
  reviewKeyForPR,
  myReviewSatisfied,
  selectReviewers,
  codeownersMatches,
  shouldFlipPRReadyForReview,
};
