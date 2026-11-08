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

#ifdef __cplusplus
}
#endif

#endif /* UI_HOST_H */
