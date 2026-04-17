#!/usr/bin/env node
// MCP Context Server for Claude Code GUI
// Proxies remember/recall/forget tool calls to the Electron process over HTTP.
// The Electron process owns the SQLite DB; this is a thin stdio shim.

const http = require('http');
const ELECTRON_PORT = process.env.CLAUDE_GUI_PERMISSION_PORT;

process.stdin.setEncoding('utf8');
let buffer = '';

process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      handleMessage(JSON.parse(line));
    } catch (e) {
      // skip malformed
    }
  }
});

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

const TOOLS = [
  {
    name: 'remember',
    description: 'Save a memory to long-term context. Use this to record facts, decisions, preferences, or any information worth recalling in future conversations.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The memory content to store.' },
        category: { type: 'string', description: 'Optional short category (e.g. "preference", "project", "decision").' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags to aid recall.' }
      },
      required: ['content']
    }
  },
  {
    name: 'recall',
    description: 'Search stored memories. Returns most relevant entries matching the query, or the most recent entries if no query is given.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to search for in memory content/category/tags. Omit to list recent memories.' },
        limit: { type: 'number', description: 'Max results to return (default 20).' }
      }
    }
  },
  {
    name: 'forget',
    description: 'Delete a memory by ID. Use when the user asks to forget something or when the memory is obsolete.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'ID of the memory to delete (returned by remember/recall).' }
      },
      required: ['id']
    }
  }
];

async function handleMessage(msg) {
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'claude-gui-context', version: '1.0.0' }
      }
    });
  } else if (msg.method === 'notifications/initialized') {
    // no response
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
  } else if (msg.method === 'tools/call') {
    const toolName = msg.params.name;
    const args = msg.params.arguments || {};
    try {
      const result = await callElectron(`/context/${toolName}`, args);
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { content: [{ type: 'text', text: JSON.stringify(result) }] }
      });
    } catch (err) {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }],
          isError: true
        }
      });
    }
  } else if (msg.id) {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  }
}

function callElectron(path, body) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body || {});
    const req = http.request({
      hostname: '127.0.0.1',
      port: ELECTRON_PORT,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
          else resolve(parsed);
        } catch (e) {
          reject(new Error('Invalid response from GUI'));
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

process.stdin.on('end', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
