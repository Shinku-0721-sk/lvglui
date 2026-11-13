# Changelog

All notable changes to lvglui are documented here.

## Unreleased
- 构建互斥与可诊断失败：CLI/MCP/预览 watcher 共用 `.lvglui/build/.build-lock`（`owner.json` 记录 pid/purpose，持有者进程已死会自动回收）。并发构建不再互相破坏 CMake/Ninja 状态；拿不到锁返回 `BUILD_BUSY`（含持有者 pid 与处理建议），其余 CMake/ninja 失败统一带 `code:BUILD_FAILED`、`firstError`、`diagnostics` 与日志路径。新增 `preview --stop`（MCP `preview_ui {stop:true}`）关闭本工具启动的窗口。单页渲染同时写 `shot-<page>.png` / `tree-<page>.json` 并返回 `artifact`；`tree.json` 增加 `selfW/selfH/overflow/scrollable`，`render` 对“内容超出自身盒子 / 子控件落在不滚动父容器外”给出 `[clip]` 警告。
- 诊断与 AI 协作收口：`doctor` 现在报告工具版本与 CLI 路径、按 `font.mode` 正确判断字体（`project` 走真实缺字检查、不再误报未启用内置 CJK）、检查 `LV_USE_OBJ_NAME` 是否被固件关闭、并比对 `ui_port.h` 声明与 `ui_port_impl.c` 定义（缺实现时提示固件会链接失败）；`--version` 可直接打印版本。`render` 在 `font.mode=project` 时把缺字写进 `warnings` 与 `meta.font`；`--all-pages` 每页带 `memory`，顶层 `memory.lvgl` 取最坏页并附 `perPage`；`tree.json` 增加 `absX`/`absY` 绝对坐标。MCP 新增 `font` 工具（add/off/status），`font add` 返回并打印 `created/updated/removed` 文件清单。skill 明确 `ui_port_impl.c` 只读（可改 `ui_port.h`/`ui_port_stub.c`）、放宽“先计划再写”的触发条件、说明 `--frames` 即时间并引用新的 font 工具。
- 内存可见性：`render`/`render_ui` 返回 `memory.lvgl`（LVGL 堆的 `total/free/maxUsed/usedCount/usedPct/fragPct`，与固件同一个 `LV_MEM_SIZE` 池），新增 `--max-heap-pct 1-100` 检查并置 `budget.exceeded`；preview 在 attach/切页后打印同一行，skill 增加内存预算约束（超限先降级再交付）。

- 多页渲染：实现 `ui_page_count`/`ui_page_name`/`ui_page_show` 的界面可用 `render --all-pages` 逐页出图并拼 `shot-sheet.png` 总览，或用 `--page <name>` 单页渲染；MCP 的 `render_ui` 增加 `page`/`allPages`。没有契约的工程行为不变。
- `init` 模板新增 `include/ui_pages.h` 与 `src/ui_pages.c`（默认一页 `home`）。
- 实时预览：整块画面都可拖动窗口，位置写入 `.lvglui/build/preview-window.txt` 并在下次原位恢复；进程改为 per-monitor DPI aware。
- 实时预览：首次启动缓存 `vcvars64.bat` 环境到 `.lvglui/build/build-fast.cmd`，之后每次保存只跑 `cmake --build --target ui`；文件轮询 50ms、防抖 100ms。实测保存到刷新从约 2.4s 降到约 1.0s。
- `preview` 会在工具自身的 `host/*.c`/`CMakeLists.txt` 比工程里的 `preview.exe` 新时自动重建启动器，避免升级后仍跑旧窗口行为。
- 实时预览新增置顶：`preview --topmost` 一开始就把窗口放在最上层，运行中按 `Ctrl+Alt+T` 可随时切换，标题栏显示 `[topmost]`，并与窗口位置一起记住；MCP 的 `preview_ui` 也接受 `topmost: true`。
- `doctor` 可以在 `init` 之前跑：UI 还没注入时 `uiDir`/`entry` 只给 warn 和下一步提示，不再整体失败（`lvglui.json` 已存在但指向无效目录/入口仍是 fail）；快速开始顺序调整为 doctor → init。`doctor` 的 detail 也不再打印 `[object Object]`。
- `init` 现在生成两个组件：`components/app_ui`（UI）和旁边的 `components/ui_port`（`ui_port.h` + `ui_port_impl.c`），`app_ui` 的 `REQUIRES` 带上 `ui_port`。这样 `ui_port_*` 的实现不再需要（也不能）放进 `main/`：`libmain.a` 排在 `libapp_ui.a` 之前且只扫描一次，放在 main 里固件会报 `undefined reference to ui_port_*`。host 预览通过新的 `LVGLUI_PORT_INCLUDE` cache 找到 `ui_port.h`；`doctor` 的 `uiPort` 检查也认识新位置。
- 修复实时预览/无头渲染在界面第二次刷新时冻死：host 建了 display 却没注册 flush 回调，`disp->flushing` 置 1 后再没人清除，单缓冲路径下一次刷新会卡在 `wait_for_flushing()` 的忙等里（表现为静止画面正常，一旦界面更新就整窗僵住、点关闭无反应；1 秒定时器改 label 必现）。现在 host 注册一个立即调用 `lv_display_flush_ready()` 的 flush 回调，像素基线不变。
- 新增 `lvglui new <name>`：在 `init` 生成的模板工程里生成 `include/pages/<name>.h` 与 `src/pages/<name>.c`，把注册行追加到 `ui_pages.c` 的页面表末尾，并在组件用显式 `SRCS` 时同步更新 `CMakeLists.txt`。写前备份到 `.lvglui/backup/`，页面表或 CMake 结构失配直接报错不猜，写入失败自动回滚；`--dry-run` 只报告改动。只做 CLI，不加 MCP 工具。
- `preview` 支持多页查看：标题显示当前页 `page 2/3 settings`，`PgUp`/`PgDn`、`←`/`→` 循环切页，`1`–`9` 直跳，`--page <name>` 指定启动页；切页重建屏幕树并销毁旧页，热重载停在同一页。新增导出 `ui_page_index`/`ui_goto_page`（`ui.dll` 不实现多页契约时窗口行为不变）。这是查看器导航，不含输入注入。
- `preview` 切页改为按页缓存并复用屏幕，不再销毁旧屏：页面里创建的 `lv_timer` 不随屏幕销毁，删屏后回调会访问已释放的控件，表现为切几次页窗口直接消失。无 `--page` 启动时把模板入口（第 0 页）视为第 1 页，第一次按 `→` 不再原地重建首页。
- 构建失败时能报出链接错误：新增对 `xxx.obj : error LNK2019: …` 这类无行号的 MSVC 链接错误和 GCC `undefined reference to …` 的解析，按 `file|line|code|message` 去重，并给出 `snprintf/strdup` 在 MSVC C 模式缺失、缺符号实现的提示；`render`/`build` 读 `build.log` 改用 UTF-8→GBK 回退解码，cmd 输出的 `\r` 不再让行尾规则失效。
- `render --scroll` 与预览滚轮：`render` 可先滚动再截图（`<y>`、`<name>=<y>`、`<name>=top|bottom`，偏移写进 `meta.json.scroll`，不能和 `--all-pages` 同用）；`preview` 支持滚轮滚动指针下最深的可滚容器（Shift 水平）。两者都调用 LVGL 自己的 `lv_obj_scroll_to_*`，截图仍只包含可视区，和固件同一套裁剪。
- 渲染主题不再由 host 硬编码：去掉 `lv_theme_simple_init()`，改由 `lv_display_create()` 按 `LV_USE_THEME_DEFAULT / SIMPLE / MONO` 自动选择，和固件走同一条路径；工程自己在 UI 入口调用 `lv_display_set_theme()` 也照样生效。此前含默认样式控件（按钮、滑杆、开关等）的界面在预览和固件上会不一致（实测一个未加样式的 `lv_button` 相差 5% 像素）；已自己固定 simple 主题的工程（如 my_lcd）基线不变。README 补了"像素一致的前提"。

## [1.0.0-rc.1] - 2026-11-09

First release candidate. The tool is feature-complete for the documented
Windows + ESP-IDF 6.x + LVGL 9.x target, but is still a release candidate
until a clean-machine install and public CI run are confirmed.

### Added

- Project detection for existing ESP-IDF 6.x projects, including IDF and LVGL
  discovery from `lvglui.json`, build metadata and editor settings.
- `init` for adding a UI component and `lvglui.json` without overwriting
  existing project files.
- Headless rendering to `shot.png`, `tree.json` and `meta.json`, with
  deterministic frame ticking and a SHA-256 baseline.
- Compact LVGL widget tree for human and model inspection.
- Parameterized live preview with asynchronous rebuild, failed-load recovery
  and a visible foreground window.
- `doctor` diagnostics for project, display, toolchain and UI-layer hygiene.
- MCP stdio server with protocol negotiation and project defaults.
- DSH bundle: `lvglui` skill provider plus a stdio MCP client.
- Font modes: `labels`, `common` (GB2312 level-1 subset) and optional
  BYO FreeType runtime rendering.
- Bundled Noto Sans SC TTF and OFL license; `font add/off/status`.

### Changed

- The tool is no longer tied to `D:/esps3_test/my_lcd`; that project remains
  only as an optional integration baseline.
- Build and output directories moved under the target project's `.lvglui/`.
- The old `build.bat` / `build-cli.bat` scripts were removed in favor of
  generated, path-safe build scripts.

### Fixed

- Reusing a shared `.lvglui/build` directory after moving or cloning the tool
  no longer fails with a CMake source-directory mismatch; stale CMake/Ninja
  state is cleared while `lv_conf.h` is preserved.

### Security / licensing

- lvglui itself is AGPL-3.0-or-later.
- `ui-template/` and generated UI/configuration files carry the output
  exception in `LICENSE-EXCEPTION`.
- Noto Sans SC is SIL OFL 1.1; see `assets/fonts/OFL.txt` and `NOTICE`.

### Known limitations

- Windows 10/11 only.
- ESP-IDF 6.x and LVGL 9.x only; 16-bit color only.
- No interaction simulation (click, drag, animation) in headless renders.
- FreeType is BYO: no `esp_freetype`, partition table or filesystem image is
  provided; the preview host must have FreeType headers, library and DLL.
- Integration tests that need `D:/esps3_test/my_lcd` skip when it is absent.
- DSH bundle paths are generated for the current checkout; re-run
  `lvglui dsh install` after moving the tool directory.