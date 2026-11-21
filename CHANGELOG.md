# Changelog

All notable changes to lvglui are documented here.

## Unreleased
- `doctor` 新增 `writable` / `appendOnly` / `readonly` 三组路径清单：可改 `<uiDir>/**`；`ui_port.h` 只追加声明、`ui_port_stub.c` 只改 host 桩；`ui_port_impl.c`、`sdkconfig*`、`main/**`、工程级 `CMakeLists.txt`、`managed_components/**` 只读。这是 skill 约定的机器可读版本，不改变任何检查结果。
- `memory.lvgl` 增加一句话 `summary`（例如 `LVGL heap 59.5 KB: 31% used (18.1 KB), peak 18.8 KB, 41.4 KB free`），CLI 直接打印；`--all-pages` 的 `perPage` 每项也带。`total/free/maxUsed/usedPct/fragPct` 等结构化字段不变。

## [1.0.0-rc.2] - 2026-11-21

Second release candidate. It closes the gaps that showed up when the tool was
driven by an agent: concurrent builds corrupting each other, clipped text that
looked fine in the tree, artifacts that were easy to measure by mistake, and a
preview that froze on the second repaint. Still a release candidate until a
clean-machine install and public CI run are confirmed.

### Added

- Multi-page rendering: a UI that defines `ui_page_count` / `ui_page_name` /
  `ui_page_show` can render every page at once (`render --all-pages`, one PNG
  per page plus a `shot-sheet.png` contact sheet) or one page
  (`render --page <name|n>`). MCP's `render_ui` exposes `page` / `allPages`;
  `meta.json` lists per-page name, SHA-256 and node count.
- `lvglui new <name>` scaffolds `include/pages/<name>.h` and
  `src/pages/<name>.c` into an `init`-generated template, appends the page to
  `ui_pages.c`, and syncs explicit `SRCS`. Files are backed up to
  `.lvglui/backup/` and a failed insert rolls back; anything that is not the
  template's page table is rejected, not guessed. `--dry-run` reports only.
- `render --scroll <y|name=y|name=top|bottom>` samples the visible viewport at
  a pinned scroll offset and records the resolved widget and offset in
  `meta.json.scroll`. The preview window scrolls the deepest scrollable
  container under the pointer with the wheel (Shift for horizontal), using
  LVGL's own `lv_obj_scroll_to_*`.
- LVGL heap visibility: `render` / `render_ui` report `memory.lvgl`
  (`total/free/maxUsed/usedCount/usedPct/fragPct`) from the same `LV_MEM_SIZE`
  pool the firmware uses; `--max-heap-pct` sets `budget.exceeded` when usage is
  over the limit. With `--all-pages` each page carries its own numbers, the
  top-level value is the worst page, and `perPage` lists every page.
- Diagnostics for agents: `doctor` reports the tool version and CLI path,
  checks fonts according to `font.mode`, checks whether the firmware disabled
  `LV_USE_OBJ_NAME` while the UI calls `lv_obj_set_name()`, and compares
  `ui_port.h` declarations with `ui_port_impl.c` definitions (a missing
  accessor means the firmware will fail at link time). `render` puts missing
  project-font glyphs (with code points) into `warnings` and `meta.font`.
  `--version` prints the tool version and CLI path.
- MCP gained a `font` tool (`add` / `off` / `status`); `font add` now returns
  the `created` / `updated` / `removed` files it touched.
- `tree.json` gained `absX` / `absY` (screen coordinates next to the
  parent-relative `x` / `y`) and `selfW` / `selfH` / `overflow` /
  `scrollable`. `render` emits `[clip] ...` warnings when a widget's content is
  larger than its own box, or a child lies outside a parent that neither
  scrolls nor shows overflow.
- Named single-page artifacts: `render --page` also writes
  `shot-<page>.png` / `tree-<page>.json` and returns `artifact`
  (`png/tree/bytes/sha256`), so two runs can be compared without guessing which
  file is current.
- Cross-process build mutex: the CLI, MCP server and preview watcher share
  `<build>/.build-lock` (a directory with `owner.json` recording pid and
  purpose; a dead owner is reclaimed). A waiting build returns `BUILD_BUSY`
  with the holder and a concrete next step; other CMake/Ninja failures carry
  `code: BUILD_FAILED`, `firstError`, parsed `diagnostics` and the log path.
  `preview --stop` / MCP `preview_ui {stop:true}` closes the window this tool
  started.
- Preview window options: `preview --topmost` keeps the window above others
  (`Ctrl+Alt+T` toggles it at runtime, the title shows `[topmost]`), and the
  whole client area is draggable. Position and topmost state are remembered in
  `.lvglui/build/preview-window.txt`; the process is per-monitor DPI aware.
- Multi-page preview navigation: the title shows `page 2/3 settings`;
  `PgUp` / `PgDn`, `←` / `→` cycle pages and `1`–`9` jump directly;
  `preview --page <name>` starts on a page. This is viewer navigation only.
- `init` now generates a second component, `components/ui_port`
  (`ui_port.h` + `ui_port_impl.c`), and `app_ui` depends on it. The host build
  finds the header through `LVGLUI_PORT_INCLUDE`; `doctor` understands the new
  location. Putting `ui_port_impl.c` in `main/` is what produced
  `undefined reference to ui_port_*` on device.
- Docs and examples: an English README, a 240x320 sensor-dashboard showcase
  with the DeepSeek avatar, the no-flash/no-serial boundary, and page-local
  timer ownership rules in the skill.

### Changed

- The preview rebuild path caches the `vcvars64.bat` environment once
  (`.lvglui/build/build-fast.cmd`) and then runs only
  `cmake --build --target ui`; file polling is 50 ms with a 100 ms debounce,
  bringing save-to-refresh from about 2.4 s to about 1 s. `preview` also
  rebuilds its launcher when the tool's own host sources are newer than the
  project's `preview.exe`.
- Preview page switching caches and reuses each page's screen instead of
  destroying old screens: page-local `lv_timer` callbacks do not die with the
  screen, so destroying it made the window vanish after a few switches. The
  entry screen counts as page 1 when no `--page` is given.
- `doctor` can run before `init`: a missing UI directory or entry is a warning
  with the next step, not a failure (a `lvglui.json` that points at a bad
  directory or entry is still a failure). The quick-start order is
  doctor → init.
- The host no longer hard-codes `lv_theme_simple_init()`; `lv_display_create()`
  picks the theme from `LV_USE_THEME_DEFAULT / SIMPLE / MONO` exactly like the
  firmware, and a project calling `lv_display_set_theme()` in its UI entry is
  honored. Previously unstyled widgets (buttons, sliders, switches) differed
  between preview and device.
- `--width` / `--height` and sdkconfig resolution detection remain strict: the
  tool never falls back to 240x320.
- The DSH skill was updated: `ui_port_impl.c` is read-only (the header and the
  host stub may change), `--frames` means 33 ms per frame (70 frames ≈ 2.3 s,
  enough to see a 1 s timer), and a new page or data source must be planned
  first while single-page layout tweaks do not.

### Fixed

- The preview and headless renderer froze on the second repaint. The host
  created a display without a flush callback, so `disp->flushing` stayed 1 and
  the single-buffer path busy-waited in `wait_for_flushing()`. A callback that
  immediately calls `lv_display_flush_ready()` fixes it; a static 12-frame
  render never showed the bug while a 1 s label timer always did. Pixel
  baseline unchanged.
- Linker errors are parsed: MSVC `xxx.obj : error LNK2019` (no line or column)
  and GCC `undefined reference to ...` are reported with hints for the common
  `snprintf` / `strdup` C-mode case and missing `ui_port_*` implementations.
  `build.log` is decoded as UTF-8 with a GBK fallback, and stray `\r` no longer
  defeats the line patterns.
- CMake/Ninja state is cleared when `lvglui.json` inputs change (tool
  directory, uiDir, LVGL directory, entry, font, pages, port include), so edits
  no longer keep a stale cache.
- Generated font C files include `lvgl.h` instead of `lvgl/lvgl.h`, which the
  IDF component include paths did not resolve.

### Known issues

- Windows 10/11 only; ESP-IDF 6.x and LVGL 9.x only; 16-bit RGB565 only.
- No interaction simulation in 1.x: no click/drag/sequence scripting and no
  screenshot after a tap. Navigation is verified with `--page` plus tree
  coordinates. Interaction is planned for 2.0.
- No `ui_port` state injection: verifying empty/full/edge data still requires
  editing the host stub and rebuilding (`portJson` is backlog).
- The widget tree is bounded (depth 16, 500 nodes, 256 bytes of text; the
  compact MCP tree keeps 200 nodes), so very large UIs are truncated, though
  `truncated: true` is reported.
- `memory` is only available with LVGL's builtin allocator; with clib or a
  custom allocator there is no monitor and the field is omitted rather than
  estimated.
- `--all-pages` cannot be combined with `--scroll` or `--max-heap-pct`
  (each page runs in its own process).
- Font auto-integration patches `ui_theme.c` / `CMakeLists.txt` using marker
  comments; a hand-edited theme or a non-template page table is rejected
  instead of guessed. The `common` subset adds roughly 3 MB of C source.
- `serve` and `watch` have no automated tests; the pixel baseline requires the
  local `D:/esps3_test/my_lcd` project and is skipped on public CI.
- The design documents under `docs/superpowers/` are historical (2026-11-08);
  font modes and preview timings there are out of date — README and code are
  the source of truth.
- The DSH bundle embeds absolute paths generated by `lvglui dsh install`;
  moving the checkout requires regenerating the patch and reinstalling the
  bundle. MCP schema changes require a DSH restart.
- UI-layer boundaries are a skill convention, not an enforced write fence;
  there is no audit of files the model edits.
- Not published to npm (`private: true`); the DSH bundle is installed from a
  local directory. A clean-machine install and a public CI run are still
  pending, which is why this remains a release candidate.

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