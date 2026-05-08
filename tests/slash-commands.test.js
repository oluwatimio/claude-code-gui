const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { listSlashCommands, parseCommandFile } = require('../lib/slash-commands');

function mktmpHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgui-slash-'));
  fs.mkdirSync(path.join(dir, '.claude', 'commands'), { recursive: true });
  return dir;
}

test('parseCommandFile: extracts description from frontmatter', () => {
  const dir = mktmpHome();
  const file = path.join(dir, '.claude', 'commands', 'foo.md');
  fs.writeFileSync(file, '---\ndescription: Do the thing\nargument-hint: <name>\n---\n\nbody here\n');
  const out = parseCommandFile(file);
  assert.equal(out.name, 'foo');
  assert.equal(out.description, 'Do the thing');
  assert.equal(out.argHint, '<name>');
});

test('parseCommandFile: falls back to first body line when no frontmatter', () => {
  const dir = mktmpHome();
  const file = path.join(dir, '.claude', 'commands', 'bar.md');
  fs.writeFileSync(file, '# Heading\n\nbody first line\n\nrest\n');
  const out = parseCommandFile(file);
  assert.equal(out.name, 'bar');
  // First non-empty line, with leading hashes stripped
  assert.equal(out.description, 'Heading');
});

test('listSlashCommands: lists user commands and parses descriptions', () => {
  const home = mktmpHome();
  fs.writeFileSync(
    path.join(home, '.claude', 'commands', 'sync.md'),
    '---\ndescription: Sync stuff\n---\nbody\n'
  );
  fs.writeFileSync(
    path.join(home, '.claude', 'commands', 'review.md'),
    '---\ndescription: Review code\n---\nbody\n'
  );
  const out = listSlashCommands({ home });
  assert.equal(out.length, 2);
  // Sorted
  assert.equal(out[0].name, 'review');
  assert.equal(out[1].name, 'sync');
  assert.equal(out[0].source, 'user');
  assert.equal(out[0].description, 'Review code');
});

test('listSlashCommands: project commands shadow user commands of same name', () => {
  const home = mktmpHome();
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'cgui-proj-'));
  fs.mkdirSync(path.join(project, '.claude', 'commands'), { recursive: true });

  fs.writeFileSync(
    path.join(home, '.claude', 'commands', 'deploy.md'),
    '---\ndescription: User deploy\n---\nbody\n'
  );
  fs.writeFileSync(
    path.join(project, '.claude', 'commands', 'deploy.md'),
    '---\ndescription: Project deploy\n---\nbody\n'
  );

  const out = listSlashCommands({ home, projectPath: project });
  const deploy = out.find(c => c.name === 'deploy');
  assert.equal(deploy.source, 'project');
  assert.equal(deploy.description, 'Project deploy');
  // Only one entry for `deploy` (project shadows user)
  assert.equal(out.filter(c => c.name === 'deploy').length, 1);
});

test('listSlashCommands: missing commands dir returns empty list', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cgui-empty-'));
  const out = listSlashCommands({ home });
  assert.deepEqual(out, []);
});

test('listSlashCommands: includes plugin commands referenced from installed_plugins.json', () => {
  const home = mktmpHome();
  // Install a fake plugin with a commands dir
  const pluginRoot = path.join(home, '.claude', 'plugins', 'cache', 'mp', 'demo', 'unknown');
  fs.mkdirSync(path.join(pluginRoot, 'commands'), { recursive: true });
  fs.writeFileSync(
    path.join(pluginRoot, 'commands', 'demo-cmd.md'),
    '---\ndescription: From plugin\n---\nbody\n'
  );
  fs.writeFileSync(
    path.join(home, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins: {
        'demo@mp': [{ scope: 'user', installPath: pluginRoot, version: 'unknown' }],
      },
    })
  );

  const out = listSlashCommands({ home });
  const found = out.find(c => c.name === 'demo-cmd');
  assert.ok(found, 'plugin command should be discovered');
  assert.equal(found.source, 'plugin:demo');
  assert.equal(found.description, 'From plugin');
});
