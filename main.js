const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const pty = require('node-pty');

const terminals = new Map(); // sessionId -> { pty, webContents }

let mainWindow;
let currentProcess = null;
let permissionServer = null;
let permissionPort = null;
let pendingPermission = null;
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
          pendingPermission = res;
          mainWindow.webContents.send('permission:request', {
            toolName: data.tool_name || 'Unknown',
            input: data.input || {},
            toolUseId: data.tool_use_id || ''
          });
        } catch (e) {
          writeJson(res, 400, { behavior: 'deny', reason: 'Bad request' });
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
ipcMain.on('permission:response', (_, decision) => {
  if (pendingPermission) {
    pendingPermission.writeHead(200, { 'Content-Type': 'application/json' });
    pendingPermission.end(JSON.stringify(decision));
    pendingPermission = null;
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
});

// ===== Context memory (SQLite) =====
function openContextDb() {
  const userData = app.getPath('userData');
  fs.mkdirSync(userData, { recursive: true });
  const dbPath = path.join(userData, 'context.db');
  contextDb = new DatabaseSync(dbPath);
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
      }
    }
  };

  mcpConfigPath = path.join(os.tmpdir(), `claude-gui-mcp-${process.pid}.json`);
  fs.writeFileSync(mcpConfigPath, JSON.stringify(config, null, 2));
}

function cleanup() {
  if (currentProcess) currentProcess.kill('SIGTERM');
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

// ===== Terminal (PTY) =====
ipcMain.on('terminal:open', (event, { sessionId, cwd, cols, rows }) => {
  if (!sessionId) return;
  if (terminals.has(sessionId)) return;
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
    event.sender.send('terminal:exit', { sessionId, code: -1, error: e.message });
    return;
  }
  const entry = { pty: p, webContents: event.sender };
  terminals.set(sessionId, entry);
  p.onData((data) => {
    if (!event.sender.isDestroyed()) {
      event.sender.send('terminal:data', { sessionId, data });
    }
  });
  p.onExit(({ exitCode }) => {
    if (!event.sender.isDestroyed()) {
      event.sender.send('terminal:exit', { sessionId, code: exitCode });
    }
    terminals.delete(sessionId);
  });
});

ipcMain.on('terminal:input', (_, { sessionId, data }) => {
  const t = terminals.get(sessionId);
  if (t) {
    try { t.pty.write(data); } catch (e) {}
  }
});

ipcMain.on('terminal:resize', (_, { sessionId, cols, rows }) => {
  const t = terminals.get(sessionId);
  if (!t) return;
  try { t.pty.resize(cols || 80, rows || 24); } catch (e) {}
});

ipcMain.on('terminal:kill', (_, { sessionId }) => {
  const t = terminals.get(sessionId);
  if (t) {
    try { t.pty.kill(); } catch (e) {}
    terminals.delete(sessionId);
  }
});

ipcMain.handle('terminal:exists', async (_, { sessionId }) => terminals.has(sessionId));

// ===== Claude CLI Integration =====
ipcMain.on('claude:send-prompt', (event, data) => {
  const { prompt, sessionId, isFirst, yolo, projectPath, model, extraDirs } = data;

  if (currentProcess) {
    currentProcess.kill('SIGTERM');
    currentProcess = null;
  }

  const claudeBin = findClaudeBinary();
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--mcp-config', mcpConfigPath,
  ];

  if (yolo) {
    args.push('--dangerously-skip-permissions');
  } else {
    args.push('--permission-prompt-tool', 'mcp__gui_permissions__approve_permission');
  }

  if (model) {
    args.push('--model', model);
  }

  if (Array.isArray(extraDirs) && extraDirs.length) {
    const valid = extraDirs.filter(d => d && fs.existsSync(d));
    if (valid.length) {
      args.push('--add-dir', ...valid);
    }
  }

  if (sessionId) {
    if (isFirst) {
      args.push('--session-id', sessionId);
    } else {
      args.push('--resume', sessionId);
    }
  }

  const cwd = (projectPath && fs.existsSync(projectPath)) ? projectPath : undefined;

  const child = spawn(claudeBin, args, {
    cwd,
    env: {
      ...process.env,
      PATH: [
        process.env.PATH,
        path.join(os.homedir(), '.local', 'bin'),
        '/usr/local/bin'
      ].filter(Boolean).join(':')
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  currentProcess = child;

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
        processStreamEvent(event, obj);
      } catch (e) {
        // Skip malformed JSON
      }
    }
  });

  child.stderr.on('data', (data) => {
    const text = data.toString();
    if (text.includes('Error') || text.includes('error')) {
      event.sender.send('claude:stream-error', text);
    }
  });

  child.on('close', (code) => {
    if (buffer.trim()) {
      try {
        processStreamEvent(event, JSON.parse(buffer));
      } catch (e) {}
    }
    currentProcess = null;
    event.sender.send('claude:stream-close', { code });
  });

  child.on('error', (err) => {
    currentProcess = null;
    event.sender.send('claude:stream-error', err.message);
  });
});

function processStreamEvent(event, obj) {
  if (obj.type === 'assistant' && obj.message) {
    const content = obj.message.content || [];
    for (const block of content) {
      if (block.type === 'text' && block.text) {
        event.sender.send('claude:stream-delta', { text: block.text });
      }
      if (block.type === 'thinking' && block.thinking) {
        event.sender.send('claude:thinking-delta', { text: block.thinking });
      }
      if (block.type === 'tool_use') {
        event.sender.send('claude:tool-use', {
          name: block.name,
          input: block.input
        });
      }
    }
  } else if (obj.type === 'result') {
    event.sender.send('claude:stream-end', {
      result: obj.result,
      cost: obj.total_cost_usd,
      duration: obj.duration_ms,
      model: Object.keys(obj.modelUsage || {})[0] || ''
    });
  }
}

ipcMain.on('claude:stop-generation', () => {
  if (currentProcess) {
    currentProcess.kill('SIGTERM');
    currentProcess = null;
  }
});

