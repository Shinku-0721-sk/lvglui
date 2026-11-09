# Changelog

All notable changes to lvglui are documented here.

## Unreleased

- 多页渲染：实现 `ui_page_count`/`ui_page_name`/`ui_page_show` 的界面可用 `render --all-pages` 逐页出图并拼 `shot-sheet.png` 总览，或用 `--page <name>` 单页渲染；MCP 的 `render_ui` 增加 `page`/`allPages`。没有契约的工程行为不变。
- `init` 模板新增 `include/ui_pages.h` 与 `src/ui_pages.c`（默认一页 `home`）。

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