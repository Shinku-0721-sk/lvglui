// parseArgs is pure: keep it importable without running a command. These tests
// pin the flag names the CLI contract exposes (camelCase) and the dsh/help
// special cases.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { parseArgs, validationProblem } from '../../cli/lvglui.mjs';

const CLI = path.resolve(import.meta.dirname, '../../cli/lvglui.mjs');

test('defaults to render in the current project', () => {
  const parsed = parseArgs([]);
  assert.equal(parsed.command, 'render');
  assert.equal(parsed.flags.project, process.env.LVGLUI_PROJECT || process.cwd());
  assert.deepEqual(parsed.positionals, []);
});

test('global flags map to camelCase and numeric values', () => {
  const parsed = parseArgs([
    'render',
    '--project', 'D:/esps3_test/my_lcd',
    '--width', '240',
    '--height', '320',
    '--frames', '30',
    '--out', 'D:/tmp/out',
    '--no-build',
    '--json',
  ]);
  assert.equal(parsed.command, 'render');
  assert.deepEqual(parsed.flags, {
    project: 'D:/esps3_test/my_lcd',
    width: 240,
    height: 320,
    frames: 30,
    out: 'D:/tmp/out',
    noBuild: true,
    json: true,
  });
  assert.deepEqual(parsed.positionals, []);
});

test('flags may appear before the command and accept = syntax', () => {
  const parsed = parseArgs(['--project=D:/p', '--width=240', 'build']);
  assert.equal(parsed.command, 'build');
  assert.equal(parsed.flags.project, 'D:/p');
  assert.equal(parsed.flags.width, 240);
});

test('dsh install is one command with no extra positionals', () => {
  const parsed = parseArgs(['dsh', 'install', '--project', 'D:/p']);
  assert.equal(parsed.command, 'dsh install');
  assert.deepEqual(parsed.positionals, []);
  assert.equal(parsed.flags.project, 'D:/p');
});

test('--help selects the help command', () => {
  assert.equal(parseArgs(['--help']).command, 'help');
  assert.equal(parseArgs(['help']).command, 'help');
});

test('unknown flags stay in flags for main to reject', () => {
  const parsed = parseArgs(['render', '--entry']);
  assert.equal(parsed.flags.entry, true);
  const withValue = parseArgs(['render', '--entry', 'ui_start']);
  assert.equal(withValue.flags.entry, true);
  assert.deepEqual(withValue.positionals, ['ui_start']);
});

test('importing the CLI does not execute main', () => {
  const script = [
    `await import(${JSON.stringify(pathToFileURL(CLI).href)});`,
    "console.log('imported');",
  ].join('\n');
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
  });
  assert.equal(run.status, 0, `exit ${run.status}\nstderr: ${run.stderr}`);
  assert.equal(run.stdout.trim(), 'imported');
  assert.equal(run.stderr, '');
});
test('--scroll is a render-only value flag', () => {
  const parsed = parseArgs(['render', '--scroll', 'fixture.page=bottom']);
  assert.equal(parsed.flags.scroll, 'fixture.page=bottom');
  assert.equal(parseArgs(['render', '--scroll=120']).flags.scroll, '120');
  assert.equal(parseArgs(['render', '--scroll', '120', '--all-pages']).flags.allPages, true);
});

test('--scroll and --max-heap-pct are render-only flags', () => {
  const parsed = parseArgs(['render', '--scroll', 'fixture.page=bottom', '--max-heap-pct', '70']);
  assert.equal(parsed.flags.scroll, 'fixture.page=bottom');
  assert.equal(parsed.flags.maxHeapPct, 70);
  assert.equal(parseArgs(['render', '--scroll=120']).flags.scroll, '120');
  assert.equal(parseArgs(['render', '--scroll', '120', '--all-pages']).flags.allPages, true);
});

test('validationProblem gates --stop to preview', () => {
  const base = { project: 'D:/esps3_test/my_lcd' };
  assert.equal(validationProblem('preview', { ...base, stop: true }, []), null);
  assert.match(validationProblem('render', { ...base, stop: true }, []), /只用于 preview/);
});

test('validationProblem gates scroll and heap budget before any work starts', () => {
  const base = { project: 'D:/x' };
  assert.equal(validationProblem('render', { ...base, scroll: '120' }, []), null);
  assert.match(validationProblem('preview', { ...base, scroll: '120' }, []), /只用于 render/);
  assert.match(
    validationProblem('render', { ...base, scroll: '120', allPages: true }, []),
    /不能同时使用/,
  );
  assert.match(validationProblem('render', { ...base, scroll: '' }, []), /需要一个值/);

  assert.equal(validationProblem('render', { ...base, maxHeapPct: 70 }, []), null);
  assert.match(validationProblem('preview', { ...base, maxHeapPct: 70 }, []), /只用于 render/);
  assert.match(
    validationProblem('render', { ...base, maxHeapPct: 70, allPages: true }, []),
    /不能同时使用/,
  );
  assert.match(validationProblem('render', { ...base, maxHeapPct: 0 }, []), /1-100/);
  assert.match(validationProblem('render', { ...base, maxHeapPct: 101 }, []), /1-100/);
  assert.match(validationProblem('render', { ...base, maxHeapPct: 'x' }, []), /1-100/);
});
