// The build lock serialises CMake/Ninja runs across processes. These tests pin
// the contract the preview watcher relies on: one holder at a time, a busy
// answer that names the holder, and reclaiming a lock whose owner died.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { acquireBuildLock, lockDirFor } from '../../core/buildlock.mjs';

function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lvglui-lock-'));
}

test('a second build reports the current holder and waits for release', () => {
  const dir = makeDir();
  const first = acquireBuildLock(dir, { timeoutMs: 0 });
  assert.equal(first.ok, true);
  assert.equal(fs.existsSync(lockDirFor(dir)), true);

  const second = acquireBuildLock(dir, { timeoutMs: 150, pollMs: 20 });
  assert.equal(second.ok, false);
  assert.equal(second.holder.pid, process.pid);
  assert.match(second.holder.purpose, /build/);

  first.release();
  const third = acquireBuildLock(dir, { timeoutMs: 0 });
  assert.equal(third.ok, true);
  third.release();
  assert.equal(fs.existsSync(lockDirFor(dir)), false);
});

test('reclaims a lock left behind by a dead process', () => {
  const dir = makeDir();
  const lock = lockDirFor(dir);
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(
    path.join(lock, 'owner.json'),
    JSON.stringify({ pid: 2147483646, purpose: 'build', startedAt: Date.now() }),
  );

  const acquired = acquireBuildLock(dir, { timeoutMs: 500, pollMs: 20 });
  assert.equal(acquired.ok, true);
  acquired.release();
});

test('release is safe to call twice', () => {
  const dir = makeDir();
  const lock = acquireBuildLock(dir, { timeoutMs: 0 });
  lock.release();
  assert.doesNotThrow(() => lock.release());
});
