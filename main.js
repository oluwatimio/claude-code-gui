const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');

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

