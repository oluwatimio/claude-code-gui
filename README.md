# Claude Code GUI

A beautiful desktop GUI for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) on Linux. Built with Electron.

Black, white, and green. Minimal. Fast.

![Electron](https://img.shields.io/badge/Electron-41-47848F?logo=electron&logoColor=white)
![Platform](https://img.shields.io/badge/Platform-Linux-FCC624?logo=linux&logoColor=black)
![License](https://img.shields.io/badge/License-MIT-green)

## Features

- **Chat interface** with conversation history and persistence
- **Markdown rendering** with syntax-highlighted code blocks (highlight.js)
- **Permission approvals** surfaced as UI dialogs (via `--permission-prompt-tool`)
- **Session persistence** - conversations maintain context across messages
- **Copy code blocks** with one click
- **Keyboard shortcuts** - Enter to send, Ctrl+N new chat, Ctrl+B toggle sidebar, Escape to stop
- **Custom titlebar** with frameless window
- **Packaged for Arch Linux** (pacman) and AppImage

## Prerequisites

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- Node.js (v18+)
- npm

## Quick Start (Development)

```bash
git clone <repo-url>
cd claude-code-gui
npm install
npm start
```

## Build & Install

### Arch Linux (pacman)

```bash
npm run build:pacman
sudo pacman -U dist/claude-code-gui-1.0.0.pacman
```

The app will appear in your application launcher as **Claude Code**.

### AppImage (portable)

```bash
npm run build:appimage
chmod +x dist/Claude\ Code-1.0.0.AppImage
./dist/Claude\ Code-1.0.0.AppImage
```

### Build both

```bash
npm run build
```

## Architecture

```
claude-code-gui/
├── main.js                    # Electron main process
│                              #   - Spawns claude -p with --session-id/--resume
│                              #   - HTTP bridge for permission approvals
│                              #   - MCP config generation (temp file)
├── preload.js                 # Context bridge (IPC + markdown rendering)
├── mcp-permission-server.js   # MCP stdio server for --permission-prompt-tool
├── renderer/
│   ├── index.html             # App shell
│   ├── styles.css             # Dark theme (black/white/green)
│   └── app.js                 # UI logic, state, conversations
├── assets/
│   ├── icon.svg               # App icon source
│   ├── icon.png               # 512px icon
│   └── icons/                 # All sizes for packaging
└── package.json               # Build config (electron-builder)
```

### How it works

1. User sends a message in the GUI
2. `main.js` spawns `claude -p --session-id <uuid>` (first message) or `claude -p --resume <uuid>` (follow-ups)
3. The CLI's `--mcp-config` includes a permission MCP server
4. When Claude needs permission (file write, bash command, etc.), the MCP server POSTs to an HTTP bridge in the Electron main process, which shows a dialog in the UI
5. User clicks Allow/Deny, response flows back through the bridge to Claude
6. Claude's response is parsed from stream-json and rendered as markdown

### Permission prompt protocol

The `--permission-prompt-tool` MCP tool receives:

```json
{ "tool_name": "Bash", "input": { "command": "..." }, "tool_use_id": "..." }
```

And must return (as text content):

```json
// Allow:
{ "behavior": "allow", "updatedInput": { "command": "..." } }

// Deny:
{ "behavior": "deny", "message": "User denied permission" }
```

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Enter` | Send message |
| `Shift+Enter` | New line |
| `Ctrl+N` | New chat |
| `Ctrl+B` | Toggle sidebar |
| `Escape` | Stop generation |

## License

MIT
