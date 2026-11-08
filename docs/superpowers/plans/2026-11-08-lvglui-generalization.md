# lvglui 通用化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `D:/LVGL_preview` 从 my_lcd 专用预览器改成任意 ESP-IDF 6.x + LVGL 9.x 工程可用的 `lvglui`：一条命令注入 UI 骨架、PC 端渲染截图与控件树，并让 DSH 通过 MCP + skill 驱动 LLM 只写 UI 层。

**Architecture:** 保留已经跑通的 Node + CMake/Ninja + host C 渲染管线，把逻辑收进 `core/`；`cli/` 与 `cli/lvglui-mcp.mjs` 只做适配；所有构建与产物写到目标工程的 `.lvglui/`，不碰现有文件；DSH 侧一个 bundle 同时注册一个最小 SkillProvider 和一个 stdio MCP client。

**Tech Stack:** Node.js 22 ESM、`node:test`、CMake 3.20+、Ninja、MSVC 2022、LVGL 9.6、ESP-IDF 6.1、DSH Cordis bundle、MCP stdio。

**Spec:** `docs/superpowers/specs/2026-11-08-lvglui-generalization-design.md`（已批准；实现以本计划为准，计划含 4 个实现级修正，见下）。

---

## 计划与 spec 的实现级修正

这些不改变产品范围，只修正落地时会被编译器或测试抓住的矛盾：

1. **色深不复用 `LV_COLOR_DEPTH`。** LVGL 9.6 的 `lv_conf_template.h` 没有该键；`lv_conf_internal.h:168-190` 在用户定义它时发 `#warning`，MSVC 下 `#warning` 是致命错误。生成的 `lv_conf.h` 强制写 `LV_COLOR_FORMAT_DEFAULT LV_COLOR_FORMAT_RGB565`，不写 `LV_COLOR_DEPTH`。16bit 探测同时接受 `CONFIG_LV_COLOR_DEPTH=16` 与 `CONFIG_LV_COLOR_FORMAT_RGB565=y`（my_lcd 两者都有）。
2. **分辨率优先级固定为 CLI > `lvglui.json` > `sdkconfig` > 源码宏。** spec 7.1 与 7.2 顺序相反；以本节为准。`init` 把探测结果写进 `lvglui.json`，后续 render 不再依赖 sdkconfig 猜测。
3. **`ui_entry.c` 从 `ui/` 移到 `host/`。** 它含 `lv_display_create`、`dump_names`、`ui_dump_tree` 等 host-only 代码，不属于目标工程的 UI 层。`ui/ui.def` 同移到 `host/ui.def`。
4. **不再生成/依赖 `build.bat` / `build-cli.bat`。** `core/build.mjs` 在 `.lvglui/build/build.cmd` 写一份带引号的构建脚本（`call vcvars64.bat && cmake -C ... && cmake --build`），旧的硬编码脚本删除。preview 通过 `--build-cmd` 指向它。

另外两条 spec 未写清、计划明确下来的约定：

- `init` 的 `uiDir` 只能是工程根内相对路径；`..`、绝对路径、junction 逃逸一律拒绝。
- `doctor` 对已有 my_lcd 这类没有 `ui_port.h` 的 UI 只报 warning，不判 fail；这样回归工程不会被新契约挡在门外。

---

## File Map

| 路径 | 责任 |
|---|---|
| `core/config.mjs` | `lvglui.json` 读写、校验、默认值、派生路径 |
| `core/fsutil.mjs` | JSON/文本读写、编码解码、sha256、原子写 |
| `core/discover.mjs` | 工程根、uiDir、entry、源码清单 |
| `core/idf.mjs` | 按工程发现 ESP-IDF 6.x，读版本 |
| `core/lvgl.mjs` | 发现 LVGL 9.x 与源码目录，读版本 |
| `core/kconfig.mjs` | sdkconfig → lv_conf.h，覆盖表，内容不变不落盘 |
| `core/display.mjs` | 分辨率/色深探测与优先级 |
| `core/toolchain.mjs` | vcvars64、cmake、ninja 发现 |
| `core/build.mjs` | 生成 `.lvglui/build/build.cmd` 与 `lvglui.cmake`，执行构建 |
| `core/context.mjs` | 组合以上模块的唯一入口 `loadContext` |
| `core/diagnostics.mjs` | MSVC/GCC/Ninja 诊断解析与提示 |
| `core/tree.mjs` | 控件树读取、压缩、名字提取 |
| `core/png.mjs` | RGB565 → PNG（从 `cli/png.mjs` 移入） |
| `core/render.mjs` | 构建 + shot + PNG + meta + tree |
| `core/doctor.mjs` | 结构化体检 |
| `core/preview.mjs` | preview.exe 参数拼装与启动 |
| `core/init.mjs` | 骨架复制、配置写入、接入片段 |
| `core/dsh.mjs` | DSH bundle 路径注入 |
| `host/ui_entry.c` | host 引擎入口、ABI、tree 导出（从 `ui/ui_entry.c` 移入） |
| `host/ui_host.h` | 4 个 ABI + `ui_dump_tree` |
| `host/ui.def` | DLL 导出表（从 `ui/ui.def` 移入） |
| `host/shot_main.c` | 无头 12 帧、raw、tree 参数 |
| `host/preview_main.c` | 窗口、热重载、参数化路径 |
| `host/png_write.c` | 既有 PNG 写入，不动 |
| `ui-template/` | `init` 复制的 UI 组件模板 |
| `cli/lvglui.mjs` | CLI 命令编排 |
| `cli/lvglui-mcp.mjs` | MCP stdio 服务 |
| `dsh/` | DSH bundle + skill |
| `test/unit/` | 纯函数单测 |
| `test/integration/` | my_lcd、MCP、CLI 集成 |
| `CMakeLists.txt` | 参数化 host 构建 |
| `package.json` / `lvglui.cmd` / `.gitignore` | 工具自身工程化 |

---

## Global Constraints

- 平台：Windows 10/11 x64；Node >= 22；ESP-IDF 6.x；LVGL 9.x；RGB565 16bit。
- 不新增 npm 依赖；不联网；不调用 `idf.py` 构建固件。
- 目标工程只允许写三类路径：`<root>/lvglui.json`、`<root>/<uiDir>/**`、`<root>/.lvglui/**`。绝不修改 `main/`、`CMakeLists.txt`、`sdkconfig`、BSP/驱动。
- UI 代码只 include `lvgl.h`、`ui_port.h` 和 UI 自己的 `ui_*.h`；不得 include `driver/`、`esp_*`、`freertos/`、`sdkconfig.h`。
- v1 只做静态截图 + 控件树；不实现点击、滑动、长按、动画采样。
- 所有 Node 代码 ESM；命令用 `spawnSync`/`spawn` 参数数组，禁止字符串拼 shell。
- 诊断保留原始错误行；不要吞掉编译器输出。
- 工具仓库可以 `git init` 并提交；目标工程不是 git 仓库，不要 init。
- 回归基线：my_lcd 240×320、`sensor_ui_create`、simple theme、12 帧、PNG sha256 `8f3a7ad7e177e94953547ae30e47149d5139de638d87a56449a2f9ea03ddd287`。host C 改动不得改变像素。

---

## Review Focus（最容易被实现者做错、也最值得先写测试的五点）

1. **无 sdkconfig 的项目不得悄悄落到 240×320。** `detectDisplay` 必须返回失败与可执行提示；只有明确配置/宏对才通过。
2. **UI 层 include 平台头文件必须在 doctor 阶段就被抓住。** 用源码扫描，不要等 host 编译报“找不到 esp_lcd_panel_io.h”再让模型猜。
3. **`--no-build` 只在 `shot.exe` 存在时跳过构建；不存在时必须先构建。** 现有 `flags['no-build']` / `flags.noBuild` 的大小写 bug 是最低级的回归点。
4. **分辨率/色深歧义必须报错，不能任选。** 多个宏对、只有宽没有高、非 16bit 都是失败。
5. **路径逃逸必须拒绝。** `uiDir: "../outside"` 或绝对路径不能写出工程根；`init` 的复制目标必须 `path.resolve(root, uiDir)` 后仍以 root 开头。

---

## 执行方式

- 推荐 `superpowers:subagent-driven-development`：每个 Task 一个 subagent，Task 0–8 之后可并行 9/10；每个 Task 结束由主 agent 跑该 Task 的验证命令并提交。
- 每个 Task 先写失败测试（Node 任务）或先写可观测的验证命令（C/构建任务），再实现，再跑完整验证。
- 提交粒度：一个 Task 一个 commit；C 任务与构建任务分开，便于用 `git bisect` 定位像素回归。
- 集成测试需要 `D:/esps3_test/my_lcd`；若不存在，测试用 `test.skip` 跳过并打印原因，不能伪造通过。

---

## Task 0：工具仓库基线与测试入口

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `lvglui.cmd`
- Create: `test/unit/smoke.test.mjs`

**Interfaces:**
- `npm test` / `node --test "test/unit/*.test.mjs"` 可运行；Node 22.23.2 不接受裸目录参数。
- `lvglui.cmd` 转发到 `cli/lvglui.mjs`，后续命令都通过它冒烟。

- [ ] **Step 1: 初始化仓库**

```bash
cd D:/LVGL_preview
git init
git config user.name "lvglui"
git config user.email "lvglui@local"
```

- [ ] **Step 2: 写 `package.json`**

```json
{
  "name": "lvglui",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": { "lvglui": "cli/lvglui.mjs" },
  "scripts": {
    "test": "node --test \"test/unit/*.test.mjs\"",
    "test:integration": "node --test \"test/integration/*.test.mjs\""
  },
  "engines": { "node": ">=22" }
}
```

- [ ] **Step 3: 写 `.gitignore`**

```gitignore
node_modules/
build/
out/
.vscode/
vendor/
test/.tmp/
*.log
.lvglui/
.superpowers/
```

- [ ] **Step 4: 写 `lvglui.cmd`**

```bat
@echo off
setlocal
node "%~dp0cli\lvglui.mjs" %*
```

- [ ] **Step 5: 写冒烟测试并验证**

`test/unit/smoke.test.mjs`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';

test('Node >= 22', () => {
  assert.ok(Number(process.versions.node.split('.')[0]) >= 22);
});
```

Run: `node --test test/unit/smoke.test.mjs`
Expected: `pass 1`。

- [ ] **Step 6: 提交**

```bash
git add package.json .gitignore lvglui.cmd test/unit/smoke.test.mjs docs/superpowers
git commit -m "chore: initialize lvglui tool repo and design docs"
```

---

## Task 1：`lvglui.json` 配置模型

**Files:**
- Create: `core/config.mjs`
- Test: `test/unit/config.test.mjs`

**Interfaces:**
- `readConfig(root)` → `{ file, data, error }`；文件不存在时 `data: null, error: null`。
- `normalizeConfig(data, root)` → `{ ok, config, problems }`。
- `writeConfig(root, config)` → `{ file }`。
- `projectPaths(root, config)` → `{ stateDir, buildDir, outDir, lvConfPath }`。

`config` 形状：

```js
{
  schema: 1,
  idfPath: '',
  lvglDir: '',
  uiDir: '',
  entry: '',
  display: null,
  build: { dir: '.lvglui/build', cmake: '', ninja: '', vcvars: '' },
  font: { cjk: true }
}
```

- [ ] **Step 1: 写失败测试**

`test/unit/config.test.mjs`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { normalizeConfig, projectPaths } from '../../core/config.mjs';

test('defaults leave uiDir/entry/display empty and fill build', () => {
  const r = normalizeConfig({}, 'D:/proj');
  assert.equal(r.ok, true);
  assert.equal(r.config.uiDir, '');
  assert.equal(r.config.entry, '');
  assert.equal(r.config.display, null);
  assert.equal(r.config.build.dir, '.lvglui/build');
});

test('rejects uiDir escaping project', () => {
  const r = normalizeConfig({ uiDir: '../outside' }, 'D:/proj');
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /inside project/);
});

test('rejects absolute uiDir', () => {
  const r = normalizeConfig({ uiDir: 'D:/outside' }, 'D:/proj');
  assert.equal(r.ok, false);
});

test('derives build and out paths', () => {
  const p = projectPaths('D:/proj', normalizeConfig({}, 'D:/proj').config);
  assert.equal(p.buildDir, path.resolve('D:/proj/.lvglui/build'));
  assert.equal(p.outDir, path.resolve('D:/proj/.lvglui/out'));
  assert.equal(p.lvConfPath, path.resolve('D:/proj/.lvglui/build/lv_conf.h'));
});
```

Run: `node --test test/unit/config.test.mjs`
Expected: FAIL，`Cannot find module ... core/config.mjs`。

- [ ] **Step 2: 实现**

要点：
- `schema` 只接受 1；缺省补 1。
- `uiDir` 缺省为空（交给 discovery）；非空时必须相对、`path.resolve(root, uiDir)` 在 `root` 内；拒绝 `..`、盘符、UNC。
- `entry` 缺省为空；非空时匹配 `/^[A-Za-z_]\w*$/`。
- `display` 缺省 null；存在时 width/height 整数 16..2048，`colorDepth` 只接受 16。禁止默认 240×320。
- `build.dir` 必须相对且在 root 内；默认 `.lvglui/build`。
- `idfPath`/`lvglDir` 允许绝对或相对；相对路径按 root 解析，校验存在性留给 `idf`/`lvgl` 模块。
- 未知字段保留（前向兼容），但不参与校验。

- [ ] **Step 3: 跑测试**

Run: `node --test test/unit/config.test.mjs`
Expected: PASS（至少 4；补 read/write/BOM/路径测试后更多）。

- [ ] **Step 4: 提交**

```bash
git add core/config.mjs test/unit/config.test.mjs
git commit -m "feat(core): add lvglui.json config model"
```

---

## Task 2：工程发现（根、uiDir、entry、源码）

**Files:**
- Create: `core/fsutil.mjs`
- Create: `core/discover.mjs`
- Test: `test/unit/discover.test.mjs`

**Interfaces:**
- `findProjectRoot(startDir, { skipDir } = {})` → `{ root, how } | null`；`how` 为 `config|cmake`。
- `discoverProject(startDir, { toolRoot, requireUi = true })` → `{ ok, root, rootHow, configFile, uiDir, uiDirHow, entry, entryHow, sources, problems }`。
- `walkSources(dir, { maxDepth = 6, exts = ['.c'] } = {})` → `string[]`（绝对路径，稳定排序）。

- [ ] **Step 1: 写失败测试**

`test/unit/discover.test.mjs`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findProjectRoot, discoverProject, walkSources } from '../../core/discover.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lvglui-detect-'));
  fs.mkdirSync(path.join(root, 'components', 'app_ui', 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.16)\nproject(demo)\n');
  fs.writeFileSync(path.join(root, 'sdkconfig'), 'CONFIG_LV_COLOR_DEPTH=16\n');
  fs.writeFileSync(path.join(root, 'components', 'app_ui', 'src', 'home.c'),
    '#include "lvgl.h"\nvoid home_create(void) { lv_screen_load(home_create()); }\n');
  return root;
}

test('finds project root from nested dir', () => {
  const root = fixture();
  const hit = findProjectRoot(path.join(root, 'components', 'app_ui'));
  assert.equal(hit.root, path.resolve(root));
  assert.equal(hit.how, 'cmake');
});

test('detects uiDir, entry from call site, and sources', () => {
  const root = fixture();
  const p = discoverProject(root, { toolRoot: 'D:/LVGL_preview' });
  assert.equal(p.ok, true);
  assert.equal(p.uiDir, path.resolve(root, 'components/app_ui'));
  assert.equal(p.entry, 'home_create');
  assert.equal(p.entryHow, 'call-site');
  assert.equal(p.sources.length, 1);
});

test('walkSources ignores build and hidden dirs', () => {
  const root = fixture();
  fs.mkdirSync(path.join(root, 'components', 'app_ui', 'build'));
  fs.writeFileSync(path.join(root, 'components', 'app_ui', 'build', 'x.c'), '');
  const list = walkSources(path.join(root, 'components/app_ui'));
  assert.equal(list.length, 1);
  assert.match(list[0], /src[\\/]home\.c$/);
});
```

Run: `node --test test/unit/discover.test.mjs`
Expected: FAIL，模块不存在。

- [ ] **Step 2: 实现 `core/fsutil.mjs`**

- `readText(file)`：不存在返回 `null`。
- `decodeBuffer(buf)`：先 `utf8`；出现 `\uFFFD` 时用 `new TextDecoder('gbk').decode(buf)`。
- `writeIfChanged(file, text)`：`mkdir -p`；内容相同返回 `{ changed: false }`；否则写临时文件再 `rename`。
- `sha256File(file)`：`createHash('sha256').update(readFileSync(file)).digest('hex')`。

- [ ] **Step 3: 实现 `core/discover.mjs`**

- 根：`startDir` 有 `lvglui.json` → 立即返回；否则向上找 `CMakeLists.txt` 且文件内容匹配 `/\bproject\s*\(/`，同时同目录有 `sdkconfig` 或 `main/`。
- 搜索到根即停；不要越过卷根。
- `uiDir`：配置优先（空字符串视为未配置）；否则按 `components/app_ui`、`components/ui`、`ui`、`main/ui` 找含 `.c` 的目录；只接受 root 内。
- `entry`：配置优先（空字符串视为未配置）；否则先收集 uiDir `sources` 里 `lv_obj_t *xxx_create(...)` 的定义名，按优先级选调用点：① 目标函数定义在 uiDir 内；② 调用点在 `<root>/main/`；③ 稳定排序的第一个。都没有调用点时，先 `entryFromDefinitions(uiDir sources)`，再全工程 `entryFromDefinitions`。
- `entryFromCallSites`：`lv_(screen|scr)_load\s*\(\s*(\w+)\s*\(`；按上述优先级选择，不再无脑取第一个。
- `entryFromDefinitions`：`lv_obj_t\s*\*\s*(\w+)\s*\(\s*(lv_obj_t\s*\*\s*\w*|void)\s*\)`。
- 源码：`sources` 只返回 `walkSources(uiDir)`；entry 的调用点/定义扫描范围是整个工程根 `walkSources(root)`，否则 `main/` 里的 `lv_screen_load(xxx_create())` 会漏；两者都跳过 `build`、`.git`、`node_modules`、`managed_components`、`test`，深度 ≤ 6。入口选择的真实回归：my_lcd 的 `design/UI/sim/main.c:29` 会先匹配 `screen_components_create`，但 `sensor_ui_create` 定义在 uiDir，必须选后者。
- `requireUi` 为 false 时不因缺 uiDir 失败（init 用）。

- [ ] **Step 4: 跑测试并提交**

Run: `node --test test/unit/discover.test.mjs`
Expected: PASS（至少 3；含 main/ 调用点与 fsutil 覆盖）。

```bash
git add core/fsutil.mjs core/discover.mjs test/unit/discover.test.mjs
git commit -m "feat(core): discover project root, ui dir and entry"
```

---

## Task 3：ESP-IDF 6.x 发现

**Files:**
- Create: `core/idf.mjs`
- Test: `test/unit/idf.test.mjs`

**Interfaces:**
- `readIdfVersion(idfPath)` → `{ ok, version: { major, minor, patch }, header, problem }`。
- `findIdf({ root, config, env = process.env })` → `{ ok, path, version, source, problem }`；`source` 为 `config|project-description|vscode|env`。

- [ ] **Step 1: 写失败测试**

`test/unit/idf.test.mjs`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findIdf, readIdfVersion } from '../../core/idf.mjs';

function makeIdf(major = 6, minor = 1) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvglui-idf-'));
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'components', 'esp_common', 'include'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tools', 'idf.py'), '');
  fs.writeFileSync(path.join(dir, 'components', 'esp_common', 'include', 'esp_idf_version.h'),
    `#define ESP_IDF_VERSION_MAJOR ${major}\n#define ESP_IDF_VERSION_MINOR ${minor}\n#define ESP_IDF_VERSION_PATCH 0\n`);
  return dir;
}

test('reads 6.1 from header', () => {
  const r = readIdfVersion(makeIdf(6, 1));
  assert.equal(r.ok, true);
  assert.equal(r.version.major, 6);
  assert.equal(r.version.minor, 1);
});

test('rejects 5.x', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lvglui-proj-'));
  fs.writeFileSync(path.join(root, 'CMakeLists.txt'), 'project(x)\n');
  const r = findIdf({ root, config: { idfPath: makeIdf(5, 3) }, env: {} });
  assert.equal(r.ok, false);
  assert.match(r.problem, /6\.x/);
});

test('project_description beats stale env IDF_PATH', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lvglui-proj-'));
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  const good = makeIdf(6, 1);
  fs.writeFileSync(path.join(root, 'build', 'project_description.json'), JSON.stringify({ idf_path: good }));
  const r = findIdf({ root, config: {}, env: { IDF_PATH: makeIdf(5, 3) } });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'project-description');
  assert.equal(r.version.major, 6);
});
```

Run: `node --test test/unit/idf.test.mjs`
Expected: FAIL。

- [ ] **Step 2: 实现**

- 候选顺序：`config.idfPath` → `<root>/build/project_description.json` 的 `idf_path` → `<root>/.vscode/settings.json` 的 `idf.currentSetup` → `env.IDF_PATH`。
- 每个候选必须存在 `<path>/tools/idf.py`。
- 读 `<path>/components/esp_common/include/esp_idf_version.h`；正则 `ESP_IDF_VERSION_(MAJOR|MINOR|PATCH)`。
- 若版本 major !== 6：`{ ok: false, path, version, source, problem: "需要 ESP-IDF 6.x，发现 <major>.<minor>" }`。
- `.vscode/settings.json` 允许 JSONC（去 `//`、`/* */` 注释后再 parse）。
- 所有候选都失败时，`problem` 列出实际尝试过的路径，不能只说“找不到”。

- [ ] **Step 3: 跑测试并提交**

Run: `node --test test/unit/idf.test.mjs`
Expected: PASS 3。

```bash
git add core/idf.mjs test/unit/idf.test.mjs
git commit -m "feat(core): discover ESP-IDF 6.x per project"
```

---

## Task 4：LVGL 9.x 发现

**Files:**
- Create: `core/lvgl.mjs`
- Test: `test/unit/lvgl.test.mjs`

**Interfaces:**
- `readLvglVersion(lvglDir)` → `{ ok, version: { major, minor, patch }, header, problem }`。
- `findLvgl({ root, config })` → `{ ok, dir, version, source, warning, problem }`；`source` 为 `config|managed|search`；失败时 `problem` 非空，非致命问题放 `warning`。

- [ ] **Step 1: 写失败测试**

`test/unit/lvgl.test.mjs`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findLvgl, readLvglVersion } from '../../core/lvgl.mjs';

function makeLvgl(root, major = 9, minor = 6) {
  const dir = path.join(root, 'managed_components', 'lvgl__lvgl');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'lvgl.h'), '#include "lvgl/lvgl.h"\n');
  fs.writeFileSync(path.join(dir, 'lv_version.h'),
    `#define LVGL_VERSION_MAJOR ${major}\n#define LVGL_VERSION_MINOR ${minor}\n#define LVGL_VERSION_PATCH 0\n`);
  return dir;
}

test('finds managed component and version', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lvglui-lvgl-'));
  const dir = makeLvgl(root);
  const r = findLvgl({ root, config: {} });
  assert.equal(r.ok, true);
  assert.equal(r.dir, dir);
  assert.equal(r.version.major, 9);
  assert.equal(r.source, 'managed');
});

test('rejects 8.x', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lvglui-lvgl-'));
  makeLvgl(root, 8, 3);
  const r = findLvgl({ root, config: {} });
  assert.equal(r.ok, false);
  assert.match(r.problem, /9\.x/);
});
```

Run: `node --test test/unit/lvgl.test.mjs`
Expected: FAIL。

- [ ] **Step 2: 实现**

- 候选：`config.lvglDir` → `<root>/managed_components/lvgl__lvgl` → `<root>/components/lvgl` → 在 root 内深度 ≤ 4 搜 `lvgl.h`（跳过 `.git`、`build`、`node_modules`）。
- 校验候选含 `src/`、`lvgl.h`、`lv_version.h` 或 `src/lv_version.h`。
- 版本头候选：`<dir>/lv_version.h`、`<dir>/src/lv_version.h`、`<dir>/include/lvgl/lv_version.h`。
- major 必须为 9；minor 不在 0..99 视为异常。
- 找到 `lvgl.h` 但无 `src/` 时给 warning，不把它当可用 LVGL。

- [ ] **Step 3: 跑测试并提交**

Run: `node --test test/unit/lvgl.test.mjs`
Expected: PASS 2。

```bash
git add core/lvgl.mjs test/unit/lvgl.test.mjs
git commit -m "feat(core): discover LVGL 9.x sources"
```

---

## Task 5：lv_conf 生成与覆盖表

**Files:**
- Move: `cli/kconfig.mjs` → `core/kconfig.mjs`
- Test: `test/unit/kconfig.test.mjs`

**Interfaces:**
- 保留现有 `parseSdkconfig`、`parseValue`、`loadTemplateOptions`、`translate`、`writeLvConf`。
- 新增 `DEFAULT_OVERRIDES`、`applyOverrides(text, overrides)`。
- `writeLvConf({ sdkconfig, lvglDir, out, post, overrides = DEFAULT_OVERRIDES })`。

`DEFAULT_OVERRIDES`：

```js
export const DEFAULT_OVERRIDES = {
  LV_COLOR_FORMAT_DEFAULT: 'LV_COLOR_FORMAT_RGB565',
  LV_USE_OBJ_NAME: '1',
  LV_FONT_MONTSERRAT_14: '1',
  LV_FONT_MONTSERRAT_16: '1',
  LV_FONT_SOURCE_HAN_SANS_SC_14_CJK: '1',
  LV_FONT_SOURCE_HAN_SANS_SC_16_CJK: '1',
  LV_USE_THEME_SIMPLE: '1',
  LV_USE_THEME_DEFAULT: '1',
  LV_USE_FLEX: '1',
  LV_USE_GRID: '1'
};
```

- [ ] **Step 1: 写失败测试**

`test/unit/kconfig.test.mjs`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOverrides, translate } from '../../core/kconfig.mjs';

test('translate drops build-only and deprecated', () => {
  const out = translate(
    new Map(Object.entries({ LV_COLOR_DEPTH: '16', LV_CONF_SKIP: '1', LV_USE_OBJ_NAME: '0', LV_UNKNOWN: '1' })),
    new Set(['LV_USE_OBJ_NAME', 'LV_COLOR_DEPTH'])
  );
  assert.deepEqual(out, { LV_USE_OBJ_NAME: '0' });
});

test('overrides replace existing and append missing without touching others', () => {
  const text = '#define LV_USE_OBJ_NAME 0\n#define LV_USE_THEME_SIMPLE 0\n#define LV_USE_FLEX 0\n';
  const out = applyOverrides(text, {
    LV_USE_OBJ_NAME: '1',
    LV_USE_THEME_SIMPLE: '1',
    LV_FONT_MONTSERRAT_14: '1'
  });
  assert.match(out, /#define LV_USE_OBJ_NAME 1/);
  assert.match(out, /#define LV_USE_THEME_SIMPLE 1/);
  assert.match(out, /#define LV_FONT_MONTSERRAT_14 1/);
  assert.doesNotMatch(out, /#define LV_USE_FLEX 0\n#define LV_USE_FLEX/);
});
```

Run: `node --test test/unit/kconfig.test.mjs`
Expected: FAIL。

- [ ] **Step 2: 实现**

- `applyOverrides`：对每个键，匹配 `/^#define\s+KEY\s+.*$/m` 替换；没有则在文件末尾追加 `#ifndef KEY\n#define KEY value\n#endif\n`。
- `translate` 继续丢弃 `LV_COLOR_DEPTH`（它在 `DEPRECATED`），但 `DEFAULT_OVERRIDES` 会写 `LV_COLOR_FORMAT_DEFAULT`。
- `writeLvConf` 在 `translate` 后 `applyOverrides`，再 `post`；内容与现有文件相同且 mtime 不变时返回 `{ written: false }`。
- 生成文本用 `\n`，UTF-8 无 BOM。

- [ ] **Step 3: 跑测试并提交**

Run: `node --test test/unit/kconfig.test.mjs`
Expected: PASS 2。

```bash
git add core/kconfig.mjs test/unit/kconfig.test.mjs
git rm cli/kconfig.mjs
git commit -m "feat(core): generate lv_conf with LVGL 9 color-format overrides"
```

---

## Task 6：分辨率与色深探测

**Files:**
- Create: `core/display.mjs`
- Test: `test/unit/display.test.mjs`

**Interfaces:**
- `detectDisplay({ root, config, sdkconfig, cli = {}, sourceText = '' })` → `{ ok, width, height, colorDepth, source, problem, warnings }`。
- `source` 为 `cli|config|sdkconfig|source`。

- [ ] **Step 1: 写失败测试**

`test/unit/display.test.mjs`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectDisplay } from '../../core/display.mjs';

const sdk = { LV_COLOR_DEPTH: '16', LV_COLOR_FORMAT_RGB565: 'y' };

test('CLI beats config and sdkconfig', () => {
  const r = detectDisplay({
    root: 'D:/p',
    config: { display: { width: 800, height: 480, colorDepth: 16 } },
    sdkconfig: sdk,
    cli: { width: 240, height: 320 }
  });
  assert.equal(r.ok, true);
  assert.deepEqual([r.width, r.height, r.source], [240, 320, 'cli']);
});

test('config beats sdkconfig', () => {
  const r = detectDisplay({
    root: 'D:/p',
    config: { display: { width: 320, height: 240, colorDepth: 16 } },
    sdkconfig: sdk
  });
  assert.equal(r.source, 'config');
});

test('missing resolution fails without 240x320 fallback', () => {
  const r = detectDisplay({ root: 'D:/p', config: {}, sdkconfig: sdk });
  assert.equal(r.ok, false);
  assert.match(r.problem, /--width/);
});

test('ambiguous source macros fail', () => {
  const r = detectDisplay({
    root: 'D:/p',
    config: {},
    sdkconfig: {},
    sourceText: '#define BSP_LCD_H_RES 240\n#define BSP_LCD_V_RES 320\n#define LCD_H_RES 800\n#define LCD_V_RES 480\n'
  });
  assert.equal(r.ok, false);
});

test('non-16 color depth fails', () => {
  const r = detectDisplay({
    root: 'D:/p',
    config: { display: { width: 240, height: 320, colorDepth: 16 } },
    sdkconfig: { LV_COLOR_DEPTH: '24' }
  });
  assert.equal(r.ok, false);
  assert.match(r.problem, /16/);
});
```

Run: `node --test test/unit/display.test.mjs`
Expected: FAIL。

- [ ] **Step 2: 实现**

- 先取 CLI（`cli.width`/`cli.height`）；两者必须同时给，否则报错。
- 再取 `config.display`。
- 再取 sdkconfig 键对，按顺序：
  `LV_DISPLAY_DEFAULT_WIDTH/HEIGHT`、`LV_HOR_RES_MAX/LV_VER_RES_MAX`、`LCD_H_RES/LCD_V_RES`、`BSP_LCD_H_RES/BSP_LCD_V_RES`。
- 最后扫 UI/源码：扫 `walkSources(uiDir)` + `main/**/*.c` 中含 `#define` 的宏对；前缀配对（`BSP_LCD_H_RES` ↔ `BSP_LCD_V_RES` 等）。只接受唯一一对；多对或只有一维都失败。
- 色深：`CONFIG_LV_COLOR_DEPTH=16` 或 `CONFIG_LV_COLOR_FORMAT_RGB565=y` 通过；`24`/`32` 或不给都失败。config 与 sdkconfig 不一致（如 config 16、sdkconfig 24）也失败。报告“只支持 16bit”。
- 返回 warnings：sdkconfig 与 config 不一致、源码宏被忽略等。

- [ ] **Step 3: 跑测试并提交**

Run: `node --test test/unit/display.test.mjs`
Expected: PASS 5。

```bash
git add core/display.mjs test/unit/display.test.mjs
git commit -m "feat(core): detect display size and 16-bit color depth"
```

---

## Task 7：工具链发现与 host 构建

**Files:**
- Create: `core/toolchain.mjs`
- Create: `core/build.mjs`
- Modify: `CMakeLists.txt`（只加 `LVGLUI_WIDTH/HEIGHT` 变量传递，target 结构暂不动）
- Test: `test/unit/toolchain.test.mjs`

**Interfaces:**
- `findToolchain({ root, config, idf, env, run })` → `{ ok, vcvars, cmake, ninja, source, problems }`。
- `buildHost(ctx, { quiet = false })` → `{ ok, exitCode, durationMs, stdout, stderr, logPath }`。
- `writeBuildScript(ctx)` → `{ script, cacheScript }`。

- [ ] **Step 1: 写失败测试**

`test/unit/toolchain.test.mjs`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findToolchain } from '../../core/toolchain.mjs';
import { writeBuildScript } from '../../core/build.mjs';

test('uses explicit config paths first', () => {
  const r = findToolchain({
    root: 'D:/p',
    config: { build: { vcvars: 'C:/vs/vcvars64.bat', cmake: 'C:/cmake/bin/cmake.exe', ninja: 'C:/ninja/ninja.exe' } },
    idf: { path: 'E:/idf' },
    env: {},
    exists: () => true,
    run: () => ({ status: 0, stdout: '' })
  });
  assert.equal(r.ok, true);
  assert.equal(r.cmake, 'C:/cmake/bin/cmake.exe');
  assert.equal(r.source, 'config');
});

test('writes quoted build script and cache', () => {
  const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvglui-build-'));
  const r = writeBuildScript({
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
      ninja: 'C:/ninja/ninja.exe'
    }
  });
  const script = fs.readFileSync(r.script, 'utf8');
  const cache = fs.readFileSync(r.cacheScript, 'utf8');
  assert.match(script, /vcvars64\.bat/);
  assert.match(script, /-C "/);
  assert.match(cache, /set\(LVGLUI_WIDTH "240"/);
});
```

Run: `node --test test/unit/toolchain.test.mjs`
Expected: FAIL。

- [ ] **Step 2: 实现工具链发现**

- 顺序：config.build → env（`LVGLUI_VCVARS`/`LVGLUI_CMAKE`/`LVGLUI_NINJA`）→ PATH → vswhere / IDF tools。
- vswhere：`%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe`，参数 `-latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`；结果拼 `VC/Auxiliary/Build/vcvars64.bat`。
- cmake/ninja：PATH 用 `where.exe`；IDF tools 根候选 `env.IDF_TOOLS_PATH`、`E:/Espressif/tools`、`C:/Users/<user>/.espressif/tools`，在 `cmake/*/bin/cmake.exe`、`ninja/*/ninja.exe` 下找。
- `findToolchain` 允许注入 `exists`/`run` 以便单测；默认用 `fs.existsSync` 与 `spawnSync`。
- 缺一不可：`ok:false` + 每个缺失项一条 problem。

- [ ] **Step 3: 实现构建脚本**

`writeBuildScript(ctx)` 生成：

`.lvglui/build/lvglui.cmake`：

```cmake
set(LVGLUI_TOOL_DIR "D:/LVGL_preview" CACHE PATH "")
set(LVGLUI_PROJECT_DIR "D:/proj" CACHE PATH "")
set(LVGLUI_UI_DIR "D:/proj/components/app_ui" CACHE PATH "")
set(LVGLUI_LVGL_DIR "D:/proj/managed_components/lvgl__lvgl" CACHE PATH "")
set(LVGLUI_CONF_DIR "D:/proj/.lvglui/build" CACHE PATH "")
set(LVGLUI_ENTRY "ui_start" CACHE STRING "")
set(LVGLUI_WIDTH "240" CACHE STRING "")
set(LVGLUI_HEIGHT "320" CACHE STRING "")
```

`.lvglui/build/build.cmd`：

```bat
@echo off
set "TMP=D:\proj\.lvglui\build\tmp"
set "TEMP=%TMP%"
if not exist "%TMP%" mkdir "%TMP%"
call "C:\vs\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 exit /b 1
"C:\cmake\bin\cmake.exe" -S "D:\LVGL_preview" -B "D:\proj\.lvglui\build" -G Ninja "-DCMAKE_MAKE_PROGRAM=C:\ninja\ninja.exe" -C "D:\proj\.lvglui\build\lvglui.cmake"
if errorlevel 1 exit /b 1
"C:\cmake\bin\cmake.exe" --build "D:\proj\.lvglui\build" --target ui shot preview
```

- 路径全部双引号包裹；`%` 不用于路径。
- `buildHost` 用 `spawnSync('cmd.exe', ['/c', script], { cwd: ctx.buildDir, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })`。
- 把 stdout+stderr 写到 `.lvglui/build/build.log`；返回 `durationMs`。
- 构建失败不抛异常；`ok:false`，让 `render`/CLI 决定退出码。

- [ ] **Step 4: 单测**

Run: `node --test test/unit/toolchain.test.mjs`
Expected: PASS 2。

构建脚本的实际执行由 Task 9 的 `test/integration/host.test.mjs` 覆盖（那里已有 `loadContext`）。

- [ ] **Step 5: 提交**

```bash
git add core/toolchain.mjs core/build.mjs CMakeLists.txt test/unit/toolchain.test.mjs
git commit -m "feat(core): discover MSVC toolchain and build host with generated script"
```

---

## Task 8：`loadContext` 组合入口

**Files:**
- Create: `core/context.mjs`
- Test: `test/unit/context.test.mjs`

**Interfaces:**
- `loadContext({ startDir, projectDir, cliWidth, cliHeight, requireUi = true })` → `ctx`：

```js
{
  ok,
  root,
  configFile,
  config,
  uiDir,
  entry,
  entryHow,
  sources,
  idf: { path, version, source },
  lvgl: { dir, version, source },
  display: { width, height, colorDepth, source },
  sdkconfig,
  stateDir,
  buildDir,
  outDir,
  lvConfPath,
  problems,
  warnings
}
```

- `ctx.ok === false` 时 `problems` 必须至少有一条；调用方不得继续构建。

- [ ] **Step 1: 写失败测试**

`test/unit/context.test.mjs`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadContext } from '../../core/context.mjs';

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lvglui-ctx-'));
  fs.mkdirSync(path.join(root, 'components', 'app_ui'), { recursive: true });
  fs.writeFileSync(path.join(root, 'CMakeLists.txt'), 'project(demo)\n');
  fs.writeFileSync(path.join(root, 'sdkconfig'), 'CONFIG_LV_COLOR_DEPTH=16\n');
  fs.writeFileSync(path.join(root, 'components', 'app_ui', 'ui.c'),
    'lv_obj_t *ui_start(lv_obj_t *p){ return p; }\n');
  const idf = path.join(root, 'idf');
  fs.mkdirSync(path.join(idf, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(idf, 'components', 'esp_common', 'include'), { recursive: true });
  fs.writeFileSync(path.join(idf, 'tools', 'idf.py'), '');
  fs.writeFileSync(path.join(idf, 'components', 'esp_common', 'include', 'esp_idf_version.h'),
    '#define ESP_IDF_VERSION_MAJOR 6\n#define ESP_IDF_VERSION_MINOR 1\n#define ESP_IDF_VERSION_PATCH 0\n');
  const lvgl = path.join(root, 'lvgl');
  fs.mkdirSync(path.join(lvgl, 'src'), { recursive: true });
  fs.writeFileSync(path.join(lvgl, 'lvgl.h'), '');
  fs.writeFileSync(path.join(lvgl, 'lv_version.h'),
    '#define LVGL_VERSION_MAJOR 9\n#define LVGL_VERSION_MINOR 6\n#define LVGL_VERSION_PATCH 0\n');
  fs.writeFileSync(path.join(root, 'lvglui.json'), JSON.stringify({
    schema: 1,
    idfPath: idf,
    lvglDir: lvgl,
    uiDir: 'components/app_ui',
    entry: 'ui_start',
    display: { width: 240, height: 320, colorDepth: 16 }
  }));
  return root;
}

test('loads config and derives paths', () => {
  const root = project();
  const ctx = loadContext({ projectDir: root });
  assert.equal(ctx.ok, true);
  assert.equal(ctx.uiDir, path.resolve(root, 'components/app_ui'));
  assert.equal(ctx.buildDir, path.resolve(root, '.lvglui/build'));
  assert.equal(ctx.display.source, 'config');
});
```

Run: `node --test test/unit/context.test.mjs`
Expected: FAIL。

- [ ] **Step 2: 实现**

按顺序：
1. `discoverProject`（`requireUi` 透传）。
2. `readConfig`（可能为 null）。
3. `findIdf`、`findLvgl`。
4. `detectDisplay`（把 `cliWidth/cliHeight` 传入）。
5. `projectPaths`。
6. 合并 problems；`ok = problems.length === 0`。

不要在此阶段找 toolchain（doctor 单独找），避免 `detect` 在没装 VS 的机器上直接失败。

- [ ] **Step 3: 跑测试并提交**

Run: `node --test test/unit/context.test.mjs`
Expected: PASS 1。

```bash
git add core/context.mjs test/unit/context.test.mjs
git commit -m "feat(core): add single loadContext composition seam"
```

---

## Task 9：host C 参数化 + 控件树

**Files:**
- Move: `ui/ui_entry.c` → `host/ui_entry.c`
- Move: `ui/ui.def` → `host/ui.def`
- Modify: `host/ui_host.h`
- Modify: `host/shot_main.c`
- Modify: `CMakeLists.txt`
- Test: `test/integration/host.test.mjs`

**Interfaces:**
- `ui_attach(width, height)` / `ui_tick(ms)` / `ui_pixels(&w,&h,&ver)` / `ui_detach()` 不变。
- 新增 `void ui_dump_tree(const char *path)`。
- `shot.exe --tree <path>` 输出 tree JSON；stdout 仍为 `w h version raw`。
- CMake 变量 `LVGLUI_WIDTH/HEIGHT` 必填，`LVGLUI_ENTRY` 由配置传入。

- [ ] **Step 1: 更新 CMake**

- `ui_obj` 源改为 `${LVGLUI_TOOL_DIR}/host/ui_entry.c` + `${APP_UI_SOURCES}`。
- include：`${LVGLUI_TOOL_DIR}/host`、`${LVGLUI_UI_DIR}/include`、`${LVGLUI_UI_DIR}`。
- `target_compile_definitions(ui_obj PRIVATE LVGLUI_HOST=1 LVGLUI_WIDTH=${LVGLUI_WIDTH} LVGLUI_HEIGHT=${LVGLUI_HEIGHT} LVGLUI_ENTRY=${LVGLUI_ENTRY})`。
- `ui` shared 的 def 改为 `${LVGLUI_TOOL_DIR}/host/ui.def`。
- `shot` 链接 `ui_obj` + `host/shot_main.c` + `host/png_write.c`；同样加 `LVGLUI_WIDTH/HEIGHT` 编译定义（`shot_main.c` 直接使用）。
- `preview` 仍只编 `host/preview_main.c`。
- 删除 `ui/` 目录引用。

- [ ] **Step 2: 写 `ui_dump_tree`**

伪代码（完整实现允许更细的错误处理）：

```c
static void json_escape(FILE *f, const char *s);
static void dump_node(FILE *f, lv_obj_t *obj, int depth, int *count) {
  if (!obj || depth > 16 || *count >= 500) return;
  (*count)++;
  const lv_obj_class_t *cls = lv_obj_get_class(obj);
  fprintf(f, "{\"name\":");
  json_escape(f, lv_obj_get_name(obj) ? lv_obj_get_name(obj) : "");
  fprintf(f, ",\"cls\":");
  json_escape(f, cls && cls->name ? cls->name : "");
  fprintf(f, ",\"x\":%d,\"y\":%d,\"w\":%d,\"h\":%d,\"hidden\":%s",
          (int)lv_obj_get_x(obj), (int)lv_obj_get_y(obj),
          (int)lv_obj_get_width(obj), (int)lv_obj_get_height(obj),
          lv_obj_has_flag(obj, LV_OBJ_FLAG_HIDDEN) ? "true" : "false");
  if (cls && cls->name && strcmp(cls->name, "lv_label") == 0) {
    fprintf(f, ",\"text\":");
    json_escape(f, lv_label_get_text(obj));
  }
  if (cls && cls->name && (strcmp(cls->name, "lv_slider") == 0 || strcmp(cls->name, "lv_bar") == 0)) {
    fprintf(f, ",\"value\":%d", (int)lv_bar_get_value(obj));
  }
  if (cls && cls->name && strcmp(cls->name, "lv_switch") == 0) {
    fprintf(f, ",\"checked\":%s", lv_obj_has_state(obj, LV_STATE_CHECKED) ? "true" : "false");
  }
  fprintf(f, ",\"children\":[");
  uint32_t n = lv_obj_get_child_count(obj);
  for (uint32_t i = 0; i < n; i++) {
    if (i) fputc(',', f);
    dump_node(f, lv_obj_get_child(obj, i), depth + 1, count);
  }
  fprintf(f, "]}");
}
void ui_dump_tree(const char *path) {
  FILE *f = fopen(path, "wb");
  if (!f) return;
  int count = 0;
  fputs("{\"root\":", f);
  dump_node(f, lv_screen_active(), 0, &count);
  fprintf(f, ",\"nodes\":%d}", count);
  fclose(f);
}
```

要求：
- `lv_obj_get_class` 需要 include `core/lv_obj_class_private.h`（CMake 已包含 `${LVGLUI_LVGL_DIR}/src`）以拿到 `class->name`。
- `lv_obj_get_name` 在 `LV_USE_OBJ_NAME=0` 时不可用；用 `#if LV_USE_OBJ_NAME` 包住，否则返回空串。
- `text` 最多 256 字节；`json_escape` 处理 `"`、`\`、`\n`、`\r`、`\t` 和 `<0x20`。
- `ui_dump_tree` 在 `ui_tick` 之后调用；不要触发额外 `lv_refr_now`。

- [ ] **Step 3: 修改 shot_main**

- 新增 `const char *tree_path = NULL;`，解析 `--tree`。
- `ui_attach(LVGLUI_WIDTH, LVGLUI_HEIGHT)`。
- 跑完 frames 后 `if (tree_path) ui_dump_tree(tree_path);`。
- stdout 保持 `printf("%d %d %u %s\n", w, h, ver, out_path)`，避免破坏现有解析。
- 删掉 `--raw` 的默认固定 240/320。

- [ ] **Step 4: `host/ui_entry.c` 迁移**

- 不要 include `ui.h`/`ui_port.h`；在文件顶部写 `extern lv_obj_t *LVGLUI_ENTRY(lv_obj_t *parent);`（宏展开为实际入口名），这样旧 my_lcd 的 `sensor_ui_create` 也能直接编译。
- `LVGLUI_ENTRY` 宏调用不再带 `NULL` 默认？保持 `LVGLUI_ENTRY(NULL)`。
- `ui_attach` 校验 `width == LVGLUI_WIDTH` 不必要；直接接受参数，`SCR_W/SCR_H` 用参数。
- `ui_tick` 保持 33ms 外部节拍。
- `dump_names` 保留（兼容旧输出）；tree 出现后 names 可由 `core/tree` 提取。

- [ ] **Step 5: 编译与集成验证**

```bash
node --test test/integration/host.test.mjs
```

`test/integration/host.test.mjs`：
- `loadContext({ projectDir: 'D:/esps3_test/my_lcd' })`。
- `buildHost(ctx)`。
- `spawnSync(path.join(ctx.buildDir, 'shot.exe'), ['--raw', path.join(ctx.buildDir, '.fb.bin'), '--frames', '12', '--tree', path.join(ctx.outDir, 'tree.json')])`。
- 断言 `tree.json` 解析成功，`root.cls` 存在，`nodes > 0`，且树里能找到 `val_temp`。
- 若 my_lcd 不存在，`test.skip`。

- [ ] **Step 6: 提交**

```bash
git add host/ui_entry.c host/ui.def host/ui_host.h host/shot_main.c CMakeLists.txt test/integration/host.test.mjs
git rm ui/ui_entry.c ui/ui.def
git commit -m "feat(host): parameterize display and dump widget tree"
```

---

## Task 10：诊断解析与控件树压缩

**Files:**
- Create: `core/diagnostics.mjs`
- Create: `core/tree.mjs`
- Test: `test/unit/diagnostics.test.mjs`
- Test: `test/unit/tree.test.mjs`

**Interfaces:**
- `parseDiagnostics(text, { root, toolDir, max = 50 })` → `{ errors, summary, hints }`。
- `readTree(file)` → `object | null`。
- `compactTree(tree, { maxNodes = 200, maxText = 64 })` → `{ root, nodes, truncated }`。
- `collectNames(tree)` → `string[]`。

- [ ] **Step 1: 写失败测试**

`test/unit/diagnostics.test.mjs`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDiagnostics } from '../../core/diagnostics.mjs';

test('parses MSVC error with file/line/col', () => {
  const text = 'D:\\proj\\components\\app_ui\\ui.c(12,5): error C2065: lv_label_set_text: undeclared identifier\n';
  const r = parseDiagnostics(text, { root: 'D:/proj', toolDir: 'D:/LVGL_preview' });
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].line, 12);
  assert.equal(r.errors[0].col, 5);
  assert.equal(r.errors[0].code, 'C2065');
  assert.match(r.errors[0].file, /app_ui[\\/]ui\.c$/);
});

test('caps at max and keeps raw lines', () => {
  const text = Array.from({ length: 60 }, (_, i) =>
    `D:\\proj\\ui.c(${i + 1},1): error C2065: bad\n`).join('');
  const r = parseDiagnostics(text, { root: 'D:/proj', toolDir: 'D:/LVGL_preview', max: 3 });
  assert.equal(r.errors.length, 3);
  assert.equal(r.summary.total, 60);
  assert.ok(r.errors[0].raw.includes('C2065'));
});
```

`test/unit/tree.test.mjs`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { compactTree, collectNames } from '../../core/tree.mjs';

test('compacts deep tree and truncates text', () => {
  let node = { name: 'leaf', cls: 'lv_label', text: 'x'.repeat(100), children: [] };
  for (let i = 0; i < 30; i++) node = { name: `n${i}`, cls: 'lv_obj', children: [node] };
  const c = compactTree({ root: node }, { maxNodes: 5, maxText: 8 });
  assert.equal(c.truncated, true);
  assert.ok(JSON.stringify(c).length < JSON.stringify(node).length);
});

test('collects names recursively', () => {
  const t = { root: { name: 'a', children: [{ name: 'b', children: [] }] } };
  assert.deepEqual(collectNames(t).sort(), ['a', 'b']);
});
```

Run: `node --test test/unit/diagnostics.test.mjs test/unit/tree.test.mjs`
Expected: FAIL。

- [ ] **Step 2: 实现诊断**

- MSVC：`/^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+([A-Z]+\d+):\s+(.*)$/`。
- GCC：`/^(.+?):(\d+):(\d+):\s+(error|warning):\s+(.*)$/`。
- 文件路径归一：绝对路径若在 root 内转相对；否则若在 toolDir 内转 `tool/<rel>`。
- `summary`：`{ errors, warnings, total }`；`errors` 最多 `max`，`total` 是解析到的总数。
- `hints` 按 code/消息匹配：
  - `C1083`/`cannot open source file` + `esp_`/`driver/` → “UI 层不能 include 平台头文件；把硬件访问移到 ui_port 实现”。
  - `LNK2019` + `ui_port_` → “在目标工程实现 ui_port 函数；host 桩只提供空实现”。
  - `C2065` + `lv_` → “检查 LVGL 版本/头文件路径”。
  - `ninja: build stopped` → “先看上面第一条 error”。
- 不把 warning 当 error；但 summary 统计。

- [ ] **Step 3: 实现树**

- `compactTree` 深度优先，保留 `name/cls/x/y/w/h/hidden/text/value/checked`；`text` 截断到 `maxText`，加 `…`。
- 超过 `maxNodes` 后不再下钻，置 `truncated: true`，并在最后节点加 `elided: true`。
- `collectNames` 去重、稳定排序。
- `readTree` 用 `fs.readFileSync` + `JSON.parse`；失败返回 null。

- [ ] **Step 4: 跑测试并提交**

Run: `node --test test/unit/diagnostics.test.mjs test/unit/tree.test.mjs`
Expected: PASS 4。

```bash
git add core/diagnostics.mjs core/tree.mjs test/unit/diagnostics.test.mjs test/unit/tree.test.mjs
git commit -m "feat(core): parse compiler diagnostics and compact widget tree"
```

---

## Task 11：render / png / meta / doctor

**Files:**
- Move: `cli/png.mjs` → `core/png.mjs`
- Create: `core/render.mjs`
- Create: `core/doctor.mjs`
- Test: `test/unit/doctor.test.mjs`
- Test: `test/integration/render.test.mjs`

**Interfaces:**
- `renderProject(ctx, { frames = 12, rebuild = true, outDir = ctx.outDir })` →

```js
{
  ok, png, pngPath, tree, treePath, meta, metaPath,
  diagnostics, names, buildMs, shotMs, encodeMs, error
}
```

- `doctor(ctx, { toolchain })` → `{ ok, checks: [{ id, status, message, detail? }], problems, warnings }`；`status` 为 `ok|warn|fail`。
- `png.mjs` 保留 `encodeRgb565Png`，新增 `sha256File` 复用 `fsutil`。

- [ ] **Step 1: 写失败测试**

`test/unit/doctor.test.mjs`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { doctor } from '../../core/doctor.mjs';

function ctx(uiSource) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lvglui-doc-'));
  const uiDir = path.join(root, 'components', 'app_ui');
  fs.mkdirSync(uiDir, { recursive: true });
  fs.writeFileSync(path.join(uiDir, 'ui.c'), uiSource);
  return {
    ok: true, root, uiDir, entry: 'ui_start', sources: [path.join(uiDir, 'ui.c')],
    idf: { path: 'E:/idf', version: { major: 6, minor: 1 } },
    lvgl: { dir: 'E:/lvgl', version: { major: 9, minor: 6 } },
    display: { width: 240, height: 320, colorDepth: 16, source: 'config' },
    sdkconfig: {}
  };
}

test('platform header include is a fail', () => {
  const r = doctor(ctx('#include "driver/gpio.h"\nvoid ui_start(void){}\n'), { toolchain: { ok: true } });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some(p => /平台头文件/.test(p.message)));
});

test('clean ui is ok with warnings only', () => {
  const r = doctor(ctx('#include "lvgl.h"\nvoid ui_start(void){}\n'), { toolchain: { ok: true } });
  assert.equal(r.ok, true);
});
```

Run: `node --test test/unit/doctor.test.mjs`
Expected: FAIL。

- [ ] **Step 2: 实现 doctor 检查项**

| id | 检查 | fail 条件 |
|---|---|---|
| `project` | ctx.ok、root 存在 | 缺 root |
| `idf` | idf.version.major === 6 | 否则 |
| `lvgl` | lvgl.version.major === 9，src 存在 | 否则 |
| `display` | width/height/colorDepth | 缺失/非 16 |
| `uiDir` | 目录存在且 sources 非空 | 否则 |
| `entry` | `^[A-Za-z_]\w*$` | 否则 |
| `srces` | UI CMakeLists 的 `SRCS` 覆盖所有 `.c`；`SRC_DIRS` 视为覆盖；无 CMakeLists 只 warn | 有 CMakeLists 且漏文件 |
| `platformHeaders` | sources 的 `#include <...>`/`"..."` 不含 `driver/`、`esp_`、`freertos/`、`sdkconfig.h` | 命中 |
| `toolchain` | vcvars/cmake/ninja 存在 | 否则 |
| `uiPort` | `uiDir/include/ui_port.h` 存在 | warning only |
| `font` | sdkconfig 有 `CONFIG_LV_FONT_SOURCE_HAN_SANS_SC_16_CJK=y` 或 config.font.cjk | warning only |

- `srces` 解析：读 `<uiDir>/CMakeLists.txt`，提取 `SRCS` 段中的 `.c` 文件名；若用 `SRC_DIRS`，直接 pass；文件不存在则 pass 并 warn“未检查 SRCS”。用 basename 比较，避免路径分隔符差异。
- `platformHeaders` 只扫 `.c/.h`，忽略注释里的 include；简单正则行首 `#include`。
- `doctor` 不构建；`toolchain` 由调用方传入（CLI 发现后传入）。若未传，只 warn“未检查工具链”。

- [ ] **Step 3: 实现 render**

- `rebuild && (!exists(shot) || force)`：`buildHost`；否则 `buildMs = 0`。
- 若 `!exists(shot)` 且 `!rebuild`：仍然 build，并记录 `builtBecauseMissing: true`。
- `shot` 参数：`--raw <buildDir>/.fb.bin --frames N --tree <outDir>/tree.json`。
- 解析最后一条 `^\d+\s+\d+\s+\d+\s+`；宽高与 `ctx.display` 不一致时 warning（可能是模板/配置漂移），但不失败。
- `encodeRgb565Png` 生成 `<outDir>/shot.png`；`encodeMs`。
- `readTree`；`compactTree`；`names = collectNames(tree)`。
- meta：

```js
{
  version: 1,
  project: ctx.root,
  uiDir: ctx.uiDir,
  entry: ctx.entry,
  display: ctx.display,
  lvgl: ctx.lvgl.version,
  idf: ctx.idf.version,
  frames,
  repaints: ver,
  buildMs, shotMs, encodeMs,
  png: { file: 'shot.png', bytes, sha256 },
  tree: { file: 'tree.json', nodes },
  diagnostics: { errors: n, warnings: n },
  at: new Date().toISOString()
}
```

- `at` 只写 meta；PNG 必须确定性。
- 任何一步失败：`ok:false`，保留已有 PNG/tree，`error` 放诊断摘要。
- 写 meta 用 `writeIfChanged`，但 `at` 每次变，所以总会写；这是状态文件，不是构建产物。

- [ ] **Step 4: 集成测试**

`test/integration/render.test.mjs`：

```js
test('my_lcd renders baseline hash and tree', { skip: !fs.existsSync('D:/esps3_test/my_lcd') }, async () => {
  const ctx = loadContext({ projectDir: 'D:/esps3_test/my_lcd' });
  const r = await renderProject(ctx, { frames: 12 });
  assert.equal(r.ok, true);
  assert.equal(r.meta.png.sha256, '8f3a7ad7e177e94953547ae30e47149d5139de638d87a56449a2f9ea03ddd287');
  assert.ok(r.names.includes('val_temp'));
  assert.ok(r.treePath.endsWith('tree.json'));
});
```

Run: `node --test test/integration/render.test.mjs`
Expected: PASS（my_lcd 存在时）。

- [ ] **Step 5: 提交**

```bash
git add core/png.mjs core/render.mjs core/doctor.mjs test/unit/doctor.test.mjs test/integration/render.test.mjs
git rm cli/png.mjs
git commit -m "feat(core): render PNG with metadata and widget tree; add doctor"
```

---

## Task 12：preview.exe 参数化与热重载

**Files:**
- Modify: `host/preview_main.c`
- Create: `core/preview.mjs`
- Test: `test/unit/preview.test.mjs`（参数拼装）
- Manual: my_lcd 热重载

**Interfaces:**
- `previewProject(ctx, { buildCmd, extraWatch = [] })` → `{ ok, pid, args }`。
- preview.exe 参数：

```
--dll <buildDir>/ui.dll
--project <root>
--ui-dir <uiDir>
--build-dir <buildDir>
--build-cmd <buildDir>/build.cmd
--width <ctx.display.width> --height <ctx.display.height>
```

- [ ] **Step 1: 改 C**

- 解析参数，缺 `--dll`/`--build-cmd` 打印用法并 `return 2`。
- 窗口尺寸用 `--width/--height`。
- `src_fingerprint` 递归 `--ui-dir` 的 `.c/.h`，加上 `<project>/lvglui.json`、`<project>/sdkconfig` 的 mtime/size。
- `rebuild()` 不再拼 `build.bat`；`CreateProcessW` 执行 `cmd.exe /c ""<build-cmd>" > "<build-dir>\build.log" 2>&1"`。
- 构建异步：主循环 33ms 检查进程是否退出；构建中保留旧 DLL，窗口显示 `building...`。
- 构建成功：复制 `--dll` 到 `<build-dir>/ui_live_<n>.dll`，LoadLibrary，解析 4 个符号，成功后 FreeLibrary 旧 DLL。
- 构建失败：保留旧 DLL，标题显示 `build failed (see build.log)`。
- 文件变化去抖 300ms；构建中不重复触发。
- 保留 `VK_ESCAPE` 退出。

- [ ] **Step 2: 写 `core/preview.mjs`**

- 组装 args；`spawn(exe, args, { cwd: ctx.buildDir, detached: false, stdio: 'inherit' })`。
- 不等待退出；返回 pid。
- 校验 `preview.exe` 存在；否则先 `buildHost`。

- [ ] **Step 3: 验证**

- 单测：`previewArgs(ctx)` 返回的数组含 `--dll`、`--build-cmd`、`--width`、`--height`。
- 手工：

```bash
node cli/lvglui.mjs preview --project D:/esps3_test/my_lcd
```

改 `components/app_ui` 的任意 `.c` 并保存；窗口应在 ~2s 内更新，且构建失败时旧画面不消失。记录结果到 `docs/superpowers/plans/2026-11-08-preview-manual.md`。

- [ ] **Step 4: 提交**

```bash
git add host/preview_main.c core/preview.mjs test/unit/preview.test.mjs docs/superpowers/plans/2026-11-08-preview-manual.md
git commit -m "feat(preview): parameterized paths and async hot reload"
```

---

## Task 13：init 与 UI 模板

**Files:**
- Create: `ui-template/CMakeLists.txt`
- Create: `ui-template/include/ui.h`
- Create: `ui-template/include/ui_port.h`
- Create: `ui-template/include/ui_theme.h`
- Create: `ui-template/include/pages/home.h`
- Create: `ui-template/src/ui.c`
- Create: `ui-template/src/ui_theme.c`
- Create: `ui-template/src/ui_port_stub.c`
- Create: `ui-template/src/pages/home.c`
- Create: `core/init.mjs`
- Test: `test/unit/init.test.mjs`

**Interfaces:**
- `initProject(ctx, { width, height, force = false })` → `{ ok, created, configFile, snippet, problems }`。
- `integrationSnippet(config)` → `string`。
- `ctx` 至少含 `root`、`uiDir`（可为默认）、`idf`、`lvgl`、`display`。
- `width`/`height` 必须来自参数或 `ctx.display`；都没有时失败，不默认 240×320。

- [ ] **Step 1: 写模板**

`ui-template/CMakeLists.txt`：

```cmake
idf_component_register(
  SRCS
    "src/ui.c"
    "src/ui_theme.c"
    "src/ui_port_stub.c"
    "src/pages/home.c"
  INCLUDE_DIRS "include"
  REQUIRES lvgl
)
```

`include/ui.h`：

```c
#pragma once
#include "lvgl.h"

#ifdef __cplusplus
extern "C" {
#endif

/* 在 parent 内创建页面；parent 为 NULL 时创建并加载根 screen。 */
lv_obj_t *ui_start(lv_obj_t *parent);

#ifdef __cplusplus
}
#endif
```

`include/ui_port.h`：

```c
#pragma once
#include "lvgl.h"

/*
 * UI 与业务代码的唯一边界。
 *
 * 约定：
 * - 本文件只声明 UI 需要的取数/命令函数。
 * - 固件实现在目标工程的业务文件（例如 main/ui_port_impl.c）。
 * - host 预览的桩实现放在 src/ui_port_stub.c 的 #ifdef LVGLUI_HOST 内。
 * - 不要 include ESP-IDF/驱动头文件。
 */
```

`include/ui_theme.h`：

```c
#pragma once
#include "lvgl.h"
void ui_theme_init(lv_obj_t *root);
```

`include/pages/home.h`：

```c
#pragma once
#include "lvgl.h"
lv_obj_t *ui_page_home_create(lv_obj_t *parent);
```

`src/ui.c`：

```c
#include "ui.h"
#include "ui_theme.h"
#include "pages/home.h"

lv_obj_t *ui_start(lv_obj_t *parent) {
    lv_obj_t *root = parent;
    if (root == NULL) {
        root = lv_obj_create(NULL);
    }
    ui_theme_init(root);
    ui_page_home_create(root);
    if (parent == NULL) {
        lv_screen_load(root);
    }
    return root;
}
```

`src/ui_theme.c`：

```c
#include "ui_theme.h"

void ui_theme_init(lv_obj_t *root) {
    if (root == NULL) {
        return;
    }
#if defined(LV_FONT_SOURCE_HAN_SANS_SC_16_CJK) && LV_FONT_SOURCE_HAN_SANS_SC_16_CJK
    lv_obj_set_style_text_font(root, &lv_font_source_han_sans_sc_16_cjk, 0);
#else
    lv_obj_set_style_text_font(root, &lv_font_montserrat_14, 0);
#endif
}
```

`src/ui_port_stub.c`：

```c
#include "ui_port.h"

#ifdef LVGLUI_HOST
/* 随着 ui_port.h 增加接口，在这里给 host 预览提供空实现。 */
#endif
```

`src/pages/home.c`：

```c
#include "lvgl.h"
#include "pages/home.h"

lv_obj_t *ui_page_home_create(lv_obj_t *parent) {
    lv_obj_t *page = lv_obj_create(parent);
    lv_obj_set_size(page, LV_PCT(100), LV_PCT(100));
    lv_obj_set_flex_flow(page, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(page, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_START);

    lv_obj_t *title = lv_label_create(page);
    lv_label_set_text(title, "Home");
#if LV_USE_OBJ_NAME
    lv_obj_set_name(title, "title");
#endif

    return page;
}
```

- [ ] **Step 2: 实现 `init.mjs`**

- 若 `<root>/lvglui.json` 已存在：拒绝，`problem: "lvglui.json 已存在；init 不会覆盖"`。
- 目标 uiDir：`config.uiDir`（无配置则 `components/app_ui`）；已存在且含 `.c`：拒绝。
- 复制模板：只复制文件，不复制目录权限；目标存在同名文件则拒绝（`force` 也不覆盖，v1 保持安全）。
- 配置写：`schema:1`、`uiDir` 相对路径、`entry: "ui_start"`、`display`、`build.dir`、`font.cjk`；`idfPath`/`lvglDir` 若在 root 内写相对，否则绝对。
- `snippet`：

```c
#include "ui.h"

/* 放在 LVGL 显示/触摸初始化完成之后 */
ui_start(NULL);
```

- 返回 `created` 列表（相对路径）。
- 不运行 doctor/render；由 CLI 在 init 后调用。

- [ ] **Step 3: 测试**

`test/unit/init.test.mjs`：
- 临时 root + `ctx`，`uiDir = components/app_ui`、`display` 240×320。
- `initProject` 断言文件存在、`lvglui.json` 内容、`snippet` 含 `ui_start(NULL)`。
- 第二次调用拒绝。
- `uiDir: '../x'` 拒绝。

Run: `node --test test/unit/init.test.mjs`
Expected: PASS 3。

- [ ] **Step 4: 提交**

```bash
git add ui-template core/init.mjs test/unit/init.test.mjs
git commit -m "feat(init): inject UI component skeleton and config"
```

---

## Task 14：CLI 重写

**Files:**
- Rewrite: `cli/lvglui.mjs`
- Create: `test/unit/cli-args.test.mjs`
- Test: `test/integration/cli.test.mjs`

**Interfaces:**
- `parseArgs(argv)` → `{ command, flags, positionals }`。
- 命令：`render`、`build`、`watch`、`serve`、`preview`、`init`、`doctor`、`dsh install`、`help`。
- 退出码：0 成功；1 构建/渲染失败；2 用法/配置错误；3 运行时/IO 错误。

- [ ] **Step 1: 写参数测试**

`test/unit/cli-args.test.mjs`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../../cli/lvglui.mjs';

test('--no-build maps to noBuild', () => {
  const a = parseArgs(['render', '--project', 'D:/p', '--no-build']);
  assert.equal(a.command, 'render');
  assert.equal(a.flags.noBuild, true);
});

test('width/height parse as numbers', () => {
  const a = parseArgs(['render', '--width', '240', '--height', '320']);
  assert.deepEqual([a.flags.width, a.flags.height], [240, 320]);
});
```

Run: `node --test test/unit/cli-args.test.mjs`
Expected: FAIL（旧 CLI 无 export）。

- [ ] **Step 2: 实现命令**

- 所有命令先 `loadContext({ startDir: process.cwd(), projectDir: flags.project, cliWidth, cliHeight, requireUi: command !== 'init' })`。
- 入口用 `if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();` 保护（`import { pathToFileURL } from 'node:url'`），测试 import 不能执行命令。
- `render`：`renderProject`；打印 `[lvglui] png=... meta=... tree=...`；失败打印诊断。
- `--json`：`render`/`build`/`doctor` 只把结果 JSON 输出到 stdout（日志走 stderr），供集成测试解析。
- `build`：`buildHost`；打印 exit code/log。
- `doctor`：`findToolchain` 后 `doctor`；逐条打印 `ok/warn/fail`；有 fail 退出 1。
- `preview`：`previewProject`。
- `init`：`initProject`；打印 created + snippet；随后 `doctor` + 空白页 `render`（`--no-render` 可跳过）。
- `watch`：`fs.watch(ctx.uiDir,{recursive:true})` + 300ms 去抖；每次 `renderProject`；Ctrl+C 退出。
- `serve`：HTTP 200 `/`（HTML + `<img src="/shot.png">`）、`/shot.png`、`/events`（SSE）；端口 8765，占用则 +1 最多 10 次；渲染用队列，不阻塞事件循环。
- `help`：英文/中文简短用法。

- [ ] **Step 3: 集成测试**

`test/integration/cli.test.mjs`：
- `spawnSync('node', ['cli/lvglui.mjs','render','--project','D:/esps3_test/my_lcd','--no-build','--json'])`，断言 exit 0 且 stdout JSON `meta.png.sha256` 等于基线。
- 若 my_lcd 不存在，skip。
- 先跑一次带构建，确保 shot 存在。

- [ ] **Step 4: 手工 serve**

```bash
node cli/lvglui.mjs serve --project D:/esps3_test/my_lcd
```

打开 `http://127.0.0.1:8765`，确认截图与状态行；编辑器保存 UI 文件后刷新。记录到 `docs/superpowers/plans/2026-11-08-serve-manual.md`。

- [ ] **Step 5: 提交**

```bash
git add cli/lvglui.mjs test/unit/cli-args.test.mjs test/integration/cli.test.mjs docs/superpowers/plans/2026-11-08-serve-manual.md
git commit -m "feat(cli): rewrite commands around loadContext"
```

---

## Task 15：MCP 重写

**Files:**
- Rewrite: `cli/lvglui-mcp.mjs`
- Test: `test/integration/mcp.test.mjs`

**Interfaces:**
- `PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18']`。
- `initialize`：返回客户端请求的版本（在列表内）或最新版。
- 工具：`detect_project`、`init_ui`、`render_ui`、`build_ui`、`doctor`、`preview_ui`。
- 所有工具参数含可选 `project`；缺省 `process.env.LVGLUI_PROJECT` 或 `process.cwd()`。
- `render_ui` 返回 `content: [{type:'image',data,mimeType:'image/png'}, {type:'text',text:...}]`；失败 `isError:true`。

- [ ] **Step 1: 写测试**

`test/integration/mcp.test.mjs`：
- `spawn('node', ['cli/lvglui-mcp.mjs'])`。
- 写一行 `initialize`（`protocolVersion:'2025-03-26'`），读一行；断言响应版本为 `2025-03-26`，`serverInfo.name` 为 `lvglui`。
- `tools/list` 断言 6 个工具名。
- `tools/call doctor`（project=my_lcd）断言 `content[0].type==='text'` 且 `ok` 字段存在；不存在则 skip。
- `render_ui` 断言 content 里有 `image`。

- [ ] **Step 2: 实现**

- `readline` 逐行；每行 `JSON.parse`；写回 `JSON.stringify(response) + '\n'`。
- 支持 `notifications/initialized`、`ping`。
- `tools/list` schema 用 JSON Schema draft-07 子集（`type/properties/required`）。
- `init_ui`：`loadContext({requireUi:false})` + `initProject`；返回 created/snippet。
- `preview_ui`：启动后返回 `{pid, args}`，不阻塞。
- 错误统一 `{content:[{type:'text',text:...}], isError:true}`。

- [ ] **Step 3: 跑测试并提交**

Run: `node --test test/integration/mcp.test.mjs`
Expected: PASS（my_lcd 存在时 doctor/render 通过）。

```bash
git add cli/lvglui-mcp.mjs test/integration/mcp.test.mjs
git commit -m "feat(mcp): protocol negotiation, project defaults and image results"
```

---

## Task 16：DSH bundle 与 skill

**Files:**
- Create: `dsh/package.json`
- Create: `dsh/cordis.patch.yml`
- Create: `dsh/lib/index.js`
- Create: `dsh/skills/lvglui/SKILL.md`
- Create: `core/dsh.mjs`
- Test: `test/unit/dsh.test.mjs`
- Modify: `cli/lvglui.mjs`（加 `dsh install`）

**Interfaces:**
- `installDsh(toolDir)` → `{ ok, patchFile, problems }`；把 `__TOOL_DIR__` 替换成实际路径（YAML 单引号内的反斜杠保持 Windows 路径）。
- `dsh/lib/index.js` 导出 `name='lvglui'`、`inject=['skills']`、`apply(ctx)`。
- provider `list(options)` 返回 1 个 candidate；`get(candidate, options)` 返回 definition，`content` 为 SKILL.md 正文。

- [ ] **Step 1: 写 bundle**

`dsh/package.json`：

```json
{
  "name": "dsh-lvglui",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "lib/index.js",
  "files": ["lib/", "skills/", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`dsh/cordis.patch.yml`：

```yaml
- insert:
    - id: lvglui-skill
      name: dsh-lvglui
    - id: lvglui-mcp
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: lvglui
        transport: stdio
        command: node
        args:
          - "__TOOL_DIR__/cli/lvglui-mcp.mjs"
        cwd: "__TOOL_DIR__"
        failOnStartupError: true
```

`dsh/lib/index.js`：

```js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const skillDir = path.resolve(here, '..', 'skills', 'lvglui');
const skillPath = path.join(skillDir, 'SKILL.md');

const DESCRIPTION =
  '用 lvglui 在 ESP-IDF 6.x + LVGL 9.x 工程里编写/调整 UI：渲染截图、读控件树、只改 UI 层，业务逻辑走 ui_port。';
const WHEN_TO_USE =
  '当用户要在 ESP32 LVGL 工程里新增/修改页面、布局、控件、字体，或要看当前 UI 的 PC 预览时。';

export const name = 'lvglui';
export const inject = ['skills'];

export function apply(ctx) {
  ctx.effect(() => ctx.skills.registerProvider(() => ({
    name: 'lvglui',
    async list() {
      return [{
        name: 'lvglui',
        description: DESCRIPTION,
        whenToUse: WHEN_TO_USE,
        invocation: { modelInvocable: true, userInvocable: true },
        source: 'bundled',
        provider: 'lvglui',
        rank: 10,
        locator: { path: skillPath, directory: skillDir },
        resourceBase: { kind: 'directory', path: skillDir },
        path: skillPath
      }];
    },
    async get(candidate) {
      const content = fs.readFileSync(skillPath, 'utf8').replace(/^---[\s\S]*?---\s*/, '').trim();
      return {
        name: 'lvglui',
        description: DESCRIPTION,
        whenToUse: WHEN_TO_USE,
        invocation: { modelInvocable: true, userInvocable: true },
        source: 'bundled',
        provider: 'lvglui',
        resourceBase: { kind: 'directory', path: skillDir },
        path: skillPath,
        content
      };
    }
  })));
}
```

- [ ] **Step 2: 写 skill 正文**

`dsh/skills/lvglui/SKILL.md` 必须含：
- 何时用：用户要写/改 LVGL 页面、布局、控件、字体，或要 PC 预览。
- 工作流：`detect_project` → `doctor` → `render_ui` → 读 image + tree → 只改 `<uiDir>` → 再 render → 直到截图合理。
- 硬约束：不改 `main/`、BSP、sdkconfig、工程 CMakeLists；不 include 平台头；业务数据走 `ui_port`；不写交互模拟。
- 失败处理：`doctor` fail 先修配置/头文件；编译错误按 `diagnostics` 第一条修；不要猜 LVGL API。
- 交付：报告改了哪些 UI 文件、截图路径、剩余 warning。
- 中文优先，关键术语保留英文。

- [ ] **Step 3: 写 `installDsh`**

- 读 `dsh/cordis.patch.yml`；若不含 `__TOOL_DIR__` 且已含绝对路径，视为已安装。
- 将 `toolDir` 中的所有反斜杠替换为正斜杠（可用 split/join；YAML 双引号内正斜杠安全）。
- 写回；返回 patch 文件。
- 打印下一步：
```
plugin_manager install_bundle target="file:D:/LVGL_preview/dsh"
```
- 说明：移动工具目录后需重新 `dsh install`。

- [ ] **Step 4: 测试**

`test/unit/dsh.test.mjs`：
- `installDsh` 在临时复制的小目录上替换；断言 `args` 含绝对路径、`cwd` 含工具目录。
- 直接 import `dsh/lib/index.js`，用 fake ctx：

```js
const providers = [];
const ctx = { effect(fn) { fn(); }, skills: { registerProvider(cb) { providers.push(cb({})); } } };
apply(ctx);
const p = providers[0];
const [c] = await p.list();
assert.equal(c.name, 'lvglui');
const d = await p.get(c);
assert.ok(d.content.includes('ui_port'));
```

- 注意：`apply` 里 `ctx.effect(() => registerProvider(...))` 的返回值需要是 cleanup；fake effect 直接执行。
- 真实 DSH 安装是手工 gate：跑 `node cli/lvglui.mjs dsh install`，再用 `plugin_manager install_bundle`；重启后在 DSH 里看 `mcp__lvglui__*` 与 skill 目录。记录到 `docs/superpowers/plans/2026-11-08-dsh-manual.md`。

- [ ] **Step 5: 提交**

```bash
git add dsh core/dsh.mjs test/unit/dsh.test.mjs cli/lvglui.mjs docs/superpowers/plans/2026-11-08-dsh-manual.md
git commit -m "feat(dsh): bundle skill provider and stdio MCP client"
```

---

## Task 17：兼容清理、README、全量验收

**Files:**
- Delete: `cli/core.mjs`、`cli/project.mjs`、`cli/kconfig.mjs`（已移）、`cli/png.mjs`（已移）、`ui/`（已移）、`build.bat`、`build-cli.bat`、`lvglui.bat`、`shot.bat`（若存在）
- Modify: `README.md`
- Modify: `mcp.example.json`
- Create: `test/integration/acceptance.test.mjs`

- [ ] **Step 1: 删除旧路径**

```bash
git rm cli/core.mjs cli/project.mjs build.bat build-cli.bat lvglui.bat
# 若存在：git rm shot.bat
```

- [ ] **Step 2: README 重写**

结构：
1. 这是什么：任意 ESP-IDF 6.x + LVGL 9.x 工程的 UI 预览/生成工具。
2. 前置：已有工程能显示 LVGL；BSP/触摸已工作；Node 22；VS2022；IDF 6.x。
3. 快速开始：
   ```bash
   # init 需要显式分辨率（或由工程 sdkconfig 探测）；示例 240×320
   node cli/lvglui.mjs init --project D:/my_project --width 240 --height 320
   node cli/lvglui.mjs doctor --project D:/my_project
   node cli/lvglui.mjs render --project D:/my_project
   node cli/lvglui.mjs preview --project D:/my_project
   ```
4. `lvglui.json` 字段表。
5. `ui_port.h` 契约与 `main/ui_port_impl.c` 示例。
6. DSH 安装：`dsh install` + `plugin_manager install_bundle`；重启；示例对话。
7. 限制：只做静态、只支持 16bit、Windows、LVGL 9.x、不拉组件/不搭 BSP。
8. 故障排查：IDF/LVGL 版本、vcvars、`--no-build`、`.lvglui/build/build.log`。

- [ ] **Step 3: 更新 `mcp.example.json`**

```json
{
  "mcpServers": {
    "lvglui": {
      "command": "node",
      "args": ["D:/LVGL_preview/cli/lvglui-mcp.mjs"],
      "cwd": "D:/LVGL_preview",
      "env": { "LVGLUI_PROJECT": "D:/esps3_test/my_lcd" }
    }
  }
}
```

- [ ] **Step 4: 写全量验收测试**

`test/integration/acceptance.test.mjs`：
- my_lcd `doctor` → `ok:true`；`uiPort` warning 可接受。
- `render` → sha256 基线。
- 第二次 `render --no-build` → `buildMs === 0`，sha 不变。
- `init` 到临时工程（有 CMakeLists/sdkconfig/IDF/managed LVGL fixture）→ 文件 + 配置；第二次拒绝。
- MCP `initialize`/`tools/list`/`doctor`。
- DSH 单元（provider + patch 替换）。

Run:

```bash
npm test
npm run test:integration
node cli/lvglui.mjs doctor --project D:/esps3_test/my_lcd
node cli/lvglui.mjs render --project D:/esps3_test/my_lcd
```

Expected：单测全 PASS；集成 PASS 或明确 skip；doctor `ok`；render sha 基线。

- [ ] **Step 5: 手工验收**

- `preview --project D:/esps3_test/my_lcd`：改 UI 保存，窗口更新；故意写错 `lv_label_set_text`，窗口保留旧画面并显示 build failed。
- DSH：安装 bundle，重启，问“把 home 页加一个标题和三个传感器卡片，用 ui_port 取数”；确认只改 `components/app_ui`；截图回对话；doctor 通过。
- 记录到 `docs/superpowers/plans/2026-11-08-dsh-manual.md`。

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "docs: generalize README and add acceptance coverage"
```

---

## 验收标准

- [ ] 在 `D:/esps3_test/my_lcd` 上 `doctor` 返回 `ok:true`；`render` 的 PNG sha256 仍为 `8f3a7ad7e177e94953547ae30e47149d5139de638d87a56449a2f9ea03ddd287`，tree 含 `val_temp`。
- [ ] 在一个没有 `lvglui.json` 的新工程上 `init` 只新增 `components/app_ui/**`、`lvglui.json` 与 `.lvglui/`（构建产物），不改任何现有文件；第二次 init 拒绝。
- [ ] `render --no-build` 在 shot 存在时 `buildMs === 0`；shot 缺失时自动构建。
- [ ] `doctor` 对 `#include "driver/gpio.h"` 的 UI 返回 fail，并给出可执行提示。
- [ ] 分辨率缺失/歧义时 render 失败并提示 `--width/--height` 或 `lvglui.json`，不悄悄用 240×320。
- [ ] MCP `initialize` 协商版本；`render_ui` 返回 image；`project` 缺省走 env/cwd。
- [ ] DSH 中能看到 `lvglui` skill 与 `mcp__lvglui__*` 工具；LLM 能在只改 uiDir 的前提下完成一次“加卡片”任务。
- [ ] `preview` 热重载可用；构建失败保留旧 DLL。
- [ ] `npm test` 与 `npm run test:integration` 通过（缺 my_lcd 时集成明确 skip）。

---

## 风险与手工 gate

- **DSH 是否渲染 MCP image**：若客户端只显示文本，LLM 仍可用 `meta.png` 路径 + `read_image`；skill 里已写 fallback。
- **`lv_obj_get_class` 与 `class->name`**：依赖 LVGL 私有头 `lv_obj_class_private.h`；升级 LVGL 小版本时先跑 host 集成测试。
- **`lv_font_source_han_sans_sc_16_cjk` 宏**：某些 9.x 小版本可能没有；`ui_theme.c` 用 `defined()` 保护，doctor 只 warning。
- **MSVC 环境**：vcvars 找不到时 doctor fail；不自动下载 VS。
- **MCP image 大小**：240×320 PNG 约 6KB，安全；大屏 800×480 可能 >1MB，`render_ui` 仍返回，但可在 skill 里建议先缩分辨率。
- **软约束绕过**：用户选择“只靠约定”；skill 明确禁止改业务文件，但工具不做审计。不要在本计划里加自动审计。
- **目标工程不是 git**：所有写操作不可逆；`init` 只新增、不覆盖；render 只写 `.lvglui/`。

---

## 开放问题（不阻塞开工，实施时确认）

- `CONFIG_LV_FONT_SOURCE_HAN_SANS_SC_16_CJK` 在 my_lcd 的 sdkconfig 中是否开启；若未开，预览仍强制开，固件中文可能显示方块，doctor 只 warning。
- 大屏（>480×320）preview 窗口是否缩放；v1 先 1:1。
- `init` 是否在 `main/CMakeLists.txt` 不存在时提示接入位置；v1 只打印片段，不自动改。

---

## 建议执行顺序

Task 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12 → 13 → 14 → 15 → 16 → 17。

Task 9 与 10 可以并行（host C 与纯 JS tree/诊断无共享状态）；Task 12 可与 13 并行。