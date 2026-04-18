#!/usr/bin/env node
// MCP Permission Server for Claude Code GUI
// Runs as a stdio MCP server spawned by Claude CLI.
// Communicates with the Electron app via HTTP to surface permission dialogs.
//
// Response schema (union):
//   Allow: { "updatedInput": { ...original or modified input... } }
//   Deny:  { "behavior": "deny", "message": "reason string" }

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

async function handleMessage(msg) {
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'claude-gui-permissions', version: '1.0.0' }
      }
    });
  } else if (msg.method === 'notifications/initialized') {
    // no response needed
  } else if (msg.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        tools: [{
          name: 'approve_permission',
          description: 'Handle permission approval requests from Claude Code GUI',
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: true
          }
        }]
      }
    });
  } else if (msg.method === 'tools/call') {
    const args = msg.params.arguments || {};
    const toolInput = args.input || {};

    try {
      const enriched = { ...args, conv_id: process.env.CLAUDE_GUI_CONV_ID || null };
      const guiResponse = await askElectronApp(enriched);

      let responsePayload;
      if (guiResponse.behavior === 'deny') {
        responsePayload = {
          behavior: 'deny',
          message: guiResponse.message || 'User denied permission'
        };
      } else {
        responsePayload = {
          behavior: 'allow',
          updatedInput: guiResponse.updatedInput || toolInput
        };
      }

      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(responsePayload) }]
        }
      });
    } catch (err) {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          content: [{ type: 'text', text: JSON.stringify({ behavior: 'deny', message: err.message }) }]
        }
      });
    }
  } else if (msg.id) {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  }
}

function askElectronApp(permissionData) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(permissionData);
    const req = http.request({
      hostname: '127.0.0.1',
      port: ELECTRON_PORT,
      path: '/permission',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error('Invalid response from GUI'));
        }
      });
    });
    req.on('error', (err) => reject(err));
    req.write(postData);
    req.end();
  });
}

process.stdin.on('end', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
