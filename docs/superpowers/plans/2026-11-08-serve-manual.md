# Serve manual smoke — Task 14

Date: 2026-11-09
Branch: `lvglui-generalization`
Host: Windows 11 (10.0.22621), Node 22.23.2, MSVC + CMake + Ninja.
Project used: `D:/esps3_test/my_lcd` (240x320, no `lvglui.json`, UI sources in
`components/app_ui`).

Result: the headless process-level smoke passed. The HTTP page, `/shot.png`,
`/state` and `/events` all served the first render, and a second instance
bumped from 8765 to 8766. This session is headless: no browser window or
screenshot was captured, so this is not a visual pass. The target project's UI
sources were not edited, so a live hot-reload event was not observed; the
initial queued render and its SSE event exercise the same queue.

## Prerequisites

`D:/esps3_test/my_lcd` has neither `lvglui.json` nor display geometry in
`sdkconfig`, and the tool never defaults to 240x320. Pass the geometry
explicitly:

```bat
cd /d D:\\LVGL_preview
node cli/lvglui.mjs serve --project D:/esps3_test/my_lcd --width 240 --height 320
```

## What to check

1. Server starts on `http://127.0.0.1:8765` (or the next free port, up to
   `8774`). Logs go to stderr; stdout stays empty.
2. `GET /` returns HTML containing `<img id="shot" src="/shot.png">`.
3. `GET /shot.png` returns `image/png` with the baseline hash
   `8f3a7ad7e177e94953547ae30e47149d5139de638d87a56449a2f9ea03ddd287`.
4. `GET /state` returns the last render JSON; `GET /events` is an SSE stream
   that sends a `data:` line (immediately if a render already finished, then
   after every queued render).
5. Start a second instance while the first is running: it logs
   `port 8765 busy, trying 8766` and serves on 8766.

## Actual smoke result

Commands/output highlights from this session:

- `serve` logged:

  ```text
  [lvglui] serve http://127.0.0.1:8765
  [lvglui] project=D:\esps3_test\my_lcd out=D:\esps3_test\my_lcd\.lvglui\out
  ```

- `GET /`: `200 text/html; charset=utf-8`, page contains
  `<img id="shot" src="/shot.png">`.
- `GET /shot.png`: `200 image/png`, 5854 bytes, SHA-256 equal to the baseline
  above.
- `GET /state` after the initial render:

  ```json
  {"t":1794154853604,"ok":true,"bust":1794154853604,"frames":12,
   "timings":{"buildMs":1873,"shotMs":56,"encodeMs":19},"error":null,
   "diagnostics":{"summary":{"errors":0,"warnings":0,"total":0},"errors":[],"hints":[]}}
  ```

- `GET /events`: `200 text/event-stream; charset=utf-8`, first frame:

  ```text
  retry: 1000

  data: {"t":1794154853604,"ok":true,"bust":1794154853604,"frames":12,
         "timings":{"buildMs":1873,"shotMs":56,"encodeMs":19},"error":null, ...}
  ```

- Second instance:

  ```text
  [lvglui] port 8765 busy, trying 8766
  [lvglui] serve http://127.0.0.1:8766
  ```

  `GET http://127.0.0.1:8766/` and `/shot.png` both returned `200`.

## Implementation note

`renderProject` uses `spawnSync`, so serving it directly from the HTTP handler
would freeze the event loop. `serve` instead spawns the CLI itself
(`node cli/lvglui.mjs render ... --json`) one render at a time, coalesces
requests that arrive while a render is running, and broadcasts the child's
JSON result over SSE. The page cache-busts `/shot.png` after each `ok` event.

## Limitations

- Headless session: no browser pixels, no `<img>` decode check.
- No `.c`/`.h` was modified under `D:/esps3_test/my_lcd/components/app_ui`
  (test constraint), so the debounce + hot-reload path is covered only by the
  initial queued render, not by a post-start file change.
- SSE reconnect behavior (`retry: 1000`) was not exercised across a server
  restart.