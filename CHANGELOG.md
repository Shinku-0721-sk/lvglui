# Changelog

All notable changes to lvglui are documented here.

## Unreleased

- 多页渲染：实现 `ui_page_count`/`ui_page_name`/`ui_page_show` 的界面可用 `render --all-pages` 逐页出图并拼 `shot-sheet.png` 总览，或用 `--page <name>` 单页渲染；MCP 的 `render_ui` 增加 `page`/`allPages`。没有契约的工程行为不变。
- `init` 模板新增 `include/ui_pages.h` 与 `src/ui_pages.c`（默认一页 `home`）。
- 实时预览：整块画面都可拖动窗口，位置写入 `.lvglui/build/preview-window.txt` 并在下次原位恢复；进程改为 per-monitor DPI aware。
- 实时预览：首次启动缓存 `vcvars64.bat` 环境到 `.lvglui/build/build-fast.cmd`，之后每次保存只跑 `cmake --build --target ui`；文件轮询 50ms、防抖 100ms。实测保存到刷新从约 2.4s 降到约 1.0s。
- `preview` 会在工具自身的 `host/*.c`/`CMakeLists.txt` 比工程里的 `preview.exe` 新时自动重建启动器，避免升级后仍跑旧窗口行为。
- 实时预览新增置顶：`preview --topmost` 一开始就把窗口放在最上层，运行中按 `Ctrl+Alt+T` 可随时切换，标题栏显示 `[topmost]`，并与窗口位置一起记住；MCP 的 `preview_ui` 也接受 `topmost: true`。
- `doctor` 可以在 `init` 之前跑：UI 还没注入时 `uiDir`/`entry` 只给 warn 和下一步提示，不再整体失败（`lvglui.json` 已存在但指向无效目录/入口仍是 fail）；快速开始顺序调整为 doctor → init。`doctor` 的 detail 也不再打印 `[object Object]`。
- `init` 现在生成两个组件：`components/app_ui`（UI）和旁边的 `components/ui_port`（`ui_port.h` + `ui_port_impl.c`），`app_ui` 的 `REQUIRES` 带上 `ui_port`。这样 `ui_port_*` 的实现不再需要（也不能）放进 `main/`：`libmain.a` 排在 `libapp_ui.a` 之前且只扫描一次，放在 main 里固件会报 `undefined reference to ui_port_*`。host 预览通过新的 `LVGLUI_PORT_INCLUDE` cache 找到 `ui_port.h`；`doctor` 的 `uiPort` 检查也认识新位置。
- 修复实时预览/无头渲染在界面第二次刷新时冻死：host 建了 display 却没注册 flush 回调，`disp->flushing` 置 1 后再没人清除，单缓冲路径下一次刷新会卡在 `wait_for_flushing()` 的忙等里（表现为静止画面正常，一旦界面更新就整窗僵住、点关闭无反应；1 秒定时器改 label 必现）。现在 host 注册一个立即调用 `lv_display_flush_ready()` 的 flush 回调，像素基线不变。
- 构建失败时能报出链接错误：新增对 `xxx.obj : error LNK2019: …` 这类无行号的 MSVC 链接错误和 GCC `undefined reference to …` 的解析，按 `file|line|code|message` 去重，并给出 `snprintf/strdup` 在 MSVC C 模式缺失、缺符号实现的提示；`render`/`build` 读 `build.log` 改用 UTF-8→GBK 回退解码，cmd 输出的 `\r` 不再让行尾规则失效。

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