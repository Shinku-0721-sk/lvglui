# Preview manual smoke — Task 12

Date: 2026-11-08
Branch: `lvglui-generalization`
Host: Windows 11 (10.0.22621), Node 22, MSVC + CMake + Ninja.
Project used: `D:/esps3_test/my_lcd` (240x320, UI sources in `components/app_ui`).

Result: the process-level smoke passed, including an asynchronous rebuild and
`ui.dll` reload. This session is headless: no interactive desktop was available,
so window pixels, the title text, and `VK_ESCAPE` could not be observed. Do not
read this note as a visual pass.

## Prerequisites

- Build the preview host once (or let `previewProject` build it). The generated
  command is the only supported build path:

  ```bat
  cmd.exe /c "D:\esps3_test\my_lcd\.lvglui\build\build.cmd"
  ```

- `D:/esps3_test/my_lcd` has no `lvglui.json` and no `sdkconfig` display values.
  `loadContext` therefore refuses to guess a display size (it never defaults to
  240x320). Pass `cliWidth: 240, cliHeight: 320` explicitly, as below.

## Launch

Directly from the build directory:

```bat
cd /d D:\esps3_test\my_lcd\.lvglui\build
preview.exe ^
  --dll D:\esps3_test\my_lcd\.lvglui\build\ui.dll ^
  --project D:\esps3_test\my_lcd ^
  --ui-dir D:\esps3_test\my_lcd\components\app_ui ^
  --build-dir D:\esps3_test\my_lcd\.lvglui\build ^
  --build-cmd D:\esps3_test\my_lcd\.lvglui\build\build.cmd ^
  --width 240 --height 320
```

Or through the Core helper (the future CLI entry point; keep the launching shell
alive in this agent harness):

```bat
cd /d D:\LVGL_preview
node --input-type=module -e "import { loadContext } from './core/context.mjs'; import { previewProject } from './core/preview.mjs'; const ctx = loadContext({ projectDir: 'D:/esps3_test/my_lcd', cliWidth: 240, cliHeight: 320 }); console.log(previewProject(ctx));"
```

Expected: title `LVGL Preview 240x320  -  ready  (Esc to quit)` and four
`[ui] name ...` lines on the console.

## Manual hot-reload check

1. Leave the preview window open.
2. Edit a `.c` or `.h` under `D:\esps3_test\my_lcd\components\app_ui`
   (for example `sensor_dashboard.c`) and save it.
3. Within roughly 300 ms the title changes to `building...` and the console shows
   `[host] change detected, rebuilding...`. The old UI stays visible while
   `build.cmd` runs in the background.
4. On success the console shows `[host] reloaded ok`, the new UI is re-attached,
   and the title returns to `ready`. A new `ui_live_N.dll` exists in the build
   directory.
5. A compile failure must keep the previous UI and title `build failed (see
   build.log)`; the log is `<build-dir>\build.log`.
6. Press `Esc` to exit; a normal exit removes the current `ui_live_N.dll`.

## Actual smoke result

Command/output highlights from this session:

- Host build: `build.cmd` reconfigured and built `host/preview_main.c`, then
  linked `preview.exe` with no compiler errors.
- `previewProject` returned `{ ok: true, pid: 4876, error: null }` with exactly
  the arguments shown above plus `--watch
  D:\LVGL_preview\test\.tmp\task12-smoke\probe.txt`.
- Initial load created `ui_live_1.dll` and printed:
  `[ui] name val_temp`, `val_hum`, `val_press`, `val_lux`.
- The UI sources were not modified (task constraint). The same fingerprint /
  rebuild path was triggered through the extra `--watch` file instead: writing
  `probe.txt` at 15:38:34.136Z produced `[host] change detected, rebuilding...`.
- At 15:38:36.805Z both `ui_live_1.dll` and `ui_live_2.dll` were present, the UI
  re-attached and printed its four names again, and the console logged
  `[host] reloaded ok`. This is the asynchronous build + reload path working.
- `taskkill /PID 4876 /F` returned success and the process was gone afterwards.
  The forced kill leaves `ui_live_2.dll` behind; that file is disposable state.
- Missing-binary path: with `preview.exe` renamed away, `previewProject` resolved
  the toolchain, ran `buildHost`, rebuilt `preview.exe` in 2720 ms, and started
  pid 29596 successfully (then killed it).
- Tests: `node --test test/unit/preview.test.mjs` -> 4 pass, 0 fail.
  `npm test` -> 140 pass, 0 fail, 0 skipped.

## Limitations of this smoke

- No desktop pixels or screenshots: the window was never inspected visually, so
  rendering correctness and the actual title text remain unverified.
- `VK_ESCAPE` was not exercised (no keyboard input to the window); the handler is
  present in `host/preview_main.c` and was verified by code inspection only.
- Build-failure preservation (old DLL kept, `build failed (see build.log)`) was
  not induced in this smoke, because the UI sources were protected and no
  deliberate broken build was introduced.