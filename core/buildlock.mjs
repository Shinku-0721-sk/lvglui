// Cross-process build mutex.
//
// CMake and Ninja write a shared set of files (CMakeCache.txt, build.ninja,
// .ninja_deps, build.log). Two builds touching the same directory at once
// corrupt that state: Ninja fails with "failed recompaction: Permission
// denied" and CMake reports it as a generate error, which looks like a file
// permission problem rather than a concurrency problem.
//
// The lock is a directory, because mkdir is atomic on every platform. The
// owner file inside carries the pid and purpose so a waiting caller can say
// who is holding it instead of guessing.

import fs from 'node:fs';
import path from 'node:path';

export const BUILD_LOCK_NAME = '.build-lock';
const STALE_MS = 10 * 60 * 1000;

function sleepSync(ms) {
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, ms);
}

function readOwner(lockDir) {
  try {
    const raw = fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8');
    const owner = JSON.parse(raw);
    return owner && typeof owner === 'object' ? owner : null;
  } catch {
    return null;
  }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// A lock dir left behind by a crashed build would otherwise block everyone
// until the stale timeout; a dead pid is enough evidence to reclaim it.
function reclaimable(lockDir, owner) {
  try {
    const stat = fs.statSync(lockDir);
    if (Date.now() - stat.mtimeMs > STALE_MS) return true;
  } catch {
    return true;
  }
  if (!owner) return false;
  return !processAlive(owner.pid);
}

function tryRemove(lockDir) {
  try {
    fs.rmSync(lockDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export function lockDirFor(buildDir) {
  return path.join(path.resolve(buildDir), BUILD_LOCK_NAME);
}

/**
 * Acquire the build lock for `buildDir`, waiting up to `timeoutMs`.
 *
 * @returns {{ok:true, dir:string, release:()=>void}
 *   | {ok:false, holder:object|null, dir:string}}
 */
export function acquireBuildLock(buildDir, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 10_000;
  const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : 150;
  const purpose = typeof options.purpose === 'string' ? options.purpose : 'build';
  const dir = lockDirFor(buildDir);
  const started = Date.now();

  fs.mkdirSync(path.resolve(buildDir), { recursive: true });

  for (;;) {
    try {
      fs.mkdirSync(dir);
      const owner = {
        pid: process.pid,
        purpose,
        startedAt: new Date().toISOString(),
      };
      fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify(owner));
      let released = false;
      return {
        ok: true,
        dir,
        release() {
          if (released) return;
          released = true;
          tryRemove(dir);
        },
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }

    const owner = readOwner(dir);
    if (reclaimable(dir, owner)) {
      if (tryRemove(dir)) continue;
    }

    if (Date.now() - started >= timeoutMs) {
      return { ok: false, holder: owner, dir };
    }
    sleepSync(pollMs);
  }
}

// Human-readable "who holds it" for error payloads.
export function describeHolder(holder) {
  if (!holder) return 'another lvglui build (no owner recorded)';
  const pid = Number.isInteger(holder.pid) ? `pid ${holder.pid}` : 'unknown pid';
  const purpose = typeof holder.purpose === 'string' && holder.purpose ? holder.purpose : 'build';
  const started = typeof holder.startedAt === 'string' ? ` since ${holder.startedAt}` : '';
  return `${purpose} ${pid}${started}`;
}