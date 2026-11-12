/**
 * @file ui_host.h
 * The ABI between preview.exe (window shell) and ui.dll (LVGL + your UI).
 *
 * Everything LVGL lives inside ui.dll. The shell knows nothing about LVGL,
 * so reloading the DLL resets the whole engine cleanly -- no dangling
 * lv_obj pointers, no stale globals.
 */
#ifndef UI_HOST_H
#define UI_HOST_H

#include <stdint.h>

#ifdef UI_DLL_BUILD
#define UI_EXPORT __declspec(dllexport)
#else
#define UI_EXPORT
#endif

#ifdef __cplusplus
extern "C" {
#endif

/* Bring the engine up and build the UI into it. Returns 0 on success. */
UI_EXPORT int  ui_attach(int width, int height);

/* Advance time by `ms` and run one LVGL frame. Returns 1 if anything was
 * repainted (so the shell knows to invalidate the window). */
UI_EXPORT int  ui_tick(uint32_t ms);

/* Current framebuffer: RGB565, width*height*2 bytes, row-major.
 * `version` increases every time the pixels change. */
UI_EXPORT const void *ui_pixels(int *width, int *height, uint32_t *version);

/* Tear the engine down. Called right before the DLL is unloaded. */
UI_EXPORT void ui_detach(void);

/* Write the active screen's widget tree as JSON to `path`. Never writes
 * pixels and never triggers a refresh; a failed open is a silent no-op. */
UI_EXPORT void ui_dump_tree(const char *path);

/* ---- optional multi-page contract (host side) ---------------------------
 * A UI component may define ui_page_count / ui_page_name / ui_page_show;
 * CMake then compiles the host with LVGLUI_HAS_PAGES. These wrappers always
 * exist: without the contract they report 0 pages and refuse to switch, so
 * a single-entry project keeps working unchanged.
 */
UI_EXPORT int         ui_page_total(void);
UI_EXPORT const char *ui_page_name_at(int index);
/* Select the page the next ui_attach builds. -1 means "use LVGLUI_ENTRY". */
UI_EXPORT int         ui_set_page(int index);
/* Resolve a page name to its index; -1 when the contract or the name is absent. */
UI_EXPORT int         ui_page_index(const char *name);
/* Switch to another page on the live UI. The page is built on first visit and
 * then reused from a per-page cache; older screens are kept alive so timers
 * created by a page never outlive their widgets. -1 means "no contract / bad
 * index / build failed". */
UI_EXPORT int         ui_goto_page(int index);

/* ---- scrolling ---------------------------------------------------------
 * LVGL only ever draws the visible viewport; the off-screen part of a
 * scrollable object is clipped and never reaches the framebuffer. Moving the
 * scroll offset is therefore all a scrolled screenshot needs: the same
 * engine, the same clip, the same pixels as the firmware at that offset.
 */
/* `spec`: "<y>" scrolls the first vertically scrollable object on the active
 * screen, "<name>=<y>" scrolls the named widget (needs LV_USE_OBJ_NAME), and
 * "...=bottom" / "...=top" jump to the end. On success prints
 * `scroll <name|-> <x> <y>` to stdout and returns 0; -1 on a bad spec/target. */
UI_EXPORT int         ui_scroll(const char *spec);
/* Preview wheel: scroll the deepest scrollable object under (x, y) by the
 * pixel deltas. Returns 0 when something moved, -1 when nothing there
 * scrolls. */
UI_EXPORT int         ui_wheel(int x, int y, int dx, int dy);

#ifdef __cplusplus
}
#endif

#endif /* UI_HOST_H */
