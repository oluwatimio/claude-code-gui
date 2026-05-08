// Discover Claude Code slash commands (the kind that work with `claude -p "/foo"`).
// We look in:
//   - ~/.claude/commands/*.md          (user)
//   - <projectPath>/.claude/commands/*.md (project)
//   - <pluginInstallPath>/commands/*.md for each installed plugin
//
// Built-in slash commands (/help, /clear, /model, ...) are intentionally
// excluded — Claude CLI rejects them in -p mode.

const fs = require('fs');
const path = require('path');
const os = require('os');

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

function parseCommandFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return null;
  }

  let description = '';
  let argHint = '';
  const fmMatch = raw.match(FRONTMATTER_RE);
  if (fmMatch) {
    const fm = fmMatch[1];
    const descMatch = fm.match(/^description\s*:\s*(.+)$/m);
    if (descMatch) description = descMatch[1].trim().replace(/^["']|["']$/g, '');
    const argMatch = fm.match(/^argument-hint\s*:\s*(.+)$/m);
    if (argMatch) argHint = argMatch[1].trim().replace(/^["']|["']$/g, '');
  }
  if (!description) {
    // Fall back to the first non-empty, non-frontmatter line.
    const body = fmMatch ? raw.slice(fmMatch[0].length) : raw;
    const firstLine = body.split('\n').map(l => l.trim()).find(Boolean) || '';
    description = firstLine.replace(/^#+\s*/, '').slice(0, 140);
  }

  const name = path.basename(filePath, '.md');
  return { name, path: filePath, description, argHint };
}

function listMdFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return [];
  }
  return entries
    .filter(e => e.isFile() && e.name.endsWith('.md'))
    .map(e => path.join(dir, e.name));
}

function loadInstalledPlugins(claudeDir) {
  try {
    const file = path.join(claudeDir, 'plugins', 'installed_plugins.json');
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    const installs = [];
    if (data && data.plugins && typeof data.plugins === 'object') {
      for (const key of Object.keys(data.plugins)) {
        const arr = data.plugins[key];
        if (!Array.isArray(arr)) continue;
        for (const inst of arr) {
          if (inst && typeof inst.installPath === 'string') {
            installs.push({ key, installPath: inst.installPath });
          }
        }
      }
    }
    return installs;
  } catch (e) {
    return [];
  }
}

// Returns [{ name, source, path, description, argHint }]
// `source` is one of: 'user' | 'project' | `plugin:<name>`
function listSlashCommands(opts = {}) {
  const home = opts.home || os.homedir();
  const claudeDir = path.join(home, '.claude');
  const out = [];
  const seen = new Set(); // names already added (project shadows user shadows plugin)

  function addAll(dir, source) {
    for (const f of listMdFiles(dir)) {
      const parsed = parseCommandFile(f);
      if (!parsed) continue;
      if (seen.has(parsed.name)) continue;
      seen.add(parsed.name);
      out.push({ ...parsed, source });
    }
  }

  // Project commands win — load first so they shadow user/plugin commands of the same name.
  if (opts.projectPath && typeof opts.projectPath === 'string') {
    addAll(path.join(opts.projectPath, '.claude', 'commands'), 'project');
  }

  // User commands.
  addAll(path.join(claudeDir, 'commands'), 'user');

  // Plugin commands.
  for (const { key, installPath } of loadInstalledPlugins(claudeDir)) {
    const pluginName = key.split('@')[0] || key;
    addAll(path.join(installPath, 'commands'), `plugin:${pluginName}`);
  }

  // Sort by name for stable display.
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

module.exports = {
  listSlashCommands,
  parseCommandFile,
  listMdFiles,
  loadInstalledPlugins,
};
