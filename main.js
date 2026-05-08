const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const pty = require('node-pty');
const {
  buildClaudeArgs,
  shouldSurfaceStderr,
  processStreamEvent: processStreamEventPure,
} = require('./lib/claude-cli');
const { listSlashCommands } = require('./lib/slash-commands');
const stateStore = require('./lib/state-store');
const autoMode = require('./lib/auto-mode');
const autoDrafts = require('./lib/auto-drafts-store');

const terminals = new Map(); // sessionId -> { pty, webContents }

let mainWindow;
const claudeProcesses = new Map(); // convId -> child
let permissionServer = null;
let permissionPort = null;
const pendingPermissions = new Map(); // toolUseId -> res
const pendingAsks = new Map(); // askId -> res
let mcpConfigPath = null;
let contextDb = null;

const isPacked = app.isPackaged;

// Resolve claude binary - packaged apps may not inherit shell PATH
function findClaudeBinary() {
  const { execSync } = require('child_process');

  // Try common locations
  const candidates = [
    'claude', // in PATH already
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    path.join(os.homedir(), '.npm-global', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/usr/bin/claude',
  ];

  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate.startsWith('/') ? candidate : '');
      return candidate;
    } catch (e) {}
  }

  // Fall back to shell lookup
  try {
    return execSync('bash -lc "which claude"', { encoding: 'utf8' }).trim();
  } catch (e) {}

  return 'claude'; // hope for the best
}

// MCP servers live in extraResources when packaged, next to main.js in dev
function getMcpServerPath(name) {
  if (isPacked) {
    return path.join(process.resourcesPath, name);
  }
  return path.join(__dirname, name);
}

// Find node binary - Claude spawns MCP servers, so it needs the full path
function findNodeBinary() {
  const { execSync } = require('child_process');

  // Best approach: ask the shell (picks up nvm, fnm, etc.)
  try {
    const result = execSync('bash -lc "which node"', { encoding: 'utf8', timeout: 5000 }).trim();
    if (result) return result;
  } catch (e) {}

  // Check NVM current alias
  const nvmDir = path.join(os.homedir(), '.nvm');
  try {
    const currentLink = fs.realpathSync(path.join(nvmDir, 'current', 'bin', 'node'));
    if (currentLink) return currentLink;
  } catch (e) {}

  // Scan NVM versions for any node binary
  try {
    const versionsDir = path.join(nvmDir, 'versions', 'node');
    const versions = fs.readdirSync(versionsDir).sort().reverse();
    for (const v of versions) {
      const bin = path.join(versionsDir, v, 'bin', 'node');
      try { fs.accessSync(bin, fs.constants.X_OK); return bin; } catch (e) {}
    }
  } catch (e) {}

  // Standard locations
  for (const p of ['/usr/bin/node', '/usr/local/bin/node', path.join(os.homedir(), '.local', 'bin', 'node')]) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (e) {}
  }

  return 'node';
}

// ===== Bridge HTTP Server (permissions + context memory) =====
function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => body += chunk);
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function writeJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

async function handleContextRequest(url, data) {
  if (url === '/context/remember') return contextRemember(data);
  if (url === '/context/recall')   return contextRecall(data);
  if (url === '/context/forget')   return contextForget(data);
  return null;
}

function startPermissionServer() {
  return new Promise((resolve) => {
    permissionServer = http.createServer(async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(404); res.end(); return;
      }

      if (req.url === '/permission') {
        try {
          const data = await readJson(req);
          const toolUseId = data.tool_use_id || `tuid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          pendingPermissions.set(toolUseId, res);
          mainWindow.webContents.send('permission:request', {
            toolName: data.tool_name || 'Unknown',
            input: data.input || {},
            toolUseId,
            convId: data.conv_id || null,
          });
        } catch (e) {
          writeJson(res, 400, { behavior: 'deny', reason: 'Bad request' });
        }
        return;
      }

      if (req.url === '/ask') {
        try {
          const data = await readJson(req);
          const askId = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          pendingAsks.set(askId, res);
          mainWindow.webContents.send('ask:request', {
            askId,
            question: data.question || '',
            options: Array.isArray(data.options) ? data.options : [],
            context: data.context || '',
            convId: data.conv_id || null,
          });
        } catch (e) {
          writeJson(res, 400, { canceled: true, error: 'Bad request' });
        }
        return;
      }

      if (req.url.startsWith('/context/')) {
        try {
          const data = await readJson(req);
          const result = await handleContextRequest(req.url, data);
          if (result === null) { writeJson(res, 404, { error: 'Unknown endpoint' }); return; }
          writeJson(res, 200, result);
        } catch (e) {
          writeJson(res, 500, { error: e.message });
        }
        return;
      }

      res.writeHead(404); res.end();
    });

    permissionServer.listen(0, '127.0.0.1', () => {
      permissionPort = permissionServer.address().port;
      resolve(permissionPort);
    });
  });
}

// Handle permission response from renderer
ipcMain.on('permission:response', (_, payload) => {
  const { toolUseId, decision } = payload || {};
  const res = toolUseId ? pendingPermissions.get(toolUseId) : null;
  if (res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(decision));
    pendingPermissions.delete(toolUseId);
  }
});

// Handle ask-user response from renderer
ipcMain.on('ask:response', (_, payload) => {
  const { askId, answer, canceled } = payload || {};
  const res = askId ? pendingAsks.get(askId) : null;
  if (res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(canceled ? { canceled: true } : { answer: answer || '' }));
    pendingAsks.delete(askId);
  }
});

// ===== Window =====
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 600,
    minHeight: 400,
    frame: false,
    backgroundColor: '#000000',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 11, y: 11 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    },
    icon: path.join(__dirname, 'assets', 'icon.png')
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

}

app.whenReady().then(async () => {
  openContextDb();
  await startPermissionServer();
  writeMcpConfig();
  createWindow();
  initAutoMode();
});

// ===== Context memory (SQLite) =====
function openContextDb() {
  const userData = app.getPath('userData');
  fs.mkdirSync(userData, { recursive: true });
  const dbPath = path.join(userData, 'context.db');
  contextDb = new DatabaseSync(dbPath);
  // App-state tables (conversations + settings) live in the same DB as memories
  // — one file is easier to back up and there's no cross-store coordination.
  stateStore.ensureSchema(contextDb);
  contextDb.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id         TEXT PRIMARY KEY,
      content    TEXT NOT NULL,
      category   TEXT,
      tags       TEXT,
      created_at INTEGER NOT NULL,
      session_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      id UNINDEXED, content, category, tags,
      tokenize = 'unicode61'
    );
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(id, content, category, tags)
        VALUES (new.id, new.content, new.category, new.tags);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      DELETE FROM memories_fts WHERE id = old.id;
    END;
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      DELETE FROM memories_fts WHERE id = old.id;
      INSERT INTO memories_fts(id, content, category, tags)
        VALUES (new.id, new.content, new.category, new.tags);
    END;
  `);

  // Backfill FTS index for memories saved before the index existed.
  const ftsCount = contextDb.prepare('SELECT COUNT(*) AS c FROM memories_fts').get().c;
  const memCount = contextDb.prepare('SELECT COUNT(*) AS c FROM memories').get().c;
  if (ftsCount !== memCount) {
    contextDb.exec('DELETE FROM memories_fts');
    const insert = contextDb.prepare('INSERT INTO memories_fts(id, content, category, tags) VALUES (?, ?, ?, ?)');
    for (const row of contextDb.prepare('SELECT id, content, category, tags FROM memories').all()) {
      insert.run(row.id, row.content, row.category, row.tags);
    }
  }
}

function rowToMemory(row) {
  return {
    id: row.id,
    content: row.content,
    category: row.category || null,
    tags: row.tags ? row.tags.split(',').filter(Boolean) : [],
    createdAt: row.created_at,
    sessionId: row.session_id || null,
  };
}

function contextRemember(data) {
  const content = (data.content || '').trim();
  if (!content) throw new Error('content is required');
  const id = crypto.randomUUID();
  const tags = Array.isArray(data.tags) ? data.tags.join(',') : '';
  const category = data.category || null;
  const sessionId = data.sessionId || null;
  const createdAt = Date.now();
  contextDb.prepare(
    'INSERT INTO memories (id, content, category, tags, created_at, session_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, content, category, tags, createdAt, sessionId);
  return { id, content, category, tags: tags ? tags.split(',') : [], createdAt };
}

function contextRecall(data) {
  const query = (data.query || '').trim();
  const limit = Math.min(Math.max(Number(data.limit) || 20, 1), 200);
  if (!query) {
    const rows = contextDb.prepare(
      'SELECT * FROM memories ORDER BY created_at DESC LIMIT ?'
    ).all(limit);
    return { memories: rows.map(rowToMemory) };
  }

  const tokens = Array.from(query.matchAll(/[\p{L}\p{N}]+/gu), m => m[0]).filter(t => t.length > 0);
  let rankedRows = [];
  if (tokens.length) {
    const matchExpr = tokens.map(t => `"${t.replace(/"/g, '""')}"*`).join(' OR ');
    try {
      rankedRows = contextDb.prepare(
        `SELECT m.* FROM memories_fts f
         JOIN memories m ON m.id = f.id
         WHERE memories_fts MATCH ?
         ORDER BY bm25(memories_fts)
         LIMIT ?`
      ).all(matchExpr, limit);
    } catch (e) {
      rankedRows = [];
    }
  }

  if (rankedRows.length === 0) {
    const like = `%${query}%`;
    rankedRows = contextDb.prepare(
      `SELECT * FROM memories
       WHERE content LIKE ? OR category LIKE ? OR tags LIKE ?
       ORDER BY created_at DESC
       LIMIT ?`
    ).all(like, like, like, limit);
  }

  return { memories: rankedRows.map(rowToMemory) };
}

function contextForget(data) {
  const id = data.id;
  if (!id) throw new Error('id is required');
  const info = contextDb.prepare('DELETE FROM memories WHERE id = ?').run(id);
  return { deleted: info.changes > 0 };
}

function writeMcpConfig() {
  const nodeBin = findNodeBinary();
  const portEnv = { CLAUDE_GUI_PERMISSION_PORT: String(permissionPort) };
  const config = {
    mcpServers: {
      'gui_permissions': {
        type: 'stdio',
        command: nodeBin,
        args: [getMcpServerPath('mcp-permission-server.js')],
        env: portEnv
      },
      'context': {
        type: 'stdio',
        command: nodeBin,
        args: [getMcpServerPath('mcp-context-server.js')],
        env: portEnv
      },
      'gui_ask': {
        type: 'stdio',
        command: nodeBin,
        args: [getMcpServerPath('mcp-ask-server.js')],
        env: portEnv
      }
    }
  };

  mcpConfigPath = path.join(os.tmpdir(), `claude-gui-mcp-${process.pid}.json`);
  fs.writeFileSync(mcpConfigPath, JSON.stringify(config, null, 2));
}

function cleanup() {
  for (const child of claudeProcesses.values()) {
    try { child.kill('SIGTERM'); } catch (e) {}
  }
  claudeProcesses.clear();
  if (permissionServer) permissionServer.close();
  if (mcpConfigPath) try { fs.unlinkSync(mcpConfigPath); } catch (e) {}
  if (contextDb) try { contextDb.close(); } catch (e) {}
  for (const { pty: p } of terminals.values()) {
    try { p.kill(); } catch (e) {}
  }
  terminals.clear();
  for (const w of branchWatchers.values()) {
    try { w.close(); } catch (e) {}
  }
  branchWatchers.clear();
}

app.on('window-all-closed', () => {
  cleanup();
  app.quit();
});

app.on('before-quit', cleanup);

// Open external links
ipcMain.on('shell:open-external', (_, url) => {
  shell.openExternal(url);
});

// Project folder picker
ipcMain.handle('project:pick', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select project folder',
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// File picker for chat attachments (files + images)
ipcMain.handle('files:pick-attachments', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    title: 'Attach files',
    filters: [
      { name: 'All Files', extensions: ['*'] },
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'] },
      { name: 'Text', extensions: ['txt', 'md', 'json', 'yaml', 'yml', 'csv', 'log'] },
      { name: 'Code', extensions: ['js', 'ts', 'jsx', 'tsx', 'py', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'sh'] },
    ],
  });
  if (result.canceled || !result.filePaths.length) return [];
  return result.filePaths;
});

// ===== External IDE launcher =====
// Tries the IDE's CLI first; on macOS falls back to `open -a <AppName>`
// so JetBrains apps still work even when their `Create Command-line
// Launcher` shim isn't installed.
const IDE_COMMANDS = [
  { id: 'vscode',   label: 'VS Code',        cli: 'code',          macApp: 'Visual Studio Code' },
  { id: 'cursor',   label: 'Cursor',         cli: 'cursor',        macApp: 'Cursor' },
  { id: 'zed',      label: 'Zed',            cli: 'zed',           macApp: 'Zed' },
  { id: 'webstorm', label: 'WebStorm',       cli: 'webstorm',      macApp: 'WebStorm' },
  { id: 'rubymine', label: 'RubyMine',       cli: 'rubymine',      macApp: 'RubyMine' },
  { id: 'pycharm',  label: 'PyCharm',        cli: 'pycharm',       macApp: 'PyCharm' },
  { id: 'idea',     label: 'IntelliJ IDEA',  cli: 'idea',          macApp: 'IntelliJ IDEA' },
  { id: 'goland',   label: 'GoLand',         cli: 'goland',        macApp: 'GoLand' },
  { id: 'sublime',  label: 'Sublime Text',   cli: 'subl',          macApp: 'Sublime Text' },
];

ipcMain.handle('ide:list', async () => IDE_COMMANDS.map((i) => ({ id: i.id, label: i.label })));

ipcMain.handle('ide:open', async (_, { id, filePath } = {}) => {
  const ide = IDE_COMMANDS.find((i) => i.id === id);
  if (!ide) return { ok: false, error: 'Unknown IDE' };
  if (!filePath) return { ok: false, error: 'No file path' };

  const launch = (cmd, args) => new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      let settled = false;
      child.once('error', (err) => { if (!settled) { settled = true; resolve({ ok: false, error: err.message }); } });
      child.once('spawn', () => {
        if (settled) return;
        settled = true;
        try { child.unref(); } catch (e) {}
        resolve({ ok: true });
      });
      // Safety timer — if neither event fires, assume failure.
      setTimeout(() => { if (!settled) { settled = true; resolve({ ok: false, error: 'spawn timeout' }); } }, 1500);
    } catch (err) {
      resolve({ ok: false, error: err && err.message ? err.message : String(err) });
    }
  });

  // 1. Try the CLI on PATH.
  let result = await launch(ide.cli, [filePath]);
  if (result.ok) return result;
  // 2. macOS: fall back to `open -a <AppName> <path>` — works as long as the app is installed.
  if (process.platform === 'darwin' && ide.macApp) {
    const fallback = await launch('open', ['-a', ide.macApp, filePath]);
    if (fallback.ok) return fallback;
    return { ok: false, error: `${ide.label} not found (tried "${ide.cli}" and "open -a ${ide.macApp}")` };
  }
  return { ok: false, error: `${ide.label} CLI "${ide.cli}" not found on PATH` };
});

// ===== gh CLI integration =====
let _ghBinary = null;
function findGhBinary() {
  if (_ghBinary) return _ghBinary;
  const candidates = [
    '/opt/homebrew/bin/gh',
    '/usr/local/bin/gh',
    '/usr/bin/gh',
    path.join(os.homedir(), '.local', 'bin', 'gh'),
  ];
  for (const c of candidates) {
    try { fs.accessSync(c, fs.constants.X_OK); _ghBinary = c; return c; } catch (e) {}
  }
  try {
    const { execSync } = require('child_process');
    const result = execSync('bash -lc "which gh"', { encoding: 'utf8', timeout: 3000 }).trim();
    if (result) { _ghBinary = result; return result; }
  } catch (e) {}
  _ghBinary = 'gh';
  return _ghBinary;
}

function runGh(args, { cwd, stdin } = {}) {
  return new Promise((resolve) => {
    const bin = findGhBinary();
    const child = spawn(bin, args, {
      cwd: cwd || undefined,
      env: { ...process.env, GH_PROMPT_DISABLED: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      resolve({ code: -1, stdout, stderr: stderr + '\n' + err.message });
    });
    child.on('close', (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
    if (stdin) {
      try { child.stdin.write(stdin); child.stdin.end(); } catch (e) {}
    } else {
      try { child.stdin.end(); } catch (e) {}
    }
  });
}

function parseJsonSafe(text) {
  try { return JSON.parse(text); } catch (e) { return null; }
}

ipcMain.handle('gh:auth-status', async () => {
  const { code, stderr } = await runGh(['auth', 'status']);
  return { ok: code === 0, message: stderr.trim() };
});

// Returns { owner, name, defaultBranch, url } for the repo at `cwd`, or null.
ipcMain.handle('gh:repo-info', async (_, cwd) => {
  if (!cwd) return null;
  const { code, stdout } = await runGh(
    ['repo', 'view', '--json', 'owner,name,defaultBranchRef,url'],
    { cwd },
  );
  if (code !== 0) return null;
  const data = parseJsonSafe(stdout);
  if (!data) return null;
  return {
    owner: data.owner && data.owner.login,
    name: data.name,
    defaultBranch: data.defaultBranchRef && data.defaultBranchRef.name,
    url: data.url,
  };
});

// List the current user's open PRs in the repo at `cwd`.
ipcMain.handle('gh:pr-list', async (_, { cwd, filter } = {}) => {
  if (!cwd) return { ok: false, error: 'No project selected' };
  const args = [
    'pr', 'list',
    '--state', 'open',
    '--json', 'number,title,author,isDraft,url,updatedAt,headRefName,baseRefName,reviewDecision',
    '--limit', '50',
  ];
  if (filter === 'mine' || !filter) args.push('--author', '@me');
  const { code, stdout, stderr } = await runGh(args, { cwd });
  if (code !== 0) return { ok: false, error: stderr.trim() || 'gh pr list failed' };
  const data = parseJsonSafe(stdout) || [];
  return { ok: true, prs: data };
});

// Detail view: PR body + inline review comments + issue (top-level) comments + review summaries.
ipcMain.handle('gh:pr-detail', async (_, { cwd, number } = {}) => {
  if (!cwd || !number) return { ok: false, error: 'Missing cwd or PR number' };
  const viewArgs = [
    'pr', 'view', String(number),
    '--json', 'number,title,body,author,state,isDraft,url,baseRefName,headRefName,reviewDecision,updatedAt,createdAt',
  ];
  const [view, reviewComments, issueComments, reviews] = await Promise.all([
    runGh(viewArgs, { cwd }),
    runGh(['api', `repos/{owner}/{repo}/pulls/${number}/comments`, '--paginate'], { cwd }),
    runGh(['api', `repos/{owner}/{repo}/issues/${number}/comments`, '--paginate'], { cwd }),
    runGh(['api', `repos/{owner}/{repo}/pulls/${number}/reviews`, '--paginate'], { cwd }),
  ]);
  if (view.code !== 0) return { ok: false, error: view.stderr.trim() || 'gh pr view failed' };
  const pr = parseJsonSafe(view.stdout);
  if (!pr) return { ok: false, error: 'Unable to parse PR' };
  const reviewCommentsData = parseJsonSafe(reviewComments.stdout) || [];
  const issueCommentsData = parseJsonSafe(issueComments.stdout) || [];
  const reviewsData = parseJsonSafe(reviews.stdout) || [];
  return { ok: true, pr, reviewComments: reviewCommentsData, issueComments: issueCommentsData, reviews: reviewsData };
});

// Lookup: does the given branch have an open PR? Returns the most recent
// open PR on --head <branch>, or null. Used by the inline branch-PR chip
// so users can jump to "the PR for this branch" in one click.
ipcMain.handle('gh:pr-for-branch', async (_, { cwd, branch } = {}) => {
  if (!cwd || !branch) return { ok: false, error: 'Missing cwd or branch' };
  const { code, stderr, stdout } = await runGh(
    ['pr', 'list', '--head', branch, '--state', 'open',
      '--json', 'number,title,state,url,isDraft',
      '--limit', '1'],
    { cwd }
  );
  if (code !== 0) return { ok: false, error: stderr.trim() || 'gh pr list failed' };
  const rows = parseJsonSafe(stdout) || [];
  return { ok: true, pr: rows[0] || null };
});

// CI checks for a PR. Returns a flat list of checks with normalized
// state/conclusion and a rollup summary. Polled from the renderer when
// the PR detail view is open.
ipcMain.handle('gh:pr-checks', async (_, { cwd, number } = {}) => {
  if (!cwd || !number) return { ok: false, error: 'Missing cwd or PR number' };
  const { code, stderr, stdout } = await runGh(
    ['pr', 'checks', String(number),
      '--json', 'name,state,bucket,link,workflow,startedAt,completedAt,description'],
    { cwd }
  );
  // `gh pr checks` exits 8 when checks are still pending — not an error.
  // Anything else non-zero is a real failure.
  if (code !== 0 && code !== 8) {
    return { ok: false, error: stderr.trim() || 'gh pr checks failed' };
  }
  const rows = parseJsonSafe(stdout) || [];
  const checks = rows.map((r) => ({
    name: r.name || '',
    state: r.state || '',           // e.g. SUCCESS, FAILURE, PENDING, IN_PROGRESS, QUEUED, SKIPPED, CANCELLED
    bucket: r.bucket || '',         // pass | fail | pending | skipping | cancel
    link: r.link || '',
    workflow: r.workflow || '',
    startedAt: r.startedAt || '',
    completedAt: r.completedAt || '',
    description: r.description || '',
  }));
  const summary = { pass: 0, fail: 0, pending: 0, skipping: 0, cancel: 0, other: 0, total: checks.length };
  for (const c of checks) {
    if (summary[c.bucket] != null) summary[c.bucket]++;
    else summary.other++;
  }
  return { ok: true, checks, summary, fetchedAt: Date.now() };
});

// Post a top-level PR comment (issue comment).
ipcMain.handle('gh:pr-comment', async (_, { cwd, number, body } = {}) => {
  if (!cwd || !number || !body) return { ok: false, error: 'Missing cwd, PR number, or body' };
  const { code, stderr, stdout } = await runGh(
    ['api', '--method', 'POST', `repos/{owner}/{repo}/issues/${number}/comments`, '-f', `body=${body}`],
    { cwd },
  );
  if (code !== 0) return { ok: false, error: stderr.trim() || 'gh api failed' };
  return { ok: true, comment: parseJsonSafe(stdout) };
});

// Reply to an inline review thread (in_reply_to = review comment id).
ipcMain.handle('gh:pr-reply-review', async (_, { cwd, number, inReplyTo, body } = {}) => {
  if (!cwd || !number || !inReplyTo || !body) {
    return { ok: false, error: 'Missing cwd, PR number, inReplyTo, or body' };
  }
  const { code, stderr, stdout } = await runGh(
    [
      'api', '--method', 'POST',
      `repos/{owner}/{repo}/pulls/${number}/comments`,
      '-F', `in_reply_to=${inReplyTo}`,
      '-f', `body=${body}`,
    ],
    { cwd },
  );
  if (code !== 0) return { ok: false, error: stderr.trim() || 'gh api failed' };
  return { ok: true, comment: parseJsonSafe(stdout) };
});

// ===== Filesystem IPC (workspace panel) =====
const SKIP_DIR_NAMES = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt',
  '.venv', 'venv', '__pycache__', '.DS_Store', '.turbo', '.cache',
  '.idea', '.vscode', 'target', '.gradle',
]);

const EXT_LANG = {
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript',
  '.py': 'python', '.rb': 'ruby', '.go': 'go', '.rs': 'rust',
  '.java': 'java', '.kt': 'kotlin', '.swift': 'swift',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.hpp': 'cpp',
  '.cs': 'csharp', '.php': 'php', '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash',
  '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml',
  '.xml': 'xml', '.html': 'xml', '.htm': 'xml', '.svg': 'xml',
  '.css': 'css', '.scss': 'scss', '.sass': 'scss', '.less': 'less',
  '.md': 'markdown', '.markdown': 'markdown',
  '.sql': 'sql', '.graphql': 'graphql', '.gql': 'graphql',
  '.dockerfile': 'dockerfile', '.ini': 'ini', '.env': 'ini',
  '.vue': 'xml', '.svelte': 'xml',
};

function extToLang(p) {
  const ext = path.extname(p).toLowerCase();
  if (EXT_LANG[ext]) return EXT_LANG[ext];
  const base = path.basename(p).toLowerCase();
  if (base === 'dockerfile') return 'dockerfile';
  if (base === 'makefile') return 'makefile';
  return '';
}

function isInsideAnyRoot(p, roots) {
  if (!Array.isArray(roots) || roots.length === 0) return false;
  const resolved = path.resolve(p);
  return roots.some(r => {
    if (!r) return false;
    const rr = path.resolve(r);
    return resolved === rr || resolved.startsWith(rr + path.sep);
  });
}

ipcMain.handle('fs:list-dir', async (_, roots, dirPath) => {
  if (!dirPath || !isInsideAnyRoot(dirPath, roots)) {
    throw new Error('Path not allowed');
  }
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (e) {
    throw new Error(`Cannot read directory: ${e.message}`);
  }
  const out = [];
  for (const e of entries) {
    if (SKIP_DIR_NAMES.has(e.name)) continue;
    const isDir = e.isDirectory();
    out.push({
      name: e.name,
      path: path.join(dirPath, e.name),
      isDir,
    });
  }
  out.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return out;
});

ipcMain.handle('fs:list-all-files', async (_, roots) => {
  if (!Array.isArray(roots) || roots.length === 0) return [];
  const MAX = 15000;
  const out = [];
  const walk = (rootAbs, currentAbs) => {
    if (out.length >= MAX) return;
    let entries;
    try {
      entries = fs.readdirSync(currentAbs, { withFileTypes: true });
    } catch (e) { return; }
    for (const e of entries) {
      if (out.length >= MAX) return;
      if (SKIP_DIR_NAMES.has(e.name)) continue;
      if (e.name.startsWith('.') && e.name !== '.env') continue;
      const full = path.join(currentAbs, e.name);
      if (e.isDirectory()) {
        const rel = path.relative(rootAbs, full);
        if (rel) out.push({ root: rootAbs, rel, type: 'dir' });
        walk(rootAbs, full);
      } else if (e.isFile()) {
        const rel = path.relative(rootAbs, full);
        if (rel) out.push({ root: rootAbs, rel, type: 'file' });
      }
    }
  };
  for (const root of roots) {
    if (!root) continue;
    const rootAbs = path.resolve(root);
    try {
      const stat = fs.statSync(rootAbs);
      if (!stat.isDirectory()) continue;
    } catch (e) { continue; }
    walk(rootAbs, rootAbs);
    if (out.length >= MAX) break;
  }
  return out;
});

// Content search for Cmd+Shift+F. Scans the provided roots, skipping the
// usual noise dirs, and returns up to MAX_RESULTS matching lines. One hit
// per file keeps a single noisy file from dominating results.
// Git diff for a single file vs. HEAD. Used by the file modal's Diff toggle
// to answer "what changed here?" without leaving the app.
ipcMain.handle('fs:file-diff', async (_, roots, filePath) => {
  if (!filePath || !isInsideAnyRoot(filePath, roots)) {
    return { ok: false, status: 'error', error: 'Path not allowed' };
  }
  const { spawn } = require('child_process');
  const run = (args, cwd) => new Promise((resolve) => {
    const child = spawn('git', args, { cwd, env: { ...process.env, GIT_PAGER: 'cat', LC_ALL: 'C' } });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => resolve({ code: -1, out: '', err: e.message }));
    child.on('close', (code) => resolve({ code, out, err }));
  });

  const dir = path.dirname(filePath);
  // Find the repo root; if this isn't a git repo, bail.
  const top = await run(['rev-parse', '--show-toplevel'], dir);
  if (top.code !== 0) return { ok: true, status: 'not-in-repo', diff: '', additions: 0, deletions: 0 };
  const repoRoot = top.out.trim();
  if (!repoRoot) return { ok: true, status: 'not-in-repo', diff: '', additions: 0, deletions: 0 };
  const rel = path.relative(repoRoot, filePath);

  // Check tracked/untracked status first so we can give a friendly message.
  const status = await run(['status', '--porcelain', '--', rel], repoRoot);
  const statusLine = status.out.split('\n').find((l) => l.trim()) || '';
  const statusCode = statusLine.slice(0, 2).trim();
  if (statusCode === '??') {
    return { ok: true, status: 'untracked', diff: '', additions: 0, deletions: 0 };
  }

  const diff = await run(['diff', '--no-color', 'HEAD', '--', rel], repoRoot);
  if (diff.code !== 0 && diff.err) {
    return { ok: false, status: 'error', error: diff.err.trim() };
  }
  const text = diff.out || '';
  if (!text.trim()) {
    return { ok: true, status: 'clean', diff: '', additions: 0, deletions: 0 };
  }
  let additions = 0, deletions = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  return { ok: true, status: 'modified', diff: text, additions, deletions };
});

ipcMain.handle('fs:search-content', async (_, roots, query) => {
  const out = { results: [], filesScanned: 0, truncated: false };
  if (!Array.isArray(roots) || !roots.length) return out;
  const q = String(query || '');
  if (!q) return out;

  const MAX_RESULTS = 300;
  const MAX_FILES = 4000;
  const MAX_FILE_BYTES = 512 * 1024;
  const NULL_BYTE = String.fromCharCode(0);
  const needle = q.toLowerCase();

  const walk = (rootAbs, currentAbs) => {
    if (out.truncated) return;
    let entries;
    try { entries = fs.readdirSync(currentAbs, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      if (out.truncated) return;
      if (SKIP_DIR_NAMES.has(e.name)) continue;
      if (e.name.startsWith('.') && e.name !== '.env') continue;
      const full = path.join(currentAbs, e.name);
      if (e.isDirectory()) { walk(rootAbs, full); continue; }
      if (!e.isFile()) continue;
      if (out.filesScanned >= MAX_FILES) { out.truncated = true; return; }
      out.filesScanned++;
      let stat;
      try { stat = fs.statSync(full); } catch (err) { continue; }
      if (stat.size > MAX_FILE_BYTES) continue;
      let content;
      try { content = fs.readFileSync(full, 'utf8'); } catch (err) { continue; }
      if (content.indexOf(NULL_BYTE) !== -1) continue;
      const lc = content.toLowerCase();
      const hit = lc.indexOf(needle);
      if (hit === -1) continue;
      // Map absolute offset to (line, col); one match per file is enough for
      // the spotlight result list — previews reveal the context.
      const lines = content.split('\n');
      let cursor = 0;
      let lineIdx = 0;
      while (lineIdx < lines.length && cursor + lines[lineIdx].length < hit) {
        cursor += lines[lineIdx].length + 1;
        lineIdx++;
      }
      const col = hit - cursor;
      const lineText = lines[lineIdx] || '';
      const ctxStart = Math.max(0, lineIdx - 2);
      const ctxEnd = Math.min(lines.length, lineIdx + 3);
      out.results.push({
        root: rootAbs,
        rel: path.relative(rootAbs, full),
        line: lineIdx + 1,
        col: col + 1,
        text: lineText.length > 400 ? lineText.slice(0, 400) : lineText,
        ctxStart: ctxStart + 1,
        ctxLines: lines.slice(ctxStart, ctxEnd),
      });
      if (out.results.length >= MAX_RESULTS) { out.truncated = true; return; }
    }
  };

  for (const root of roots) {
    if (!root) continue;
    const rootAbs = path.resolve(root);
    try {
      const stat = fs.statSync(rootAbs);
      if (!stat.isDirectory()) continue;
    } catch (err) { continue; }
    walk(rootAbs, rootAbs);
    if (out.truncated) break;
  }
  return out;
});

ipcMain.handle('fs:read-file', async (_, roots, filePath) => {
  if (!filePath || !isInsideAnyRoot(filePath, roots)) {
    throw new Error('Path not allowed');
  }
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (e) {
    throw new Error(`Cannot stat file: ${e.message}`);
  }
  if (stat.isDirectory()) throw new Error('Is a directory');
  const MAX_BYTES = 2 * 1024 * 1024;
  if (stat.size > MAX_BYTES) {
    return { tooLarge: true, size: stat.size, lang: extToLang(filePath) };
  }
  const fd = fs.openSync(filePath, 'r');
  try {
    const sniffLen = Math.min(4096, stat.size);
    const sniff = Buffer.alloc(sniffLen);
    if (sniffLen > 0) fs.readSync(fd, sniff, 0, sniffLen, 0);
    for (let i = 0; i < sniffLen; i++) {
      if (sniff[i] === 0) {
        return { binary: true, size: stat.size };
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  const content = fs.readFileSync(filePath, 'utf8');
  return { content, size: stat.size, lang: extToLang(filePath) };
});

ipcMain.handle('fs:path-info', async (_, roots, p) => {
  if (!p || !isInsideAnyRoot(p, roots)) {
    return { exists: false };
  }
  try {
    const stat = fs.statSync(p);
    return { exists: true, isDir: stat.isDirectory(), size: stat.size };
  } catch (e) {
    return { exists: false };
  }
});

// ===== Context memory (renderer access) =====
ipcMain.handle('context:recall', async (_, args) => {
  try { return contextRecall(args || {}); }
  catch (e) { return { memories: [], error: e.message }; }
});

ipcMain.handle('context:forget', async (_, args) => {
  try { return contextForget(args || {}); }
  catch (e) { return { deleted: false, error: e.message }; }
});

// ===== Git branch =====
const { execFile } = require('child_process');
const branchWatchers = new Map(); // cwd -> fs.FSWatcher

function getGitBranch(cwd) {
  return new Promise((resolve) => {
    if (!cwd || !fs.existsSync(cwd)) return resolve(null);
    execFile('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 2000 }, (err, stdout) => {
      if (err) return resolve(null);
      const branch = stdout.trim();
      resolve(branch && branch !== 'HEAD' ? branch : null);
    });
  });
}

ipcMain.handle('git:branch', async (_, cwd) => getGitBranch(cwd));

ipcMain.on('git:watch', (event, { cwd }) => {
  if (!cwd || branchWatchers.has(cwd)) return;
  const headPath = path.join(cwd, '.git', 'HEAD');
  if (!fs.existsSync(headPath)) return;
  try {
    const w = fs.watch(headPath, { persistent: false }, async () => {
      const branch = await getGitBranch(cwd);
      if (!event.sender.isDestroyed()) {
        event.sender.send('git:branch-changed', { cwd, branch });
      }
    });
    branchWatchers.set(cwd, w);
  } catch (e) {}
});

ipcMain.on('git:unwatch', (_, { cwd }) => {
  const w = branchWatchers.get(cwd);
  if (w) {
    try { w.close(); } catch (e) {}
    branchWatchers.delete(cwd);
  }
});

// ===== Git Worktree =====
const WORKTREES_ROOT = path.join(os.homedir(), '.claude-code-gui', 'worktrees');

function runGit(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 15000 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        err.stdout = stdout;
        return reject(err);
      }
      resolve({ stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

async function isGitRepo(cwd) {
  if (!cwd || !fs.existsSync(cwd)) return false;
  try {
    await runGit(['-C', cwd, 'rev-parse', '--git-dir'], cwd);
    return true;
  } catch (e) {
    return false;
  }
}

async function worktreeStatus(worktreePath) {
  if (!worktreePath || !fs.existsSync(worktreePath)) {
    return { exists: false, dirty: false, unpushed: false };
  }
  let dirty = false, unpushed = false;
  try {
    const { stdout } = await runGit(['-C', worktreePath, 'status', '--porcelain'], worktreePath);
    dirty = stdout.trim().length > 0;
  } catch (e) {}
  try {
    const { stdout } = await runGit(['-C', worktreePath, 'log', '@{u}..', '--oneline'], worktreePath);
    unpushed = stdout.trim().length > 0;
  } catch (e) {
    unpushed = false; // no upstream is fine, but unpushed commits on a branch with no upstream still exist — check against main ref
    try {
      const { stdout } = await runGit(['-C', worktreePath, 'rev-list', '--count', 'HEAD', '^origin/HEAD'], worktreePath);
      unpushed = parseInt(stdout.trim(), 10) > 0;
    } catch (e2) {
      // no origin/HEAD; treat as "has commits, no remote" — be conservative and say unpushed if there are any commits beyond the fork point
      unpushed = false;
    }
  }
  return { exists: true, dirty, unpushed };
}

ipcMain.handle('worktree:add', async (_, { projectPath, convId, branch }) => {
  if (!projectPath || !convId || !branch) throw new Error('projectPath, convId, branch required');
  if (!(await isGitRepo(projectPath))) throw new Error('Not a git repository');
  const safeBranch = String(branch).trim();
  if (!safeBranch || /[\s~^:?*\[\\]/.test(safeBranch)) throw new Error('Invalid branch name');
  const worktreePath = path.join(WORKTREES_ROOT, convId);
  try { fs.mkdirSync(path.dirname(worktreePath), { recursive: true }); } catch (e) {}
  if (fs.existsSync(worktreePath)) throw new Error('Worktree path already exists: ' + worktreePath);
  try {
    await runGit(['-C', projectPath, 'worktree', 'add', worktreePath, '-b', safeBranch], projectPath);
  } catch (e) {
    const msg = (e.stderr || e.message || '').toString().trim();
    throw new Error(msg || 'git worktree add failed');
  }
  return { worktreePath, branch: safeBranch };
});

ipcMain.handle('worktree:status', async (_, { worktreePath }) => {
  return worktreeStatus(worktreePath);
});

ipcMain.handle('worktree:remove', async (_, { worktreePath, force }) => {
  if (!worktreePath) throw new Error('worktreePath required');
  if (!force) {
    const st = await worktreeStatus(worktreePath);
    if (st.dirty || st.unpushed) throw new Error('Worktree has uncommitted or unpushed changes');
  }
  try {
    await runGit(['worktree', 'remove', worktreePath, '--force'], worktreePath);
  } catch (e) {
    // Fallback: prune + rmdir if the git metadata is broken
    try { await runGit(['worktree', 'prune'], os.homedir()); } catch (e2) {}
    try { fs.rmSync(worktreePath, { recursive: true, force: true }); } catch (e2) {}
  }
  return { removed: !fs.existsSync(worktreePath) };
});

// ===== Terminal (PTY) =====
// Terminals are keyed by a `termId` — a UUID per tab, decoupled from convId
// so a single chat can own many terminal tabs.
ipcMain.on('terminal:open', (event, { termId, cwd, cols, rows }) => {
  if (!termId) return;
  if (terminals.has(termId)) return;
  const shell = process.env.SHELL
    || (process.platform === 'win32' ? 'powershell.exe' : '/bin/bash');
  const startDir = (cwd && fs.existsSync(cwd)) ? cwd : os.homedir();
  let p;
  try {
    p = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 24,
      cwd: startDir,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    });
  } catch (e) {
    event.sender.send('terminal:exit', { termId, code: -1, error: e.message });
    return;
  }
  const entry = { pty: p, webContents: event.sender };
  terminals.set(termId, entry);
  p.onData((data) => {
    if (!event.sender.isDestroyed()) {
      event.sender.send('terminal:data', { termId, data });
    }
  });
  p.onExit(({ exitCode }) => {
    if (!event.sender.isDestroyed()) {
      event.sender.send('terminal:exit', { termId, code: exitCode });
    }
    terminals.delete(termId);
  });
});

ipcMain.on('terminal:input', (_, { termId, data }) => {
  const t = terminals.get(termId);
  if (t) {
    try { t.pty.write(data); } catch (e) {}
  }
});

ipcMain.on('terminal:resize', (_, { termId, cols, rows }) => {
  const t = terminals.get(termId);
  if (!t) return;
  try { t.pty.resize(cols || 80, rows || 24); } catch (e) {}
});

ipcMain.on('terminal:kill', (_, { termId }) => {
  const t = terminals.get(termId);
  if (t) {
    try { t.pty.kill(); } catch (e) {}
    terminals.delete(termId);
  }
});

ipcMain.handle('terminal:exists', async (_, { termId }) => terminals.has(termId));

// ===== Claude CLI Integration =====
ipcMain.on('claude:send-prompt', (event, data) => {
  const { convId, prompt, sessionId, isFirst, yolo, projectPath, model, extraDirs, effort } = data;
  if (!convId) return;

  const existing = claudeProcesses.get(convId);
  if (existing) {
    try { existing.kill('SIGTERM'); } catch (e) {}
    claudeProcesses.delete(convId);
  }

  const claudeBin = findClaudeBinary();
  const args = buildClaudeArgs(
    { sessionId, isFirst, yolo, mcpConfigPath, model, extraDirs, effort },
    (p) => fs.existsSync(p)
  );

  const cwd = (projectPath && fs.existsSync(projectPath)) ? projectPath : undefined;

  const child = spawn(claudeBin, args, {
    cwd,
    env: {
      ...process.env,
      CLAUDE_GUI_CONV_ID: convId,
      PATH: [
        process.env.PATH,
        path.join(os.homedir(), '.local', 'bin'),
        '/usr/local/bin'
      ].filter(Boolean).join(':')
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  claudeProcesses.set(convId, child);

  child.stdin.write(prompt);
  child.stdin.end();

  let buffer = '';

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        processStreamEvent(event, convId, obj);
      } catch (e) {
        // Skip malformed JSON
      }
    }
  });

  child.stderr.on('data', (data) => {
    const text = data.toString().trim();
    if (shouldSurfaceStderr(text)) {
      event.sender.send('claude:stream-error', { convId, error: text });
    }
  });

  child.on('close', (code) => {
    if (buffer.trim()) {
      try {
        processStreamEvent(event, convId, JSON.parse(buffer));
      } catch (e) {}
    }
    if (claudeProcesses.get(convId) === child) claudeProcesses.delete(convId);
    event.sender.send('claude:stream-close', { convId, code });
  });

  child.on('error', (err) => {
    if (claudeProcesses.get(convId) === child) claudeProcesses.delete(convId);
    event.sender.send('claude:stream-error', { convId, error: err.message });
  });
});

function processStreamEvent(event, convId, obj) {
  for (const { channel, payload } of processStreamEventPure(obj)) {
    event.sender.send(channel, { convId, ...payload });
  }
}

// ===== App state (conversations + settings) =====
ipcMain.handle('state:load', async () => {
  try { return stateStore.loadAll(contextDb); }
  catch (e) { return { conversations: [], settings: {} }; }
});

ipcMain.handle('state:save', async (_, payload) => {
  try { stateStore.saveAll(contextDb, payload || {}); return { ok: true }; }
  catch (e) { return { ok: false, error: String(e && e.message || e) }; }
});

ipcMain.handle('state:save-conversation', async (_, payload) => {
  try {
    if (!payload || !payload.conversation) return { ok: false, error: 'no conversation' };
    stateStore.upsertConversation(contextDb, payload.conversation, payload.position);
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
});

ipcMain.handle('state:delete-conversation', async (_, payload) => {
  try {
    stateStore.deleteConversation(contextDb, payload && payload.id);
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
});

ipcMain.handle('state:set-setting', async (_, payload) => {
  try {
    stateStore.setSetting(contextDb, payload && payload.key, payload && payload.value);
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
});

ipcMain.handle('commands:list', async (_, payload) => {
  const projectPath = (payload && payload.projectPath) || null;
  try {
    return listSlashCommands({ projectPath });
  } catch (e) {
    return [];
  }
});

// ===== Auto-mode =====
//
// Poller + IPC for "auto" features: pick up issues assigned to me, draft
// replies to PR comments, draft reviews on PRs requesting me, watch CI on
// auto-opened PRs. Posting to GitHub always goes through a draft → click flow;
// the loop never auto-posts on the user's behalf.

const AUTO_DEFAULT_CONFIG = {
  enabled: false,
  intervalSec: 180,            // 3-minute poll cadence
  streams: {
    issues: true,
    comments: true,
    reviews: true,
    ciWatch: true,
  },
  includeTeamReviews: true,    // include PRs where my TEAM was requested as reviewer
};

const autoState = {
  config: AUTO_DEFAULT_CONFIG,
  login: null,
  pollTimer: null,
  inflight: false,
  // last successful poll snapshots, for the renderer to read
  lastPollAt: 0,
  items: { issues: [], commentThreads: [], reviewRequests: [] },
};

function getAutoConfig() {
  try {
    const { settings } = stateStore.loadAll(contextDb);
    if (settings && settings.autoMode && typeof settings.autoMode === 'object') {
      // Merge with defaults so newly-added fields don't break existing configs.
      return {
        ...AUTO_DEFAULT_CONFIG,
        ...settings.autoMode,
        streams: { ...AUTO_DEFAULT_CONFIG.streams, ...(settings.autoMode.streams || {}) },
      };
    }
  } catch (e) {}
  return AUTO_DEFAULT_CONFIG;
}

function setAutoConfig(next) {
  const merged = {
    ...AUTO_DEFAULT_CONFIG,
    ...next,
    streams: { ...AUTO_DEFAULT_CONFIG.streams, ...(next.streams || {}) },
  };
  stateStore.setSetting(contextDb, 'autoMode', merged);
  autoState.config = merged;
  schedulePoll();
}

async function ghWhoami() {
  if (autoState.login) return autoState.login;
  const { code, stdout } = await runGh(['api', 'user', '--jq', '.login']);
  if (code !== 0) return null;
  const login = stdout.trim();
  if (login) autoState.login = login;
  return login || null;
}

async function ghListAssignedIssues(login) {
  // Cross-repo search: open issues assigned to me, excluding PRs.
  const args = [
    'search', 'issues',
    '--assignee', login,
    '--state', 'open',
    '--json', 'number,title,body,url,repository,labels,updatedAt,state,createdAt,author',
    '--limit', '50',
  ];
  const { code, stdout } = await runGh(args);
  if (code !== 0) return [];
  const rows = parseJsonSafe(stdout) || [];
  // gh search issues returns both issues and PRs unless --type is set; keep
  // only true issues.
  return rows
    .filter(r => r && !r.isPullRequest && !r.pull_request)
    .map(r => ({
      number: r.number,
      title: r.title,
      body: r.body || '',
      url: r.url,
      repo: r.repository ? `${r.repository.nameWithOwner || ''}` : '',
      labels: Array.isArray(r.labels) ? r.labels.map(l => l.name) : [],
      updatedAt: r.updatedAt,
      author: r.author,
      state: (r.state || 'OPEN').toUpperCase(),
    }));
}

// `gh search prs --json` does NOT support headRefName/baseRefName (those are
// REST-only fields). Asking for them makes gh exit non-zero and we silently
// returned []. Stick to fields the search API returns and reconstruct branch
// names downstream only when the comments-stream actually needs them.
const SEARCH_PRS_JSON_FIELDS = 'number,title,body,url,repository,author,updatedAt,isDraft';

async function ghListMyOpenPRs(login) {
  const args = [
    'search', 'prs',
    '--author', login,
    '--state', 'open',
    '--json', SEARCH_PRS_JSON_FIELDS,
    '--limit', '50',
  ];
  const { code, stdout, stderr } = await runGh(args);
  if (code !== 0) {
    console.warn('ghListMyOpenPRs failed:', stderr.trim());
    return [];
  }
  return (parseJsonSafe(stdout) || []).map(r => ({
    number: r.number,
    title: r.title,
    body: r.body || '',
    url: r.url,
    repo: r.repository ? r.repository.nameWithOwner : '',
    author: r.author,
    updatedAt: r.updatedAt,
    isDraft: !!r.isDraft,
  }));
}

async function ghListReviewRequests(login) {
  const args = [
    'search', 'prs',
    '--review-requested', login,
    '--state', 'open',
    '--json', SEARCH_PRS_JSON_FIELDS,
    '--limit', '50',
  ];
  const { code, stdout, stderr } = await runGh(args);
  if (code !== 0) {
    console.warn('ghListReviewRequests failed:', stderr.trim());
    return [];
  }
  return (parseJsonSafe(stdout) || []).map(r => ({
    number: r.number,
    title: r.title,
    body: r.body || '',
    url: r.url,
    repo: r.repository ? r.repository.nameWithOwner : '',
    author: r.author,
    updatedAt: r.updatedAt,
    isDraft: !!r.isDraft,
  }));
}

// Return only the PRs where `login` appears in `requested_reviewers` directly
// (not via a team). One round-trip per PR; the queue is bounded so this is
// fine for occasional polls.
async function filterToDirectReviewRequests(prs, login) {
  if (!prs.length) return prs;
  const out = [];
  await Promise.all(prs.map(async (pr) => {
    try {
      const r = await runGh([
        'api', `repos/${pr.repo}/pulls/${pr.number}`,
        '--jq', '[.requested_reviewers[].login]',
      ]);
      if (r.code !== 0) { out.push(pr); return; } // fail-open: keep the PR
      const reviewers = parseJsonSafe(r.stdout) || [];
      if (reviewers.includes(login)) out.push(pr);
    } catch (e) {
      out.push(pr); // fail-open
    }
  }));
  // Preserve original ordering
  const order = new Map(prs.map((p, i) => [autoMode.reviewKeyForPR(p), i]));
  out.sort((a, b) => (order.get(autoMode.reviewKeyForPR(a)) || 0) - (order.get(autoMode.reviewKeyForPR(b)) || 0));
  return out;
}

async function ghPRThreads(repo, number) {
  // Returns { issueComments, reviewComments } for a PR.
  const [ic, rc] = await Promise.all([
    runGh(['api', `repos/${repo}/issues/${number}/comments`, '--paginate']),
    runGh(['api', `repos/${repo}/pulls/${number}/comments`, '--paginate']),
  ]);
  return {
    issueComments: parseJsonSafe(ic.stdout) || [],
    reviewComments: parseJsonSafe(rc.stdout) || [],
  };
}

async function ghPRReviews(repo, number) {
  const r = await runGh(['api', `repos/${repo}/pulls/${number}/reviews`, '--paginate']);
  return parseJsonSafe(r.stdout) || [];
}

async function ghPRChecks(repo, number) {
  // Use cwd-less api call so this works regardless of which repo the user is in.
  const { code, stdout } = await runGh([
    'pr', 'checks', String(number),
    '--repo', repo,
    '--json', 'name,state,bucket',
  ]);
  if (code !== 0 && code !== 8) return null;
  const rows = parseJsonSafe(stdout) || [];
  const summary = { pass: 0, fail: 0, pending: 0, skipping: 0, cancel: 0, other: 0, total: rows.length };
  for (const r of rows) {
    const b = r.bucket || '';
    if (summary[b] != null) summary[b]++;
    else summary.other++;
  }
  return { checks: rows, summary };
}

async function ghMarkReadyForReview(repo, number) {
  const { code, stderr } = await runGh(['pr', 'ready', String(number), '--repo', repo]);
  return { ok: code === 0, error: code === 0 ? null : stderr };
}

async function ghPostIssueComment(repo, number, body) {
  const { code, stderr, stdout } = await runGh(
    ['api', '--method', 'POST', `repos/${repo}/issues/${number}/comments`, '-f', `body=${body}`]
  );
  return { ok: code === 0, error: code === 0 ? null : stderr, comment: parseJsonSafe(stdout) };
}

async function ghReplyToReviewComment(repo, number, inReplyTo, body) {
  const { code, stderr, stdout } = await runGh([
    'api', '--method', 'POST',
    `repos/${repo}/pulls/${number}/comments/${inReplyTo}/replies`,
    '-f', `body=${body}`,
  ]);
  return { ok: code === 0, error: code === 0 ? null : stderr, comment: parseJsonSafe(stdout) };
}

async function ghSubmitReview(repo, number, { event, body }) {
  // event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'
  const args = [
    'api', '--method', 'POST', `repos/${repo}/pulls/${number}/reviews`,
    '-f', `event=${event || 'COMMENT'}`,
  ];
  if (body) args.push('-f', `body=${body}`);
  const { code, stderr, stdout } = await runGh(args);
  return { ok: code === 0, error: code === 0 ? null : stderr, review: parseJsonSafe(stdout) };
}

async function ghAddReviewers(repo, number, reviewers) {
  if (!reviewers || !reviewers.length) return { ok: true };
  // Distinguish team handles (org/team) vs user handles
  const teams = reviewers.filter(r => r.includes('/')).map(r => r.split('/').pop());
  const users = reviewers.filter(r => !r.includes('/'));
  const args = ['api', '--method', 'POST', `repos/${repo}/pulls/${number}/requested_reviewers`];
  if (users.length) for (const u of users) args.push('-f', `reviewers[]=${u}`);
  if (teams.length) for (const t of teams) args.push('-f', `team_reviewers[]=${t}`);
  const { code, stderr } = await runGh(args);
  return { ok: code === 0, error: code === 0 ? null : stderr };
}

// Drop items the user has explicitly dismissed. Used both at the end of a
// poll and right after a manual dismiss (so the renderer's next status read
// reflects it without waiting for the next poll).
function applyDismissFilter(items) {
  const out = {
    issues: (items.issues || []).filter(i => !autoDrafts.isDismissed(contextDb, 'issue', i.repo, i.number)),
    commentThreads: (items.commentThreads || []).filter(t => !autoDrafts.isDismissed(
      contextDb,
      t.kind === 'review' ? 'review-reply' : 'comment',
      t.repo,
      t.kind === 'review' ? t.rootId : t.prNumber,
    )),
    reviewRequests: (items.reviewRequests || []).filter(p => !autoDrafts.isDismissed(contextDb, 'review', p.repo, p.number)),
  };
  return out;
}

function broadcastItemsUpdated() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('auto:items-updated', {
    items: autoState.items,
    lastPollAt: autoState.lastPollAt,
    login: autoState.login,
  });
}

function schedulePoll() {
  if (autoState.pollTimer) {
    clearTimeout(autoState.pollTimer);
    autoState.pollTimer = null;
  }
  if (!autoState.config.enabled) return;
  const ms = Math.max(60_000, (autoState.config.intervalSec || 180) * 1000);
  autoState.pollTimer = setTimeout(() => runPoll().finally(schedulePoll), ms);
}

async function runPoll() {
  if (autoState.inflight) return;
  autoState.inflight = true;
  try {
    const login = await ghWhoami();
    if (!login) return;
    const cfg = autoState.config;
    const items = { issues: [], commentThreads: [], reviewRequests: [] };

    if (cfg.streams.issues) {
      const [issues, myPRs] = await Promise.all([
        ghListAssignedIssues(login),
        ghListMyOpenPRs(login),
      ]);
      items.issues = autoMode.selectActionableIssues({ issues, myPRs, login });
    }

    if (cfg.streams.comments) {
      const myPRs = await ghListMyOpenPRs(login);
      for (const pr of myPRs) {
        const { issueComments, reviewComments } = await ghPRThreads(pr.repo, pr.number);
        const threads = autoMode.selectUnansweredCommentThreads({ issueComments, reviewComments, login });
        for (const t of threads) {
          items.commentThreads.push({
            ...t,
            repo: pr.repo,
            prNumber: pr.number,
            prTitle: pr.title,
            prUrl: pr.url,
          });
        }
      }
    }

    if (cfg.streams.reviews) {
      let requested = await ghListReviewRequests(login);
      // Optionally drop PRs that were requested only via a team you're on.
      // GitHub's `review-requested:<user>` qualifier returns BOTH direct and
      // team-mediated requests; the user can opt out.
      if (cfg.includeTeamReviews === false) {
        requested = await filterToDirectReviewRequests(requested, login);
      }
      const reviewsByKey = {};
      for (const pr of requested) {
        reviewsByKey[autoMode.reviewKeyForPR(pr)] = await ghPRReviews(pr.repo, pr.number);
      }
      items.reviewRequests = autoMode.selectPRsNeedingReview({
        requestedPRs: requested,
        reviewsByKey,
        login,
      });
    }

    // Filter dismissed
    autoState.items = applyDismissFilter(items);
    autoState.lastPollAt = Date.now();
    broadcastItemsUpdated();
  } catch (e) {
    console.warn('auto-mode poll failed:', e && e.message);
  } finally {
    autoState.inflight = false;
  }
}

// ===== Auto-mode IPC =====

ipcMain.handle('auto:status', async () => {
  return {
    config: autoState.config,
    login: autoState.login,
    lastPollAt: autoState.lastPollAt,
    items: autoState.items,
    drafts: autoDrafts.listDrafts(contextDb),
  };
});

ipcMain.handle('auto:set-config', async (_, payload) => {
  setAutoConfig(payload || {});
  return { ok: true, config: autoState.config };
});

ipcMain.handle('auto:poll-now', async () => {
  await runPoll();
  return {
    items: autoState.items,
    lastPollAt: autoState.lastPollAt,
    drafts: autoDrafts.listDrafts(contextDb),
  };
});

ipcMain.handle('auto:dismiss', async (_, payload) => {
  const { kind, repo, targetId } = payload || {};
  if (!kind || !repo || targetId == null) return { ok: false, error: 'kind/repo/targetId required' };
  autoDrafts.dismiss(contextDb, kind, repo, targetId);
  // Update the in-memory queue immediately so the renderer's next refresh
  // (called right after this resolves) sees the item removed without waiting
  // for the next poll.
  autoState.items = applyDismissFilter(autoState.items);
  broadcastItemsUpdated();
  return { ok: true };
});

// Save / list / delete a draft. The renderer drives draft creation by running
// a Claude one-shot in the renderer process (it already owns the chat UI),
// then sends the resulting body back here for storage.
ipcMain.handle('auto:save-draft', async (_, payload) => {
  const { kind, repo, targetId, data } = payload || {};
  if (!kind || !repo || targetId == null) return { ok: false, error: 'kind/repo/targetId required' };
  const id = autoDrafts.upsertDraft(contextDb, { kind, repo, targetId, data });
  return { ok: true, id };
});

ipcMain.handle('auto:list-drafts', async () => {
  return { drafts: autoDrafts.listDrafts(contextDb) };
});

ipcMain.handle('auto:delete-draft', async (_, payload) => {
  if (!payload || !payload.id) return { ok: false, error: 'id required' };
  autoDrafts.deleteDraft(contextDb, payload.id);
  return { ok: true };
});

ipcMain.handle('auto:send-draft', async (_, payload) => {
  if (!payload || !payload.id) return { ok: false, error: 'id required' };
  const draft = autoDrafts.getDraft(contextDb, payload.id);
  if (!draft) return { ok: false, error: 'draft not found' };
  const body = (draft.data && draft.data.body) || '';
  if (!body.trim()) return { ok: false, error: 'empty body' };

  let result;
  if (draft.kind === 'comment') {
    result = await ghPostIssueComment(draft.repo, draft.targetId, body);
  } else if (draft.kind === 'review-reply') {
    const inReplyTo = (draft.data && draft.data.inReplyTo) || null;
    const prNumber = (draft.data && draft.data.prNumber) || null;
    if (!inReplyTo || !prNumber) return { ok: false, error: 'review-reply requires inReplyTo + prNumber' };
    result = await ghReplyToReviewComment(draft.repo, prNumber, inReplyTo, body);
  } else if (draft.kind === 'review') {
    const event = (draft.data && draft.data.event) || 'COMMENT';
    result = await ghSubmitReview(draft.repo, draft.targetId, { event, body });
  } else {
    return { ok: false, error: `unknown draft kind: ${draft.kind}` };
  }
  if (result.ok) {
    autoDrafts.deleteDraft(contextDb, draft.id);
  }
  return result;
});

// Open a draft PR for an issue. Caller already created the worktree and pushed
// the branch; we just open the PR with --draft. Title/body come from the LLM.
ipcMain.handle('auto:create-draft-pr', async (_, payload) => {
  const { repo, base, head, title, body } = payload || {};
  if (!repo || !title || !head) return { ok: false, error: 'repo/title/head required' };
  const args = [
    'pr', 'create',
    '--repo', repo,
    '--draft',
    '--title', title,
    '--body', body || '',
    '--head', head,
  ];
  if (base) args.push('--base', base);
  const { code, stderr, stdout } = await runGh(args);
  if (code !== 0) return { ok: false, error: stderr.trim() || 'gh pr create failed' };
  return { ok: true, url: stdout.trim() };
});

ipcMain.handle('auto:add-reviewers', async (_, payload) => {
  const { repo, number, reviewers } = payload || {};
  if (!repo || !number || !Array.isArray(reviewers)) return { ok: false, error: 'repo/number/reviewers required' };
  return ghAddReviewers(repo, number, reviewers);
});

ipcMain.handle('auto:pr-checks', async (_, payload) => {
  const { repo, number } = payload || {};
  if (!repo || !number) return { ok: false, error: 'repo/number required' };
  const out = await ghPRChecks(repo, number);
  if (!out) return { ok: false, error: 'failed to read checks' };
  return { ok: true, ...out };
});

ipcMain.handle('auto:mark-ready', async (_, payload) => {
  const { repo, number } = payload || {};
  if (!repo || !number) return { ok: false, error: 'repo/number required' };
  return ghMarkReadyForReview(repo, number);
});

ipcMain.handle('auto:pr-files', async (_, payload) => {
  const { repo, number } = payload || {};
  if (!repo || !number) return { ok: false, error: 'repo/number required' };
  const { code, stdout } = await runGh(['api', `repos/${repo}/pulls/${number}/files`, '--paginate']);
  if (code !== 0) return { ok: false, error: 'failed' };
  const files = (parseJsonSafe(stdout) || []).map(f => ({
    filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch || '',
  }));
  return { ok: true, files };
});

ipcMain.handle('auto:pr-detail', async (_, payload) => {
  const { repo, number } = payload || {};
  if (!repo || !number) return { ok: false, error: 'repo/number required' };
  const [view, threads, reviews] = await Promise.all([
    runGh(['api', `repos/${repo}/pulls/${number}`]),
    ghPRThreads(repo, number),
    ghPRReviews(repo, number),
  ]);
  if (view.code !== 0) return { ok: false, error: 'failed' };
  return {
    ok: true,
    pr: parseJsonSafe(view.stdout),
    issueComments: threads.issueComments,
    reviewComments: threads.reviewComments,
    reviews,
  };
});

ipcMain.handle('auto:pick-reviewers', async (_, payload) => {
  const { repo, number, projectPath } = payload || {};
  if (!repo || !number) return { ok: false, error: 'repo/number required' };
  const filesRes = await runGh(['api', `repos/${repo}/pulls/${number}/files`, '--paginate']);
  if (filesRes.code !== 0) return { ok: false, error: 'failed listing files' };
  const files = (parseJsonSafe(filesRes.stdout) || []).map(f => f.filename);
  // CODEOWNERS — try local checkout first, fall back to API.
  let codeowners = '';
  if (projectPath) {
    for (const sub of ['CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS']) {
      try {
        codeowners = fs.readFileSync(path.join(projectPath, sub), 'utf8');
        if (codeowners) break;
      } catch (e) {}
    }
  }
  if (!codeowners) {
    const r = await runGh(['api', `repos/${repo}/contents/.github/CODEOWNERS`, '--jq', '.content']);
    if (r.code === 0 && r.stdout.trim()) {
      try { codeowners = Buffer.from(r.stdout.trim(), 'base64').toString('utf8'); } catch (e) {}
    }
  }
  // Recent authors per file via git log, when we have a local checkout.
  const recentAuthorsByFile = {};
  if (projectPath) {
    for (const f of files.slice(0, 15)) { // cap to avoid runaway
      try {
        const { execSync } = require('child_process');
        const out = execSync(`git log --pretty=format:%an -n 5 -- "${f}"`, {
          cwd: projectPath, encoding: 'utf8', timeout: 4000,
        }).split('\n').map(s => s.trim()).filter(Boolean);
        recentAuthorsByFile[f] = Array.from(new Set(out));
      } catch (e) {}
    }
  }
  // PR author
  const prRes = await runGh(['api', `repos/${repo}/pulls/${number}`, '--jq', '.user.login']);
  const prAuthor = prRes.code === 0 ? prRes.stdout.trim() : null;
  const login = await ghWhoami();
  const reviewers = autoMode.selectReviewers({
    touchedFiles: files,
    codeowners,
    recentAuthorsByFile,
    prAuthor,
    login,
    n: 2,
  });
  return { ok: true, reviewers };
});

// ----- CI watcher (Phase 3) ----------------------------------------------
//
// For each PR the loop opened (stored in auto_watched_prs with status=watching)
// poll `gh pr checks`. When green → pick reviewers, request them, and flip
// the PR ready-for-review. The list survives restarts.

const CI_POLL_INTERVAL_MS = 90_000;
let ciWatchTimer = null;

function broadcastWatched() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('auto:watched-updated', {
    watched: autoDrafts.listWatchedPRs(contextDb),
  });
}

async function processWatchedPR(entry) {
  const checks = await ghPRChecks(entry.repo, entry.number);
  if (!checks) return;
  const summary = checks.summary || { pass: 0, fail: 0, pending: 0, total: 0 };

  if (autoMode.shouldFlipPRReadyForReview(summary)) {
    // 1. Pick reviewers (best-effort; OK if it returns []).
    let reviewers = [];
    try {
      const filesRes = await runGh(['api', `repos/${entry.repo}/pulls/${entry.number}/files`, '--paginate']);
      const files = filesRes.code === 0
        ? (parseJsonSafe(filesRes.stdout) || []).map(f => f.filename)
        : [];

      let codeowners = '';
      if (entry.projectPath) {
        for (const sub of ['CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS']) {
          try { codeowners = fs.readFileSync(path.join(entry.projectPath, sub), 'utf8'); if (codeowners) break; } catch (e) {}
        }
      }
      const recentAuthorsByFile = {};
      if (entry.projectPath) {
        const { execSync } = require('child_process');
        for (const f of files.slice(0, 15)) {
          try {
            const out = execSync(`git log --pretty=format:%an -n 5 -- "${f}"`, {
              cwd: entry.projectPath, encoding: 'utf8', timeout: 4000,
            }).split('\n').map(s => s.trim()).filter(Boolean);
            recentAuthorsByFile[f] = Array.from(new Set(out));
          } catch (e) {}
        }
      }
      const prRes = await runGh(['api', `repos/${entry.repo}/pulls/${entry.number}`, '--jq', '.user.login']);
      const prAuthor = prRes.code === 0 ? prRes.stdout.trim() : null;
      const login = await ghWhoami();
      reviewers = autoMode.selectReviewers({
        touchedFiles: files,
        codeowners,
        recentAuthorsByFile,
        prAuthor,
        login,
        n: 2,
      });
    } catch (e) {
      console.warn('reviewer selection failed:', e && e.message);
    }

    if (reviewers.length) {
      await ghAddReviewers(entry.repo, entry.number, reviewers);
    }
    const ready = await ghMarkReadyForReview(entry.repo, entry.number);
    if (ready.ok) {
      autoDrafts.setWatchedPRStatus(contextDb, entry.repo, entry.number, 'ready', Date.now());
      // Notify the renderer so it can show a celebratory line / desktop notif.
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('auto:pr-ready', {
          repo: entry.repo, number: entry.number, reviewers,
        });
      }
    } else {
      console.warn(`gh pr ready failed for ${entry.repo}#${entry.number}:`, ready.error);
      autoDrafts.setWatchedPRStatus(contextDb, entry.repo, entry.number, 'watching', Date.now());
    }
  } else if ((summary.fail || 0) > 0) {
    autoDrafts.setWatchedPRStatus(contextDb, entry.repo, entry.number, 'failed', Date.now());
  } else {
    autoDrafts.setWatchedPRStatus(contextDb, entry.repo, entry.number, 'watching', Date.now());
  }
}

async function runCIWatcherTick() {
  // Only watch when ciWatch stream is enabled.
  if (!autoState.config.enabled || !autoState.config.streams.ciWatch) return;
  const watching = autoDrafts.listWatchedPRs(contextDb, { status: 'watching' });
  if (!watching.length) return;
  for (const entry of watching) {
    try { await processWatchedPR(entry); }
    catch (e) { console.warn('processWatchedPR failed:', e && e.message); }
  }
  broadcastWatched();
}

function scheduleCIWatcher() {
  if (ciWatchTimer) { clearInterval(ciWatchTimer); ciWatchTimer = null; }
  ciWatchTimer = setInterval(() => {
    runCIWatcherTick().catch(() => {});
  }, CI_POLL_INTERVAL_MS);
}

ipcMain.handle('auto:watch-pr', async (_, payload) => {
  const { repo, number, branch, issueNumber, projectPath, title } = payload || {};
  if (!repo || !number || !branch) return { ok: false, error: 'repo/number/branch required' };
  autoDrafts.addWatchedPR(contextDb, {
    repo, number, branch, issueNumber, projectPath,
    data: { title: title || '' },
  });
  // Kick the watcher immediately so we don't wait 90s for the first tick.
  runCIWatcherTick().catch(() => {});
  return { ok: true };
});

ipcMain.handle('auto:list-watched', async () => {
  return { watched: autoDrafts.listWatchedPRs(contextDb) };
});

ipcMain.handle('auto:unwatch-pr', async (_, payload) => {
  const { repo, number } = payload || {};
  if (!repo || !number) return { ok: false, error: 'repo/number required' };
  autoDrafts.removeWatchedPR(contextDb, repo, number);
  broadcastWatched();
  return { ok: true };
});

// Initialise auto-mode on startup
function initAutoMode() {
  autoState.config = getAutoConfig();
  schedulePoll();
  scheduleCIWatcher();
}

ipcMain.on('window:focus', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

ipcMain.on('claude:stop-generation', (_, payload) => {
  const convId = (payload && payload.convId) || null;
  if (!convId) return;
  const child = claudeProcesses.get(convId);
  if (child) {
    try { child.kill('SIGTERM'); } catch (e) {}
    claudeProcesses.delete(convId);
  }
});

