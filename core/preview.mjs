// Launch the live preview window (`preview.exe`) for a project.
//
// The window shell is parameterized: it knows nothing about the tool checkout
// and never guesses `<exe dir>/ui`, `<exe dir>/build/ui.dll` or `build.bat`.
// `previewArgs` is pure so the command line can be asserted in unit tests;
// `previewProject` resolves/builds the host binary when needed and spawns it.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { buildHost } from './build.mjs';
import { findToolchain } from './toolchain.mjs';

const TOOLCHAIN_FIELDS = ['vcvars', 'cmake', 'ninja'];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value) {
  return typeof value === 'string' ? value : '';
}

function tail(value, limit = 2000) {
  const message = String(value ?? '');
  return message.length <= limit ? message : `...\n${message.slice(message.length - limit)}`;
}

// The arguments only need the project shape; building additionally needs the
// LVGL source and toolchain, which `buildHost` diagnoses itself.
function argsProblem(ctx) {
  if (!isPlainObject(ctx)) return 'ctx must be an object';
  for (const field of ['root', 'buildDir', 'uiDir']) {
    if (text(ctx[field]) === '') return `ctx.${field} is required`;
  }
  if (!isPlainObject(ctx.display)
    || !Number.isInteger(ctx.display.width) || ctx.display.width <= 0
    || !Number.isInteger(ctx.display.height) || ctx.display.height <= 0) {
    return 'ctx.display.width and ctx.display.height must be positive integers';
  }
  return null;
}

function projectProblem(ctx) {
  if (ctx?.ok === false) {
    const problems = Array.isArray(ctx.problems) ? ctx.problems : [];
    return problems.length > 0 ? problems.join('; ') : 'project context is not ok';
  }
  return argsProblem(ctx);
}

function validToolchain(value) {
  if (!isPlainObject(value)) return null;
  if (!TOOLCHAIN_FIELDS.every((field) => text(value[field]) !== '')) return null;
  return { vcvars: value.vcvars, cmake: value.cmake, ninja: value.ninja };
}

function resolveToolchain(ctx) {
  const current = validToolchain(ctx.toolchain);
  if (current) return { ok: true, toolchain: current };

  let found;
  try {
    found = findToolchain({
      root: ctx.root,
      config: ctx.config,
      idf: ctx.idf,
      env: process.env,
    });
  } catch (e) {
    return { ok: false, message: `toolchain discovery failed: ${e.message}` };
  }
  if (!found.ok) {
    return { ok: false, message: `toolchain not found: ${found.problems.join('; ')}` };
  }
  return {
    ok: true,
    toolchain: { vcvars: found.vcvars, cmake: found.cmake, ninja: found.ninja },
  };
}

function failure(stage, message, args = []) {
  return { ok: false, pid: null, args, error: { stage, message } };
}

// The launcher is built once into the project's build dir. When the tool's own
// host sources change (a new release, a fix like the draggable window), an
// existing preview.exe would silently keep the old behaviour, so compare the
// mtimes of the files that make up the launcher.
const LAUNCHER_SOURCES = [
  'CMakeLists.txt',
  'host/preview_main.c',
  'host/ui_entry.c',
  'host/ui_host.h',
  'host/shot_main.c',
  'host/png_write.c',
];

function toolSourcesNewer(exePath, toolDir) {
  if (typeof toolDir !== 'string' || toolDir === '') return false;
  let stamp;
  try {
    stamp = fs.statSync(exePath).mtimeMs;
  } catch {
    return true;
  }
  for (const rel of LAUNCHER_SOURCES) {
    try {
      if (fs.statSync(path.join(toolDir, rel)).mtimeMs > stamp) return true;
    } catch {
      // A missing host file is not a reason to rebuild; the build itself will
      // report it if something is actually wrong.
    }
  }
  return false;
}

/**
 * Build the preview.exe argv array. Pure: no filesystem access, no spawn.
 *
 * @param {object} ctx shared project context from `loadContext`
 * @param {{buildCmd?: string, extraWatch?: string[]}} [options]
 *   `buildCmd` defaults to `<buildDir>/build.cmd`; `extraWatch` entries are
 *   passed as repeated `--watch` pairs so the C side watches them too.
 * @returns {string[]}
 */
export function previewArgs(ctx, options = {}) {
  const opts = isPlainObject(options) ? options : {};
  const problem = argsProblem(ctx);
  if (problem) throw new Error(`previewArgs: ${problem}`);

  const buildDir = path.resolve(ctx.buildDir);
  const buildCmd = text(opts.buildCmd) !== ''
    ? opts.buildCmd
    : path.join(buildDir, 'build.cmd');

  const args = [
    '--dll', path.join(buildDir, 'ui.dll'),
    '--project', ctx.root,
    '--ui-dir', ctx.uiDir,
    '--build-dir', buildDir,
    '--build-cmd', buildCmd,
    '--width', String(ctx.display.width),
    '--height', String(ctx.display.height),
  ];

  const extraWatch = Array.isArray(opts.extraWatch) ? opts.extraWatch : [];
  for (const entry of extraWatch) {
    if (typeof entry === 'string' && entry !== '') args.push('--watch', entry);
  }

  // Optional fast-rebuild path: with cmake and vcvars the window captures the
  // MSVC environment once and then skips vcvars on every later save.
  const toolchain = validToolchain(opts.toolchain);
  if (toolchain) {
    args.push('--cmake', toolchain.cmake, '--vcvars', toolchain.vcvars);
  }
  return args;
}

/**
 * Ensure preview.exe exists, then spawn it without waiting for the window to
 * close. A missing binary is built with the generated host build command first
 * (resolving the MSVC toolchain on demand when the context has none).
 *
 * @param {object} ctx shared project context from `loadContext`
 * @param {{buildCmd?: string, extraWatch?: string[]}} [options]
 * @returns {{ok: boolean, pid: number|null, args: string[],
 *   error: {stage: string, message: string}|null}}
 */
export function previewProject(ctx, options = {}) {
  const opts = isPlainObject(options) ? options : {};
  const problem = projectProblem(ctx);
  if (problem) return failure('ctx', problem);

  const resolved = resolveToolchain(ctx);
  const toolchain = resolved.ok ? resolved.toolchain : null;

  let args;
  try {
    args = previewArgs(ctx, { ...opts, toolchain });
  } catch (e) {
    return failure('ctx', e.message);
  }

  const buildDir = path.resolve(ctx.buildDir);
  const exe = path.join(buildDir, 'preview.exe');

  // Rebuild the launcher when the tool's own host sources changed, otherwise a
  // project that already has a preview.exe keeps the old window behaviour.
  // A rebuild can fail for mundane reasons (a window is already running and
  // holds the exe open); in that case an existing binary is still usable.
  const hadExe = fs.existsSync(exe);
  if (!hadExe || toolSourcesNewer(exe, ctx.toolDir)) {
    if (!toolchain) {
      if (!hadExe) return failure('toolchain', resolved.message, args);
    } else {
      const build = buildHost({ ...ctx, buildDir, toolchain });
      if (!build.ok) {
        const detail = text(build.stderr).trim();
        const message = `preview.exe build failed (exit ${build.exitCode ?? '?'})`
          + (detail ? `: ${tail(detail)}` : '');
        if (!hadExe) return failure('build', message, args);
        console.error(`[lvglui] 启动器重建失败，先用旧的 preview.exe：${message}`);
      }
    }
    if (!fs.existsSync(exe)) {
      return failure('build', `preview.exe not found after build: ${exe}`, args);
    }
  }

  let child;
  try {
    child = spawn(exe, args, {
      cwd: buildDir,
      // The preview window must outlive the CLI process that launched it;
      // otherwise the terminal closing the console takes the window with it.
      detached: true,
      stdio: 'ignore',
    });
  } catch (e) {
    return failure('spawn', `cannot start ${exe}: ${e.message}`, args);
  }
  if (!child) return failure('spawn', `cannot start ${exe}`, args);

  // spawn errors are asynchronous; attach the handler before checking pid so a
  // failed launch cannot become an unhandled 'error' event.
  child.on('error', (error) => {
    console.error(`[preview] ${error.message}`);
  });
  if (typeof child.pid !== 'number') {
    return failure('spawn', `cannot start ${exe}`, args);
  }
  child.unref();

  return { ok: true, pid: child.pid, args, error: null };
}
