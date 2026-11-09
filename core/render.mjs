// Render a project headlessly: resolve the toolchain, generate lv_conf.h,
// build the host targets, run shot.exe for raw pixels plus the widget tree,
// encode the PNG, and write the output metadata.
//
// Deterministic: the shot binary uses a fixed frame cadence, so identical
// project + config + frame count produces an identical PNG sha256. Only
// `meta.json` carries a timestamp.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { buildHost } from './build.mjs';
import { writeLvConf, applyOverrides } from './kconfig.mjs';
import { findToolchain } from './toolchain.mjs';
import { parseDiagnostics } from './diagnostics.mjs';
import { readTree, compactTree, collectNames } from './tree.mjs';
import { writeIfChanged, sha256File } from './fsutil.mjs';
import { encodeRgb565Png } from './png.mjs';
import { previewOverrides } from './font.mjs';

const DEFAULT_FRAMES = 12;
const SHOT_TIMEOUT_MS = 120_000;
const RESULT_LINE = /^\d+\s+\d+\s+\d+\s+/;

function emptyDiagnostics() {
  return {
    errors: [],
    summary: { errors: 0, warnings: 0, total: 0 },
    hints: [],
    warnings: [],
  };
}

function mergeWarnings(diagnostics, warnings) {
  if (warnings.length === 0) return diagnostics;
  const summary = diagnostics.summary ?? { errors: 0, warnings: 0, total: 0 };
  return {
    ...diagnostics,
    summary: {
      errors: summary.errors,
      warnings: summary.warnings + warnings.length,
      total: summary.total + warnings.length,
    },
    warnings: [...(diagnostics.warnings ?? []), ...warnings],
  };
}

function tail(text, limit = 4000) {
  const value = String(text ?? '');
  return value.length <= limit ? value : `...\n${value.slice(value.length - limit)}`;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredContext(ctx) {
  if (!isPlainObject(ctx)) return 'ctx must be an object';
  if (ctx.ok === false) {
    const problems = Array.isArray(ctx.problems) ? ctx.problems : [];
    return problems.length > 0 ? problems.join('; ') : 'project context is not ok';
  }
  for (const field of ['root', 'buildDir', 'uiDir', 'entry', 'lvConfPath']) {
    if (typeof ctx[field] !== 'string' || ctx[field] === '') {
      return `ctx.${field} is required`;
    }
  }
  if (!isPlainObject(ctx.lvgl) || typeof ctx.lvgl.dir !== 'string' || ctx.lvgl.dir === '') {
    return 'ctx.lvgl.dir is required';
  }
  if (!isPlainObject(ctx.display)
    || !Number.isInteger(ctx.display.width) || ctx.display.width <= 0
    || !Number.isInteger(ctx.display.height) || ctx.display.height <= 0) {
    return 'ctx.display.width and ctx.display.height must be positive integers';
  }
  return null;
}

function resolveToolchain(ctx) {
  const current = ctx.toolchain;
  if (isPlainObject(current)) {
    const paths = ['vcvars', 'cmake', 'ninja'];
    if (paths.every((key) => typeof current[key] === 'string' && current[key] !== '')) {
      return { ok: true, toolchain: current };
    }
  }
  // Self-contained: the CLI is not required to pre-resolve the toolchain.
  const found = findToolchain({
    root: ctx.root,
    config: ctx.config,
    idf: ctx.idf,
    env: process.env,
  });
  if (!found.ok) {
    return {
      ok: false,
      message: `toolchain not found: ${found.problems.join('; ')}`,
    };
  }
  return {
    ok: true,
    toolchain: { vcvars: found.vcvars, cmake: found.cmake, ninja: found.ninja },
  };
}

// The build only needs lv_conf.h before buildHost; either translate sdkconfig
// or fall back to the tool's bundled host config (warning, not failure).
function ensureLvConf(ctx, warnings) {
  if (typeof ctx.sdkconfig === 'string' && ctx.sdkconfig !== '' && ctx.lvgl.dir) {
    writeLvConf({
      sdkconfig: ctx.sdkconfig,
      lvglDir: ctx.lvgl.dir,
      out: ctx.lvConfPath,
      overrides: previewOverrides(ctx.config),
    });
    return;
  }

  const fallback = path.join(ctx.toolDir, 'host', 'lv_conf.h');
  const fallbackText = fs.readFileSync(fallback, 'utf8');
  fs.mkdirSync(path.dirname(ctx.lvConfPath), { recursive: true });
  writeIfChanged(ctx.lvConfPath, applyOverrides(fallbackText, previewOverrides(ctx.config)));
  warnings.push(
    ctx.sdkconfig
      ? `sdkconfig is set but ctx.lvgl.dir is missing; copied ${fallback} to ${ctx.lvConfPath}`
      : `no sdkconfig; copied ${fallback} to ${ctx.lvConfPath}`,
  );
}

function errorLines(diagnostics, limit = 8) {
  const errors = diagnostics.errors.slice(0, limit).map((entry) => entry.message);
  return errors.length > 0 ? errors.join('; ') : null;
}

/**
 * @param {object} ctx shared project context from `loadContext`
 * @param {{frames?: number, rebuild?: boolean, outDir?: string}} [options]
 *   `rebuild:false` reuses an existing shot.exe; a missing shot.exe still builds
 * @returns {{ok: boolean, png: Buffer|null, pngPath: string|null,
 *   tree: object|null, treePath: string|null, meta: object|null,
 *   metaPath: string|null, diagnostics: object, names: string[],
 *   buildMs: number, shotMs: number, encodeMs: number,
 *   error: {stage: string, message: string}|null}}
 */
export function renderProject(ctx, options = {}) {
  const opts = isPlainObject(options) ? options : {};
  const warnings = [];

  const result = {
    ok: false,
    png: null,
    pngPath: null,
    tree: null,
    treePath: null,
    meta: null,
    metaPath: null,
    diagnostics: emptyDiagnostics(),
    names: [],
    buildMs: 0,
    shotMs: 0,
    encodeMs: 0,
    error: null,
  };

  const fail = (stage, message, diagnostics = result.diagnostics, extra = null) => {
    result.ok = false;
    result.diagnostics = diagnostics;
    result.error = { stage, message, ...(extra ?? {}) };
    return result;
  };

  const invalid = requiredContext(ctx);
  if (invalid) return fail('ctx', invalid);

  const outDirOption = opts.outDir ?? ctx.outDir;
  if (typeof outDirOption !== 'string' || outDirOption === '') {
    return fail('output', 'ctx.outDir is required');
  }
  const outDir = path.resolve(outDirOption);
  try {
    fs.mkdirSync(outDir, { recursive: true });
  } catch (e) {
    return fail('output', `cannot create output directory ${outDir}: ${e.message}`);
  }

  const shotPath = path.join(ctx.buildDir, 'shot.exe');
  const rawPath = path.join(ctx.buildDir, '.fb.bin');
  const pngPath = path.join(outDir, 'shot.png');
  const treePath = path.join(outDir, 'tree.json');
  const metaPath = path.join(outDir, 'meta.json');
  result.pngPath = pngPath;
  result.treePath = treePath;
  result.metaPath = metaPath;

  const frameCount = Number.isInteger(opts.frames) && opts.frames > 0
    ? opts.frames
    : DEFAULT_FRAMES;
  const rebuild = opts.rebuild !== false;
  // Resolve the toolchain only when a build is actually needed: a warm
  // rebuild:false run must succeed on a machine without MSVC/CMake/Ninja.
  const shotExisted = fs.existsSync(shotPath);
  const needsBuild = rebuild || !shotExisted;
  let builtBecauseMissing = false;

  if (needsBuild) {
    const resolved = resolveToolchain(ctx);
    if (!resolved.ok) return fail('toolchain', resolved.message);
    const buildCtx = { ...ctx, toolchain: resolved.toolchain };

    try {
      ensureLvConf(ctx, warnings);
    } catch (e) {
      return fail('lvconf', `cannot create lv_conf.h: ${e.message}`);
    }

    const build = buildHost(buildCtx);
    result.buildMs = build.durationMs;
    if (!build.ok) {
      let log = build.stderr;
      try {
        log = fs.readFileSync(build.logPath, 'utf8');
      } catch {
        // fall back to captured stderr
      }
      const diagnostics = parseDiagnostics(log, { root: ctx.root, toolDir: ctx.toolDir });
      const merged = mergeWarnings(diagnostics, warnings);
      const summary = errorLines(merged);
      const buildLog = typeof build.logPath === 'string' && build.logPath !== ''
        ? build.logPath
        : tail(build.stderr);
      return fail(
        'build',
        `build failed (exit ${build.exitCode ?? '?'})${summary ? `: ${summary}` : ''}`,
        merged,
        { diagnostics: merged, buildLog },
      );
    }
    builtBecauseMissing = !rebuild;
  }

  if (!fs.existsSync(shotPath)) {
    return fail('build', `shot.exe not found after build: ${shotPath}`);
  }

  // A stale tree would let `--tree` silently failing pass on old state, so the
  // tree (and the raw framebuffer) must be produced fresh by this run.
  try {
    fs.rmSync(treePath, { force: true });
    fs.rmSync(rawPath, { force: true });
  } catch (e) {
    return fail('shot', `cannot clear stale render artifacts: ${e.message}`);
  }

  const shotStarted = Date.now();
  const shot = spawnSync(
    shotPath,
    ['--raw', rawPath, '--frames', String(frameCount), '--tree', treePath],
    { encoding: 'utf8', timeout: SHOT_TIMEOUT_MS, windowsHide: true },
  );
  result.shotMs = Date.now() - shotStarted;

  const shotOutput = `${shot.stdout ?? ''}\n${shot.stderr ?? ''}`;
  if (shot.error || shot.status !== 0) {
    const reason = shot.error ? shot.error.message : `exit ${shot.status}`;
    return fail(
      'shot',
      `shot.exe failed (${reason}):\n${tail(shotOutput)}`,
      mergeWarnings(result.diagnostics, warnings),
    );
  }
  if (!fs.existsSync(rawPath)) {
    return fail(
      'shot',
      `shot.exe did not write the raw framebuffer: ${rawPath}`,
      mergeWarnings(result.diagnostics, warnings),
    );
  }

  const lines = String(shot.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const hit = [...lines].reverse().find((line) => RESULT_LINE.test(line));
  if (!hit) {
    return fail(
      'shot',
      `shot.exe did not report the framebuffer geometry. stdout: ${lines.slice(-3).join(' | ')}`,
      mergeWarnings(result.diagnostics, warnings),
    );
  }

  const [widthText, heightText, repaintsText] = hit.split(/\s+/);
  const width = Number(widthText);
  const height = Number(heightText);
  const repaints = Number(repaintsText);
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    return fail(
      'shot',
      `invalid framebuffer geometry from shot.exe: ${JSON.stringify(hit)}`,
      mergeWarnings(result.diagnostics, warnings),
    );
  }
  if (width !== ctx.display.width || height !== ctx.display.height) {
    warnings.push(
      `framebuffer is ${width}x${height} but ctx.display is ${ctx.display.width}x${ctx.display.height}`,
    );
  }

  let png;
  const encodeStarted = Date.now();
  try {
    const fb = fs.readFileSync(rawPath);
    png = encodeRgb565Png(fb, width, height);
  } catch (e) {
    return fail(
      'encode',
      `PNG encoding failed: ${e.message}`,
      mergeWarnings(result.diagnostics, warnings),
    );
  }
  try {
    // Write through a temporary file so a failed encode never truncates an
    // existing PNG.
    const tmp = `${pngPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, png);
    fs.renameSync(tmp, pngPath);
  } catch (e) {
    return fail(
      'encode',
      `cannot write PNG ${pngPath}: ${e.message}`,
      mergeWarnings(result.diagnostics, warnings),
    );
  }
  result.encodeMs = Date.now() - encodeStarted;
  result.png = png;

  const rawTree = readTree(treePath);
  if (!rawTree) {
    return fail(
      'tree',
      `widget tree missing or unreadable: ${treePath}`,
      mergeWarnings(result.diagnostics, warnings),
    );
  }

  const compact = compactTree(rawTree);
  // compactTree only knows what it emitted; the host tree may already be
  // truncated (depth/node caps), and that fact must survive into the result.
  const treeTruncated = compact.truncated === true || rawTree.truncated === true;
  if (treeTruncated) compact.truncated = true;
  const names = collectNames(rawTree);
  const diagnostics = mergeWarnings(result.diagnostics, warnings);
  const totalNodes = Number.isInteger(rawTree.nodes) ? rawTree.nodes : compact.nodes;

  let sha256;
  try {
    sha256 = sha256File(pngPath);
  } catch (e) {
    return fail('meta', `cannot hash PNG: ${e.message}`, diagnostics);
  }

  const meta = {
    version: 1,
    project: ctx.root,
    uiDir: ctx.uiDir,
    entry: ctx.entry,
    display: ctx.display,
    lvgl: ctx.lvgl.version ?? null,
    idf: ctx.idf?.version ?? null,
    frames: frameCount,
    repaints,
    buildMs: result.buildMs,
    shotMs: result.shotMs,
    encodeMs: result.encodeMs,
    png: { file: 'shot.png', bytes: png.length, sha256 },
    tree: {
      file: 'tree.json',
      nodes: compact.nodes,
      totalNodes,
      truncated: treeTruncated,
    },
    diagnostics: {
      errors: diagnostics.summary.errors,
      warnings: diagnostics.summary.warnings,
    },
    at: new Date().toISOString(),
  };
  if (builtBecauseMissing) meta.builtBecauseMissing = true;

  try {
    writeIfChanged(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  } catch (e) {
    return fail('meta', `cannot write meta ${metaPath}: ${e.message}`, diagnostics);
  }

  try {
    fs.rmSync(rawPath, { force: true });
  } catch {
    // Best-effort cleanup; the raw file is disposable.
  }

  return {
    ...result,
    ok: true,
    png,
    tree: compact,
    meta,
    diagnostics,
    names,
  };
}