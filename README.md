# Code GUI

A beautiful desktop GUI for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Built with Electron; runs on macOS, Linux, and Windows.

Agent-first. Black, white, and green — with a light mode. Minimal. Fast.

![Electron](https://img.shields.io/badge/Electron-41-47848F?logo=electron&logoColor=white)
![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux%20%7C%20Windows-informational)
![License](https://img.shields.io/badge/License-MIT-green)

## Download

- **macOS (Apple Silicon)** — [latest DMG](https://github.com/oluwatimio/claude-code-gui/releases/latest) (signed + notarized — just drag to Applications)
- **Linux** — build locally with `npm run build:pacman` or `npm run build:appimage` (see below)
- **Intel Mac / Windows** — run from source (see below)

## Features

- **Chat interface** with conversation history and persistence
- **Light / Dark / System theme** — auto-switches with the OS
- **Workspace panel** — file tree, inline diffs, live Edits/Tools tabs so you can watch exactly what the agent touched
- **GitHub PR panel** (via `gh` CLI) — browse PRs in the current repo, read review threads + comments, reply inline, or hand a thread to chat with **Help me respond**
- **Attachments** — attach files or images (inline previews) right in the prompt
- **Per-chat git worktrees** — isolate agent work from your main checkout
- **Integrated terminal** (xterm.js) inside the app
- **Memory MCP** — save takeaways across conversations
- **Permission approvals** surfaced as UI dialogs (via `--permission-prompt-tool`)
- **Session persistence** — conversations maintain context across messages
- **Markdown rendering** with syntax-highlighted code blocks
- **Custom frameless titlebar** and resizable panels

## Prerequisites

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- Node.js v18+
- [GitHub CLI](https://cli.github.com/) (optional — only needed for the PR panel; run `gh auth login` first)
- A C/C++ toolchain for `node-pty`'s native rebuild:
  - **macOS**: Xcode Command Line Tools (`xcode-select --install`)
  - **Linux**: `build-essential` (Debian/Ubuntu) or `base-devel` (Arch)
  - **Windows**: [windows-build-tools](https://github.com/felixrieseberg/windows-build-tools) or the "Desktop development with C++" Visual Studio workload

## Run from source (macOS · Linux · Windows)

### With npm

```bash
git clone https://github.com/oluwatimio/claude-code-gui.git
cd claude-code-gui
npm install
npm start
```

### With pnpm

```bash
git clone https://github.com/oluwatimio/claude-code-gui.git
cd claude-code-gui
pnpm install
pnpm start
```

## Build packaged app (Linux)

Packaged installers currently target Linux. macOS and Windows users run from source with `npm start` / `pnpm start`.

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

### Both

```bash
npm run build
```

### macOS (optional — not wired up by default)

If you want a packaged `.app` / `.dmg` on macOS, add a `mac` target to the `build` block in `package.json`:

```json
"mac": {
  "target": ["dmg", "zip"],
  "icon": "assets/icons/",
  "category": "public.app-category.developer-tools"
}
```

Add a build script alongside the existing ones:

```json
"build:mac": "electron-builder --mac"
```

Then:

```bash
npm run build:mac
open "dist/Claude Code-1.0.0.dmg"
```

Builds produced this way aren't signed or notarized, so macOS Gatekeeper will complain on first launch. For personal use, right-click the app → **Open** to bypass, or strip the quarantine attribute:

```bash
xattr -cr "/Applications/Claude Code.app"
```

Distributing to other users requires an Apple Developer signing identity and notarization — out of scope here.

## Architecture

```
claude-code-gui/
├── main.js                    # Electron main process
│                              #   - Spawns claude -p with --session-id/--resume
│                              #   - HTTP bridge for permission approvals
│                              #   - gh CLI integration for the PR panel
│                              #   - MCP config generation (temp file)
├── preload.js                 # Context bridge (IPC + markdown rendering)
├── mcp-permission-server.js   # MCP stdio server for --permission-prompt-tool
├── mcp-context-server.js      # Memory tool MCP
├── mcp-ask-server.js          # Ask-user tool MCP
├── lib/claude-cli.js          # Pure logic (argv + stream-event parsing)
├── renderer/
│   ├── index.html             # App shell
│   ├── styles.css             # Tokens + light/dark palettes
│   └── app.js                 # UI, state, conversations, panels
├── assets/                    # App icons
└── package.json               # Build config (electron-builder)
```

### How it works

1. User sends a message in the GUI
2. `main.js` spawns `claude -p --session-id <uuid>` (first message) or `claude -p --resume <uuid>` (follow-ups)
3. The CLI's `--mcp-config` includes a permission MCP server
4. When Claude needs permission (file write, bash command, etc.), the MCP server POSTs to an HTTP bridge in the Electron main process, which shows a dialog in the UI
5. User clicks Allow/Deny, response flows back through the bridge to Claude
6. Claude's response is parsed from stream-json and rendered as markdown; tool uses update the Edits/Tools tabs live

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

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Enter` | Send message |
| `Shift+Enter` | New line |
| `Ctrl+N` | New chat |
| `Ctrl+B` | Toggle sidebar |
| `Ctrl+Shift+B` | Toggle workspace panel |
| `Ctrl+Shift+P` | Toggle PR panel |
| `Ctrl+Shift+O` | Open file (Spotlight) |
| `Ctrl+Shift+F` | Search file contents (Spotlight) |
| `` Ctrl+` `` | Toggle terminal |
| `Escape` | Stop generation |

## License

MIT — see [LICENSE](./LICENSE).
