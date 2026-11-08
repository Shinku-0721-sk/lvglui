import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installDsh } from '../../core/dsh.mjs';
import { apply } from '../../dsh/lib/index.js';

const REAL_DSH = path.resolve(import.meta.dirname, '../../dsh');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lvglui-dsh-'));
}

function copyTemplate(root) {
  fs.mkdirSync(path.join(root, 'dsh'), { recursive: true });
  fs.copyFileSync(
    path.join(REAL_DSH, 'cordis.patch.template.yml'),
    path.join(root, 'dsh', 'cordis.patch.template.yml'),
  );
}

test('installDsh renders the tool path into the generated patch, not the template', () => {
  const root = tempDir();
  copyTemplate(root);
  const templatePath = path.join(root, 'dsh', 'cordis.patch.template.yml');
  const before = fs.readFileSync(templatePath, 'utf8');

  const first = installDsh(root);
  assert.equal(first.ok, true, first.problems.join('; '));
  assert.ok(first.patchFile);

  const generated = fs.readFileSync(first.patchFile, 'utf8');
  assert.ok(!generated.includes('__TOOL_DIR__'));
  assert.ok(generated.includes(`- "${root.replace(/\\/g, '/')}/cli/lvglui-mcp.mjs"`));
  assert.ok(generated.includes(`cwd: "${root.replace(/\\/g, '/')}"`));
  assert.equal(fs.readFileSync(templatePath, 'utf8'), before, 'template was modified');

  const mtime = fs.statSync(first.patchFile).mtimeMs;
  const second = installDsh(root);
  assert.equal(second.ok, true);
  assert.equal(fs.statSync(second.patchFile).mtimeMs, mtime, 'idempotent install rewrote the file');
});

test('installDsh fails clearly when the template is missing or has no token', () => {
  const empty = tempDir();
  const missing = installDsh(empty);
  assert.equal(missing.ok, false);
  assert.match(missing.problems.join(' '), /missing template/);

  const tokenless = tempDir();
  fs.mkdirSync(path.join(tokenless, 'dsh'), { recursive: true });
  fs.writeFileSync(path.join(tokenless, 'dsh', 'cordis.patch.template.yml'), '- insert: []\n');
  const noToken = installDsh(tokenless);
  assert.equal(noToken.ok, false);
  assert.match(noToken.problems.join(' '), /no __TOOL_DIR__/);
});

test('the bundle registers one skill and reads the SKILL.md body', async () => {
  let provider = null;
  let disposed = false;
  const ctx = {
    effect(fn) {
      return fn();
    },
    skills: {
      registerProvider(cb) {
        provider = cb({});
        return () => {
          disposed = true;
        };
      },
    },
  };

  apply(ctx);
  assert.ok(provider, 'registerProvider was not called');
  const candidates = await provider.list();
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].name, 'lvglui');
  assert.equal(candidates[0].source, 'bundled');
  assert.ok(candidates[0].locator.path.endsWith(path.join('skills', 'lvglui', 'SKILL.md')));

  const definition = await provider.get(candidates[0]);
  assert.equal(definition.name, 'lvglui');
  assert.ok(definition.content.includes('ui_port'));
  assert.ok(!definition.content.startsWith('---'), 'frontmatter leaked into the skill body');
  assert.ok(definition.content.includes('mcp__lvglui__render_ui'));
  assert.equal(disposed, false);
});

test('the bundle points at the generated patch file', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REAL_DSH, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'dsh-lvglui');
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.ok(pkg.files.includes('cordis.patch.template.yml'));
  assert.ok(pkg.files.includes('cordis.patch.yml'));
});