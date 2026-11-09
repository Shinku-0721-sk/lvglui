import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findToolchain } from '../../core/toolchain.mjs';
import { writeBuildScript, buildHost } from '../../core/build.mjs';

function tempDir(t, prefix = 'lvglui-tc-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function touch(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  return file;
}

function fakeTools(dir) {
  return {
    vcvars: touch(path.join(dir, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat')),
    cmake: touch(path.join(dir, 'bin', 'cmake.exe')),
    ninja: touch(path.join(dir, 'bin', 'ninja.exe')),
  };
}



// Plan-style context with explicit, absolute, forward-slash paths.
function planCtx(buildDir) {
  return {
    toolDir: 'D:/LVGL_preview',
    root: 'D:/proj',
    buildDir,
    uiDir: 'D:/proj/components/app_ui',
    lvgl: { dir: 'D:/proj/managed_components/lvgl__lvgl' },
    entry: 'ui_start',
    display: { width: 240, height: 320 },
    toolchain: {
      vcvars: 'C:/vs/vcvars64.bat',
      cmake: 'C:/cmake/bin/cmake.exe',
      ninja: 'C:/ninja/ninja.exe',
    },
  };
}

const NOT_FOUND = { status: 1, stdout: '', stderr: '' };

test('uses explicit config paths first', () => {
  const r = findToolchain({
    root: 'D:/p',
    config: {
      build: {
        vcvars: 'C:/vs/vcvars64.bat',
        cmake: 'C:/cmake/bin/cmake.exe',
        ninja: 'C:/ninja/ninja.exe',
      },
    },
    idf: { path: 'E:/idf' },
    env: {},
    exists: () => true,
    run: () => ({ status: 0, stdout: '' }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.cmake, 'C:/cmake/bin/cmake.exe');
  assert.equal(r.vcvars, 'C:/vs/vcvars64.bat');
  assert.equal(r.ninja, 'C:/ninja/ninja.exe');
  assert.equal(r.source, 'config');
  assert.deepEqual(r.problems, []);
});

test('an explicitly configured missing path is a problem and does not fall back', (t) => {
  const base = tempDir(t);
  const tools = fakeTools(base);
  const missing = path.join(base, 'missing', 'cmake.exe');
  const r = findToolchain({
    root: base,
    config: { build: { cmake: missing } },
    env: {
      LVGLUI_VCVARS: tools.vcvars,
      LVGLUI_CMAKE: tools.cmake,
      LVGLUI_NINJA: tools.ninja,
    },
    run: () => ({ status: 0, stdout: tools.cmake }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.cmake, null, 'broken explicit cmake must not fall back to env or PATH');
  assert.equal(r.vcvars, tools.vcvars);
  assert.equal(r.ninja, tools.ninja);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /cmake/);
  assert.match(r.problems[0], /does not exist/);
});

test('env paths win when config has no build paths', (t) => {
  const base = tempDir(t);
  const tools = fakeTools(base);
  const r = findToolchain({
    root: base,
    config: {},
    env: {
      LVGLUI_VCVARS: tools.vcvars,
      LVGLUI_CMAKE: tools.cmake,
      LVGLUI_NINJA: tools.ninja,
    },
    run: () => NOT_FOUND,
  });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'env');
  assert.deepEqual([r.vcvars, r.cmake, r.ninja], [tools.vcvars, tools.cmake, tools.ninja]);
});

test('relative config paths are resolved against root', (t) => {
  const base = tempDir(t);
  touch(path.join(base, 'tools', 'vcvars64.bat'));
  touch(path.join(base, 'tools', 'cmake.exe'));
  touch(path.join(base, 'tools', 'ninja.exe'));
  const r = findToolchain({
    root: base,
    config: {
      build: { vcvars: 'tools/vcvars64.bat', cmake: 'tools/cmake.exe', ninja: 'tools/ninja.exe' },
    },
    env: {},
    run: () => NOT_FOUND,
  });
  assert.equal(r.ok, true);
  assert.equal(r.vcvars, path.join(base, 'tools', 'vcvars64.bat'));
  assert.equal(r.cmake, path.join(base, 'tools', 'cmake.exe'));
  assert.equal(r.ninja, path.join(base, 'tools', 'ninja.exe'));
});

test('relative env paths are resolved against root', (t) => {
  const base = tempDir(t);
  touch(path.join(base, 'bin', 'vcvars64.bat'));
  touch(path.join(base, 'bin', 'cmake.exe'));
  touch(path.join(base, 'bin', 'ninja.exe'));
  const r = findToolchain({
    root: base,
    config: {},
    env: {
      LVGLUI_VCVARS: 'bin/vcvars64.bat',
      LVGLUI_CMAKE: 'bin/cmake.exe',
      LVGLUI_NINJA: 'bin/ninja.exe',
    },
    run: () => NOT_FOUND,
  });
  assert.equal(r.ok, true);
  assert.equal(r.cmake, path.resolve(base, 'bin', 'cmake.exe'));
  assert.equal(r.source, 'env');
});

test('discovers cmake and ninja through where.exe', (t) => {
  const base = tempDir(t);
  const tools = fakeTools(base);
  const calls = [];
  const r = findToolchain({
    root: base,
    config: { build: { vcvars: tools.vcvars } },
    env: {},
    run: (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === 'where.exe' && args[0] === 'cmake') return { status: 0, stdout: `${tools.cmake}\r\n` };
      if (cmd === 'where.exe' && args[0] === 'ninja') return { status: 0, stdout: `${tools.ninja}\r\n` };
      return NOT_FOUND;
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.cmake, tools.cmake);
  assert.equal(r.ninja, tools.ninja);
  assert.equal(r.vcvars, tools.vcvars);
  assert.equal(r.source, 'mixed', 'vcvars is config while cmake/ninja are path');
  assert.deepEqual(calls, [['where.exe', 'cmake'], ['where.exe', 'ninja']]);
});

test('discovers vcvars through vswhere', (t) => {
  const base = tempDir(t);
  const programFiles = path.join(base, 'Program Files');
  const vswhere = touch(path.join(programFiles, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe'));
  const installation = path.join(base, 'VS');
  const vcvars = touch(path.join(installation, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat'));
  const cmake = touch(path.join(base, 'cmake.exe'));
  const ninja = touch(path.join(base, 'ninja.exe'));
  let vswhereArgs = null;
  const r = findToolchain({
    root: base,
    config: { build: { cmake, ninja } },
    env: { 'ProgramFiles(x86)': programFiles },
    run: (cmd, args) => {
      if (cmd === vswhere) {
        vswhereArgs = args;
        return { status: 0, stdout: `${installation}\r\n` };
      }
      return NOT_FOUND;
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.vcvars, vcvars);
  assert.equal(r.source, 'mixed');
  assert.deepEqual(vswhereArgs, [
    '-latest',
    '-products',
    '*',
    '-requires',
    'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    '-property',
    'installationPath',
  ]);
});

test('discovers vcvars through VCINSTALLDIR before vswhere', (t) => {
  const base = tempDir(t);
  const vcInstall = path.join(base, 'VC');
  const vcvars = touch(path.join(vcInstall, 'Auxiliary', 'Build', 'vcvars64.bat'));
  const cmake = touch(path.join(base, 'cmake.exe'));
  const ninja = touch(path.join(base, 'ninja.exe'));
  let ran = false;
  const r = findToolchain({
    root: base,
    config: { build: { cmake, ninja } },
    env: { VCINSTALLDIR: vcInstall, 'ProgramFiles(x86)': path.join(base, 'none') },
    run: () => {
      ran = true;
      return NOT_FOUND;
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.vcvars, vcvars);
  assert.equal(ran, false, 'vswhere must not run when VCINSTALLDIR already works');
});

test('discovers the newest cmake and ninja under IDF tools roots', (t) => {
  const base = tempDir(t);
  const toolsRoot = path.join(base, 'tools');
  const cmakeNew = touch(path.join(toolsRoot, 'cmake', '4.0.3', 'bin', 'cmake.exe'));
  touch(path.join(toolsRoot, 'cmake', '3.0.0', 'bin', 'cmake.exe'));
  const ninjaNew = touch(path.join(toolsRoot, 'ninja', '1.12.1', 'ninja.exe'));
  touch(path.join(toolsRoot, 'ninja', '1.10.0', 'ninja.exe'));
  const vcvars = touch(path.join(base, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat'));
  const r = findToolchain({
    root: base,
    config: { build: { vcvars } },
    env: { IDF_TOOLS_PATH: toolsRoot },
    run: () => NOT_FOUND,
  });
  assert.equal(r.ok, true);
  assert.equal(r.cmake, cmakeNew);
  assert.equal(r.ninja, ninjaNew);
  assert.equal(r.source, 'mixed');
});

test('reports mixed when the three tools come from different origins', (t) => {
  const base = tempDir(t);
  const tools = fakeTools(base);
  const r = findToolchain({
    root: base,
    config: { build: { cmake: tools.cmake } },
    env: { LVGLUI_VCVARS: tools.vcvars, LVGLUI_NINJA: tools.ninja },
    run: () => NOT_FOUND,
  });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'mixed');
});

test('missing every tool yields ok:false with one problem per item', (t) => {
  const base = tempDir(t);
  const r = findToolchain({
    root: base,
    config: {},
    env: {},
    exists: () => false,
    run: () => NOT_FOUND,
  });
  assert.equal(r.ok, false);
  assert.deepEqual([r.vcvars, r.cmake, r.ninja], [null, null, null]);
  assert.equal(r.problems.length, 3);
  assert.match(r.problems.join('\n'), /vcvars/);
  assert.match(r.problems.join('\n'), /cmake/);
  assert.match(r.problems.join('\n'), /ninja/);
});

test('never throws when exists/run throw', (t) => {
  const base = tempDir(t);
  const r = findToolchain({
    root: base,
    config: { build: { vcvars: 'C:/a.bat', cmake: 'C:/cmake.exe', ninja: 'C:/ninja.exe' } },
    env: {},
    exists: () => {
      throw new Error('exists boom');
    },
    run: () => {
      throw new Error('run boom');
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.problems.length, 3);
});

test('writes a quoted build script and cache for plan-style paths', (t) => {
  const buildDir = tempDir(t, 'lvglui-build-');
  const r = writeBuildScript(planCtx(buildDir));
  const script = fs.readFileSync(r.script, 'utf8');
  const cache = fs.readFileSync(r.cacheScript, 'utf8');

  assert.match(script, /vcvars64\.bat/);
  assert.match(script, /-C "/);
  assert.match(script, /--target ui shot preview/);
  assert.match(script, /set "TMP=.*\\tmp"/);
  assert.match(script, /set "TEMP=%TMP%"/);
  assert.match(script, /call "C:\\vs\\vcvars64\.bat" >nul/);
  assert.match(script, /"-DCMAKE_MAKE_PROGRAM=C:\\ninja\\ninja\.exe"/);
  assert.match(cache, /set\(LVGLUI_WIDTH "240" CACHE STRING ""\)/);
  assert.match(cache, /set\(LVGLUI_HEIGHT "320" CACHE STRING ""\)/);
});

test('cache sets all twelve variables with the exact values', (t) => {
  const buildDir = tempDir(t, 'lvglui-cache-');
  const r = writeBuildScript(planCtx(buildDir));
  const cache = fs.readFileSync(r.cacheScript, 'utf8');
  const confDir = buildDir.replace(/\\/g, '/');
  const expected = `${[
    'set(LVGLUI_TOOL_DIR "D:/LVGL_preview" CACHE PATH "")',
    'set(LVGLUI_PROJECT_DIR "D:/proj" CACHE PATH "")',
    'set(LVGLUI_UI_DIR "D:/proj/components/app_ui" CACHE PATH "")',
    'set(LVGLUI_LVGL_DIR "D:/proj/managed_components/lvgl__lvgl" CACHE PATH "")',
    `set(LVGLUI_CONF_DIR "${confDir}" CACHE PATH "")`,
    'set(LVGLUI_ENTRY "ui_start" CACHE STRING "")',
    'set(LVGLUI_WIDTH "240" CACHE STRING "")',
    'set(LVGLUI_HEIGHT "320" CACHE STRING "")',
    'set(LVGLUI_FONT_NAME "" CACHE STRING "")',
    'set(LVGLUI_FREETYPE "OFF" CACHE BOOL "")',
    'set(LVGLUI_FREETYPE_DIR "" CACHE PATH "")',
    'set(LVGLUI_FONT_PATH "" CACHE FILEPATH "")',
  ].join('\n')}\n`;
  assert.equal(cache, expected);
});

test('build.cmd has the exact command sequence with backslash paths', (t) => {
  const buildDir = tempDir(t, 'lvglui-script-');
  const r = writeBuildScript(planCtx(buildDir));
  const script = fs.readFileSync(r.script, 'utf8');
  const winBuild = buildDir.replace(/\//g, '\\');
  const winCache = path.join(buildDir, 'lvglui.cmake').replace(/\//g, '\\');
  const expected = `${[
    '@echo off',
    String.raw`set "TMP=${winBuild}\tmp"`,
    'set "TEMP=%TMP%"',
    'if not exist "%TMP%" mkdir "%TMP%"',
    String.raw`call "C:\vs\vcvars64.bat" >nul`,
    'if errorlevel 1 exit /b 1',
    String.raw`"C:\cmake\bin\cmake.exe" -S "D:\LVGL_preview" -B "${winBuild}" -G Ninja "-DCMAKE_MAKE_PROGRAM=C:\ninja\ninja.exe" -C "${winCache}"`,
    'if errorlevel 1 exit /b 1',
    String.raw`"C:\cmake\bin\cmake.exe" --build "${winBuild}" --target ui shot preview`,
  ].join('\n')}\n`;
  assert.equal(script, expected);
});

test('quotes paths that contain spaces', (t) => {
  const buildDir = tempDir(t, 'lvglui space ');
  const ctx = {
    ...planCtx(buildDir),
    toolDir: 'D:/Prog Files/lvglui tool',
    root: 'D:/my proj',
    uiDir: 'D:/my proj/components/app ui',
    lvgl: { dir: 'D:/my proj/managed components/lvgl' },
    toolchain: {
      vcvars: 'D:/Program Files/VS/VC/Auxiliary/Build/vcvars64.bat',
      cmake: 'D:/Program Files/cmake/bin/cmake.exe',
      ninja: 'D:/Program Files/ninja/ninja.exe',
    },
  };
  const r = writeBuildScript(ctx);
  const script = fs.readFileSync(r.script, 'utf8');
  const cache = fs.readFileSync(r.cacheScript, 'utf8');
  assert.ok(script.includes('"D:\\Prog Files\\lvglui tool"'));
  assert.ok(cache.includes('set(LVGLUI_TOOL_DIR "D:/Prog Files/lvglui tool" CACHE PATH "")'));
  assert.ok(cache.includes('set(LVGLUI_TOOL_DIR "D:/Prog Files/lvglui tool" CACHE PATH "")'));
  assert.ok(script.includes('call "D:\\Program Files\\VS\\VC\\Auxiliary\\Build\\vcvars64.bat" >nul'));
  assert.ok(script.includes('"D:\\Program Files\\cmake\\bin\\cmake.exe" -S'));
  assert.ok(script.includes('"-DCMAKE_MAKE_PROGRAM=D:\\Program Files\\ninja\\ninja.exe"'));
  assert.ok(script.includes('"D:\\Program Files\\cmake\\bin\\cmake.exe" --build'));
  assert.ok(cache.includes('set(LVGLUI_PROJECT_DIR "D:/my proj" CACHE PATH "")'));
  assert.ok(cache.includes('set(LVGLUI_UI_DIR "D:/my proj/components/app ui" CACHE PATH "")'));
  assert.ok(cache.includes('set(LVGLUI_LVGL_DIR "D:/my proj/managed components/lvgl" CACHE PATH "")'));
});

test('writeBuildScript rejects cmd metacharacters and control characters in paths', (t) => {
  const buildDir = tempDir(t);
  const base = planCtx(buildDir);
  for (const value of ['D:/bad%path', 'D:/bad"path', 'D:/bad\npath', 'D:/bad\rpath']) {
    assert.throws(() => writeBuildScript({ ...base, toolDir: value }), /must not contain/);
  }
  for (const value of ['D:/bad%root', 'D:/bad"root', 'D:/bad\nroot', 'D:/bad\rroot']) {
    assert.throws(() => writeBuildScript({ ...base, root: value }), /must not contain/);
  }
});

test('writeBuildScript names each missing required field', (t) => {
  const buildDir = tempDir(t);
  const cases = [
    ['entry', (ctx) => { delete ctx.entry; }, /entry/],
    ['toolDir', (ctx) => { delete ctx.toolDir; }, /toolDir/],
    ['toolchain.cmake', (ctx) => { delete ctx.toolchain.cmake; }, /toolchain\.cmake/],
    ['toolchain.ninja', (ctx) => { delete ctx.toolchain.ninja; }, /toolchain\.ninja/],
  ];
  for (const [name, remove, pattern] of cases) {
    const ctx = planCtx(buildDir);
    remove(ctx);
    assert.throws(() => writeBuildScript(ctx), pattern, name);
  }
});

test('returns absolute, existing script paths', (t) => {
  const buildDir = tempDir(t, 'lvglui-paths-');
  const r = writeBuildScript(planCtx(buildDir));
  assert.equal(r.script, path.join(buildDir, 'build.cmd'));
  assert.equal(r.cacheScript, path.join(buildDir, 'lvglui.cmake'));
  assert.equal(fs.existsSync(r.script), true);
  assert.equal(fs.existsSync(r.cacheScript), true);
});

test('writeBuildScript throws on missing display', (t) => {
  const buildDir = tempDir(t);
  const ctx = planCtx(buildDir);
  delete ctx.display;
  assert.throws(() => writeBuildScript(ctx), /display/i);
  assert.throws(() => writeBuildScript({ ...planCtx(buildDir), display: { width: 240 } }), /display|height/i);
});

test('writeBuildScript throws on missing lvgl directory and toolchain tool', (t) => {
  const buildDir = tempDir(t);
  const noLvgl = { ...planCtx(buildDir), lvgl: {} };
  assert.throws(() => writeBuildScript(noLvgl), /lvgl/i);

  const noVcvars = planCtx(buildDir);
  delete noVcvars.toolchain.vcvars;
  assert.throws(() => writeBuildScript(noVcvars), /vcvars/i);
});

test('buildHost runs the generated script and writes build.log', (t) => {
  const buildDir = tempDir(t, 'lvglui-host-');
  const ctx = planCtx(buildDir);
  const calls = [];
  const r = buildHost(ctx, {
    run: (cmd, args, options) => {
      calls.push({ cmd, args, options });
      return { status: 0, stdout: 'building\n', stderr: '' };
    },
  });

  assert.equal(r.ok, true);
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout, 'building\n');
  assert.equal(r.stderr, '');
  assert.equal(typeof r.durationMs, 'number');
  assert.ok(r.durationMs >= 0);
  assert.equal(r.logPath, path.join(buildDir, 'build.log'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'cmd.exe');
  assert.deepEqual(calls[0].args, ['/c', path.join(buildDir, 'build.cmd')]);
  assert.equal(calls[0].options.cwd, buildDir);

  const log = fs.readFileSync(r.logPath, 'utf8');
  assert.match(log, /cmd\.exe \/c ".*build\.cmd"/);
  assert.match(log, /building/);
});

test('buildHost returns ok:false for a failed build and still logs stdout and stderr', (t) => {
  const buildDir = tempDir(t, 'lvglui-host-');
  const r = buildHost(planCtx(buildDir), {
    run: () => ({ status: 1, stdout: 'compiling\n', stderr: 'error C2065\n' }),
  });

  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 1);
  assert.equal(r.stdout, 'compiling\n');
  assert.equal(r.stderr, 'error C2065\n');

  const log = fs.readFileSync(r.logPath, 'utf8');
  assert.ok(log.indexOf('compiling') >= 0);
  assert.ok(log.indexOf('error C2065') > log.indexOf('compiling'));
});

test('buildHost separates stdout and stderr in build.log', (t) => {
  const buildDir = tempDir(t, 'lvglui-host-');
  const r = buildHost(planCtx(buildDir), {
    run: () => ({ status: 1, stdout: 'out', stderr: 'err' }),
  });
  assert.equal(r.ok, false);
  const log = fs.readFileSync(r.logPath, 'utf8');
  assert.ok(log.includes('out\nerr'));
});

test('buildHost returns logPath:null when build.log cannot be written', (t) => {
  const buildDir = tempDir(t, 'lvglui-host-');
  fs.mkdirSync(path.join(buildDir, 'build.log'));
  const r = buildHost(planCtx(buildDir), {
    run: () => ({ status: 0, stdout: 'built', stderr: '' }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.logPath, null);
  assert.match(r.stderr, /build\.log/i);
});

test('buildHost reports a deliberately missing cmake as a failed build with a log', (t) => {
  const buildDir = tempDir(t, 'lvglui-host-');
  const ctx = planCtx(buildDir);
  ctx.toolchain.cmake = path.join(buildDir, 'missing', 'cmake.exe');
  const r = buildHost(ctx, {
    run: () => ({ status: 1, stdout: '', stderr: "'cmake' is not recognized\n" }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /cmake/);
  assert.equal(fs.existsSync(r.logPath), true);
  const log = fs.readFileSync(r.logPath, 'utf8');
  assert.match(log, /cmake/);
});

test('buildHost never throws on a spawn error and logs the message', (t) => {
  const buildDir = tempDir(t, 'lvglui-host-');
  const r = buildHost(planCtx(buildDir), {
    run: () => ({ error: new Error('spawn cmd.exe ENOENT'), status: null, stdout: '', stderr: '' }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, null);
  assert.match(r.stderr, /ENOENT/);
  const log = fs.readFileSync(r.logPath, 'utf8');
  assert.match(log, /ENOENT/);
});

test('falls back to ProgramFiles when ProgramFiles(x86) has no vswhere', (t) => {
  const base = tempDir(t);
  const pf86 = path.join(base, 'PF86');
  fs.mkdirSync(pf86);
  const programFiles = path.join(base, 'PF');
  const vswhere = touch(path.join(programFiles, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe'));
  const install = path.join(base, 'VS');
  const vcvars = touch(path.join(install, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat'));
  const cmake = touch(path.join(base, 'cmake.exe'));
  const ninja = touch(path.join(base, 'ninja.exe'));
  const calls = [];

  const r = findToolchain({
    root: base,
    config: { build: { cmake, ninja } },
    env: { 'ProgramFiles(x86)': pf86, ProgramFiles: programFiles },
    run: (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === vswhere) return { status: 0, stdout: `${install}\r\n`, stderr: '' };
      return NOT_FOUND;
    },
  });

  assert.equal(r.ok, true, r.problems.join('\n'));
  assert.equal(r.vcvars, vcvars);
  assert.equal(calls.filter((call) => call.cmd === vswhere).length, 1);
});

test('buildHost never throws on invalid ctx and reports the validation error', (t) => {
  const buildDir = tempDir(t, 'lvglui-host-');
  const ctx = planCtx(buildDir);
  delete ctx.display;
  const r = buildHost(ctx, { run: () => ({ status: 0, stdout: '', stderr: '' }) });
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, null);
  assert.match(r.stderr, /display/i);
  assert.equal(r.logPath, null);
});