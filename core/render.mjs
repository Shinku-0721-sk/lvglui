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
import { writeIfChanged, sha256File, readText } from './fsutil.mjs';
import { encodeRgb565Png } from './png.mjs';
import { previewOverrides } from './font.mjs';
import { detectPages, pageFileStems } from './pages.mjs';
import { composeSheet } from './sheet.mjs';

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

// One shot.exe invocation. Never throws; the caller decides what a failure
// means for the stage it is in.
function shotRun(shotPath, args, timeoutMs = SHOT_TIMEOUT_MS) {
  const started = Date.now();
  const res = spawnSync(shotPath, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
  return {
    elapsed: Date.now() - started,
    status: res.status,
    error: res.error ?? null,
    stdout: String(res.stdout ?? ''),
    stderr: String(res.stderr ?? ''),
  };
}

// Parse the trailing `<w> <h> <repaints> <path>` line shot.exe prints.
function lastResultLine(stdout) {
  const lines = String(stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const hit = [...lines].reverse().find((line) => RESULT_LINE.test(line));
  if (!hit) return null;
  const [widthText, heightText, repaintsText] = hit.split(/\s+/);
  const width = Number(widthText);
  const height = Number(heightText);
  const repaints = Number(repaintsText);
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) return null;
  return { width, height, repaints, line: hit, lines };
}

// Ask shot.exe for the page list (one name per line, render order). The names
// are runtime C strings, so this cannot come from a static scan.
function listPages(shotPath, buildDir) {
  const listPath = path.join(buildDir, '.pages.txt');
  try {
    fs.rmSync(listPath, { force: true });
  } catch (e) {
    return { error: `cannot clear stale page list: ${e.message}` };
  }
  const run = shotRun(shotPath, ['--list-pages', listPath]);
  if (run.error || run.status !== 0) {
    const reason = run.error ? run.error.message : `exit ${run.status}`;
    return { error: `shot.exe could not list pages (${reason}):\n${tail(`${run.stdout}\n${run.stderr}`)}` };
  }
  let text;
  try {
    text = fs.readFileSync(listPath, 'utf8');
  } catch (e) {
    return { error: `cannot read the page list ${listPath}: ${e.message}` };
  }
  const names = text.split(/\r?\n/);
  while (names.length > 0 && names[names.length - 1] === '') names.pop();
  if (names.length === 0) return { error: 'shot.exe listed zero pages' };
  return { names };
}

function resolvePageIndex(requested, names) {
  if (Number.isInteger(requested)) {
    return requested >= 0 && requested < names.length ? requested : -1;
  }
  if (typeof requested === 'string') {
    const index = names.indexOf(requested);
    if (index >= 0) return index;
    if (/^\d+$/.test(requested)) {
      const numeric = Number(requested);
      return numeric < names.length ? numeric : -1;
    }
  }
  return -1;
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
    pages: [],
    page: null,
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
        // cmd.exe writes the log in the OEM code page (GBK on Chinese Windows);
        // readText falls back to GBK when the bytes are not valid UTF-8.
        const logged = build.logPath ? readText(build.logPath) : null;
        if (logged) log = logged;
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

  // ---- optional multi-page rendering -----------------------------------
  // Page names are runtime C strings, so the list comes from shot.exe. A
  // project without the contract keeps the exact single-shot path below:
  // same files, same pixels, same meta shape.
  const pagesInfo = isPlainObject(ctx.pages) ? ctx.pages : detectPages(ctx.sources ?? []);
  const wantsAll = opts.allPages === true;
  const requestedPage = opts.page === undefined || opts.page === null ? null : opts.page;
  if ((wantsAll || requestedPage !== null) && !pagesInfo.supported) {
    return fail(
      'pages',
      'this UI does not define the optional page contract '
        + '(int ui_page_count(void); const char *ui_page_name(int index); '
        + 'lv_obj_t *ui_page_show(int index, lv_obj_t *parent)). '
        + 'Drop --page/--all-pages, or add the three functions to the UI component.',
    );
  }

  let pageNames = null;
  if (wantsAll || requestedPage !== null) {
    const listed = listPages(shotPath, ctx.buildDir);
    if (listed.error) return fail('pages', listed.error, mergeWarnings(result.diagnostics, warnings));
    pageNames = listed.names;
  }

  let pageIndex = null;
  if (requestedPage !== null) {
    pageIndex = resolvePageIndex(requestedPage, pageNames);
    if (pageIndex < 0) {
      return fail(
        'pages',
        `unknown page ${JSON.stringify(requestedPage)}; pages: ${pageNames.join(', ')}`,
      );
    }
  }

  if (wantsAll) {
    const stems = pageFileStems(pageNames);
    const sheetFile = 'shot-sheet.png';
    const sheetPath = path.join(outDir, sheetFile);

    // Renamed/removed pages must not leave stale images behind.
    try {
      for (const entry of fs.readdirSync(outDir)) {
        // Superseded single-page outputs must not sit next to a fresh sheet
        // looking current.
        if (entry === 'shot.png' || entry === 'tree.json'
          || /^shot-.+\.png$/.test(entry) || /^tree-.+\.json$/.test(entry)) {
          fs.rmSync(path.join(outDir, entry), { force: true });
        }
      }
    } catch (e) {
      return fail('pages', `cannot clear stale page artifacts: ${e.message}`);
    }

    const records = [];
    const frames = [];
    for (let i = 0; i < pageNames.length; i++) {
      const name = pageNames[i];
      const stem = stems[i];
      const rawFile = path.join(ctx.buildDir, `.fb-page-${i}.bin`);
      const treeFile = path.join(outDir, `tree-${stem}.json`);
      const pngFile = path.join(outDir, `shot-${stem}.png`);
      try {
        fs.rmSync(rawFile, { force: true });
        fs.rmSync(treeFile, { force: true });
      } catch (e) {
        return fail('pages', `cannot clear stale artifacts for page ${JSON.stringify(name)}: ${e.message}`);
      }

      const run = shotRun(shotPath, [
        '--raw', rawFile,
        '--frames', String(frameCount),
        '--tree', treeFile,
        '--page', String(i),
      ]);
      result.shotMs += run.elapsed;
      if (run.error || run.status !== 0) {
        const reason = run.error ? run.error.message : `exit ${run.status}`;
        return fail(
          'shot',
          `page ${JSON.stringify(name)} failed (${reason}):\n${tail(`${run.stdout}\n${run.stderr}`)}`,
          mergeWarnings(result.diagnostics, warnings),
        );
      }
      const geometry = lastResultLine(run.stdout);
      if (!geometry) {
        return fail(
          'shot',
          `page ${JSON.stringify(name)} did not report the framebuffer geometry. stdout: ${run.stdout
            .split(/\r?\n/)
            .filter(Boolean)
            .slice(-3)
            .join(' | ')}`,
          mergeWarnings(result.diagnostics, warnings),
        );
      }
      if (geometry.width !== ctx.display.width || geometry.height !== ctx.display.height) {
        warnings.push(
          `page ${JSON.stringify(name)} is ${geometry.width}x${geometry.height} but ctx.display is ${ctx.display.width}x${ctx.display.height}`,
        );
      }

      let fb;
      let png;
      const encodeStarted = Date.now();
      try {
        fb = fs.readFileSync(rawFile);
        png = encodeRgb565Png(fb, geometry.width, geometry.height);
      } catch (e) {
        return fail('encode', `page ${JSON.stringify(name)}: ${e.message}`, mergeWarnings(result.diagnostics, warnings));
      }
      try {
        const tmp = `${pngFile}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, png);
        fs.renameSync(tmp, pngFile);
      } catch (e) {
        return fail('encode', `cannot write PNG ${pngFile}: ${e.message}`, mergeWarnings(result.diagnostics, warnings));
      }
      result.encodeMs += Date.now() - encodeStarted;

      const rawTree = readTree(treeFile);
      if (!rawTree) {
        return fail('tree', `widget tree missing or unreadable: ${treeFile}`, mergeWarnings(result.diagnostics, warnings));
      }
      const compact = compactTree(rawTree);
      const truncated = compact.truncated === true || rawTree.truncated === true;
      if (truncated) compact.truncated = true;
      const totalNodes = Number.isInteger(rawTree.nodes) ? rawTree.nodes : compact.nodes;

      let sha256;
      try {
        sha256 = sha256File(pngFile);
      } catch (e) {
        return fail('meta', `cannot hash ${pngFile}: ${e.message}`, mergeWarnings(result.diagnostics, warnings));
      }

      records.push({
        name,
        stem,
        png: `shot-${stem}.png`,
        tree: `tree-${stem}.json`,
        sha256,
        bytes: png.length,
        nodes: compact.nodes,
        totalNodes,
        truncated,
        width: geometry.width,
        height: geometry.height,
        repaints: geometry.repaints,
        compact,
        rawTree,
      });
      frames.push({ name, fb, width: geometry.width, height: geometry.height });
      try {
        fs.rmSync(rawFile, { force: true });
      } catch {
        // best effort: the next run overwrites it anyway
      }
    }

    let sheet;
    let sheetPng;
    const sheetStarted = Date.now();
    try {
      sheet = composeSheet(frames);
      if (!sheet) throw new Error('composeSheet returned null');
      sheetPng = encodeRgb565Png(sheet.fb, sheet.width, sheet.height);
      const tmp = `${sheetPath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, sheetPng);
      fs.renameSync(tmp, sheetPath);
    } catch (e) {
      return fail('sheet', `cannot compose the contact sheet: ${e.message}`, mergeWarnings(result.diagnostics, warnings));
    }
    result.encodeMs += Date.now() - sheetStarted;

    let sheetSha256;
    try {
      sheetSha256 = sha256File(sheetPath);
    } catch (e) {
      return fail('meta', `cannot hash ${sheetPath}: ${e.message}`, mergeWarnings(result.diagnostics, warnings));
    }

    const diagnostics = mergeWarnings(result.diagnostics, warnings);
    const names = [...new Set(records.flatMap((record) => collectNames(record.rawTree)))].sort();
    const first = records[0];

    result.ok = true;
    result.png = sheetPng;
    result.pngPath = sheetPath;
    result.tree = first.compact;
    result.treePath = path.join(outDir, first.tree);
    result.names = names;
    result.diagnostics = diagnostics;
    result.pages = records.map(({ compact, rawTree, ...record }) => record);

    const meta = {
      version: 1,
      project: ctx.root,
      uiDir: ctx.uiDir,
      entry: ctx.entry,
      display: ctx.display,
      lvgl: ctx.lvgl.version ?? null,
      idf: ctx.idf?.version ?? null,
      frames: frameCount,
      allPages: true,
      buildMs: result.buildMs,
      shotMs: result.shotMs,
      encodeMs: result.encodeMs,
      png: { file: sheetFile, bytes: sheetPng.length, sha256: sheetSha256 },
      sheet: {
        cols: sheet.cols,
        rows: sheet.rows,
        gap: sheet.gap,
        scale: sheet.scale,
        width: sheet.width,
        height: sheet.height,
      },
      pages: result.pages,
      tree: {
        file: first.tree,
        nodes: first.nodes,
        totalNodes: first.totalNodes,
        truncated: first.truncated,
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
    result.meta = meta;
    return result;
  }

  const shotStarted = Date.now();
  const shotArgs = ['--raw', rawPath, '--frames', String(frameCount), '--tree', treePath];
  if (pageIndex !== null) shotArgs.push('--page', String(pageIndex));
  const shot = spawnSync(
    shotPath,
    shotArgs,
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
    ...(pageIndex !== null ? { page: pageNames[pageIndex] } : {}),
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
    page: pageIndex !== null ? pageNames[pageIndex] : null,
  };
}