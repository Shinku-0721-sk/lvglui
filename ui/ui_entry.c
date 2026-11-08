/**
 * @file ui_entry.c
 * @brief PC 宿主 ABI：把固件里的那一份界面，在 PC 上跑起来。
 *
 * 这个文件属于「工具」，不属于「界面」。它只做四件事：
 *   ui_attach / ui_tick / ui_pixels / ui_detach
 * 界面本身来自 LVGLUI_UI_DIR（默认 components/app_ui）里的 .c —— 与固件
 * 编译的是同一批文件，所以预览与真机不可能对不上。
 *
 * 入口函数由 CMake 传进来：-DLVGLUI_ENTRY=home_create
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "lvgl.h"
#include "ui_host.h"

#ifndef LVGLUI_ENTRY
#error "LVGLUI_ENTRY 未定义：CLI 没找到界面入口函数（形如 lv_obj_t * home_create(lv_obj_t *)）"
#endif

/* 界面入口的声明：签名固定，函数名来自上面的宏 */
lv_obj_t * LVGLUI_ENTRY(lv_obj_t * parent);

#ifndef LVGLUI_WIDTH
#define LVGLUI_WIDTH 240
#endif
#ifndef LVGLUI_HEIGHT
#define LVGLUI_HEIGHT 320
#endif

#define SCR_W LVGLUI_WIDTH
#define SCR_H LVGLUI_HEIGHT

static lv_obj_t * s_screen;
static lv_display_t * s_disp;
static uint8_t * s_fb;
static uint32_t s_version;
static bool s_attached;

/* 把树里所有设过名字的控件打印出来：固件那边靠 lv_obj_find_by_name 找它们，
   名字打错在真机上是"界面能显示但点了没反应"，没有任何报错。 */
static void dump_names(lv_obj_t * obj, int depth)
{
    uint32_t n = lv_obj_get_child_count(obj);
    for(uint32_t i = 0; i < n; i++) {
        lv_obj_t * child = lv_obj_get_child(obj, (int32_t)i);
        const char * name = lv_obj_get_name(child);
        if(name && name[0]) printf("[ui] name %*s%s\n", depth * 2, "", name);
        dump_names(child, depth + 1);
    }
}

int ui_attach(int width, int height)
{
    if(width != SCR_W || height != SCR_H) return -1;

    lv_init();

    s_disp = lv_display_create(width, height);
    lv_display_set_color_format(s_disp, LV_COLOR_FORMAT_RGB565);

    size_t sz = (size_t)width * (size_t)height * 2u;
    s_fb = (uint8_t *)malloc(sz);
    if(!s_fb) return -2;
    memset(s_fb, 0, sz);
    lv_display_set_buffers(s_disp, s_fb, NULL, sz, LV_DISPLAY_RENDER_MODE_FULL);

    lv_display_set_theme(s_disp, lv_theme_simple_init(s_disp));

    s_screen = LVGLUI_ENTRY(NULL);
    if(!s_screen) {
        fprintf(stderr, "[ui] 入口函数返回了 NULL\n");
        return -3;
    }
    lv_screen_load(s_screen);
    dump_names(s_screen, 0);

    s_version = 1;
    lv_refr_now(s_disp);
    s_attached = true;
    return 0;
}

int ui_tick(uint32_t ms)
{
    if(!s_attached) return 0;
    lv_tick_inc(ms);
    lv_timer_handler();
    lv_refr_now(s_disp);
    s_version++;
    return 1;
}

const void * ui_pixels(int * w, int * h, uint32_t * version)
{
    if(!s_attached) return NULL;
    if(w) *w = SCR_W;
    if(h) *h = SCR_H;
    if(version) *version = s_version;
    return s_fb;
}

void ui_detach(void)
{
    if(!s_attached) return;
    s_attached = false;
    s_screen = NULL;
    lv_deinit();
    s_disp = NULL;
    free(s_fb);
    s_fb = NULL;
}