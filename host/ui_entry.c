/**
 * @file ui_entry.c
 * @brief PC 宿主 ABI：把固件里的那一份界面，在 PC 上跑起来。
 *
 * 这个文件属于「工具」，不属于「界面」。它只做四件事：
 *   ui_attach / ui_tick / ui_pixels / ui_detach
 * 外加一个调试用的 ui_dump_tree（把当前控件树写成 JSON，给 agent 看）。
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
#include "core/lv_obj_class_private.h"

#ifndef LVGLUI_ENTRY
#error "LVGLUI_ENTRY 未定义：CLI 没找到界面入口函数（形如 lv_obj_t * home_create(lv_obj_t *)）"
#endif

/* 界面入口的声明：签名固定，函数名来自上面的宏。用 extern 而不是包含
   ui.h，这样旧的 sensor_ui_create 也能直接作为入口编译。 */
extern lv_obj_t * LVGLUI_ENTRY(lv_obj_t * parent);

#define MAX_TREE_DEPTH 16
#define MAX_TREE_NODES 500
#define MAX_TEXT_BYTES 256

static lv_obj_t * s_screen;
static lv_display_t * s_disp;
static uint8_t * s_fb;
static uint32_t s_version;
static int s_width;
static int s_height;
static bool s_attached;

#if LV_USE_OBJ_NAME
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
#endif

/* 从 `limit` 字节处截断，但不把 UTF-8 多字节序列切成半个。 */
static size_t utf8_limit(const char * s, size_t limit)
{
    size_t n = 0;
    while(n < limit && s[n]) n++;
    if(!s[n]) return n; /* 没截断 */

    size_t end = n;
    while(end > 0 && (((unsigned char)s[end - 1]) & 0xC0) == 0x80) end--;
    if(end > 0) {
        unsigned char lead = (unsigned char)s[end - 1];
        size_t need = 1;
        if((lead & 0xF8) == 0xF0) need = 4;
        else if((lead & 0xF0) == 0xE0) need = 3;
        else if((lead & 0xE0) == 0xC0) need = 2;
        if(end - 1 + need > n) n = end - 1;
    }
    return n;
}

static void json_escape_n(FILE * f, const char * s, size_t n)
{
    if(!s) return;
    for(size_t i = 0; i < n; i++) {
        unsigned char c = (unsigned char)s[i];
        switch(c) {
            case '"':  fputs("\\\"", f); break;
            case '\\': fputs("\\\\", f); break;
            case '\n': fputs("\\n", f); break;
            case '\r': fputs("\\r", f); break;
            case '\t': fputs("\\t", f); break;
            default:
                if(c < 0x20) fprintf(f, "\\u%04x", (unsigned)c);
                else fputc(c, f);
        }
    }
}

static void json_escape(FILE * f, const char * s)
{
    if(!s) return;
    json_escape_n(f, s, strlen(s));
}

static void json_string_n(FILE * f, const char * s, size_t n)
{
    fputc('"', f);
    json_escape_n(f, s, n);
    fputc('"', f);
}

static void json_string(FILE * f, const char * s)
{
    fputc('"', f);
    json_escape(f, s);
    fputc('"', f);
}

/*
 * 递归写一个节点。返回是否写入了内容：调用方只在实际写入的兄弟节点之间
 * 写逗号，这样深度/数量上限触发时不会留下悬空逗号。
 */
static bool dump_node(FILE * f, lv_obj_t * obj, int depth, int * count)
{
    if(!obj || depth > MAX_TREE_DEPTH || *count >= MAX_TREE_NODES) return false;
    (*count)++;

    const lv_obj_class_t * cls = lv_obj_get_class(obj);
    const char * cls_name = (cls && cls->name) ? cls->name : "";
    const char * name = "";
#if LV_USE_OBJ_NAME
    const char * obj_name = lv_obj_get_name(obj);
    if(obj_name) name = obj_name;
#endif

    fputs("{\"name\":", f);
    json_string(f, name);
    fputs(",\"cls\":", f);
    json_string(f, cls_name);
    fprintf(f, ",\"x\":%d,\"y\":%d,\"w\":%d,\"h\":%d,\"hidden\":%s",
            (int)lv_obj_get_x(obj), (int)lv_obj_get_y(obj),
            (int)lv_obj_get_width(obj), (int)lv_obj_get_height(obj),
            lv_obj_has_flag(obj, LV_OBJ_FLAG_HIDDEN) ? "true" : "false");

    if(strcmp(cls_name, "lv_label") == 0) {
        const char * text = lv_label_get_text(obj);
        if(!text) text = "";
        fputs(",\"text\":", f);
        json_string_n(f, text, utf8_limit(text, MAX_TEXT_BYTES));
    }
    else if(strcmp(cls_name, "lv_slider") == 0 || strcmp(cls_name, "lv_bar") == 0) {
        fprintf(f, ",\"value\":%d", (int)lv_bar_get_value(obj));
    }
    else if(strcmp(cls_name, "lv_switch") == 0) {
        fprintf(f, ",\"checked\":%s",
                lv_obj_has_state(obj, LV_STATE_CHECKED) ? "true" : "false");
    }

    fputs(",\"children\":[", f);
    bool first = true;
    uint32_t n = lv_obj_get_child_count(obj);
    for(uint32_t i = 0; i < n; i++) {
        lv_obj_t * child = lv_obj_get_child(obj, (int32_t)i);
        /* 与 dump_node 的早退条件保持一致，保证下面这行逗号后一定有节点。 */
        if(!child || depth + 1 > MAX_TREE_DEPTH || *count >= MAX_TREE_NODES) continue;
        if(!first) fputc(',', f);
        first = false;
        dump_node(f, child, depth + 1, count);
    }
    fputs("]}", f);
    return true;
}

void ui_dump_tree(const char * path)
{
    if(!path) return;
    FILE * f = fopen(path, "wb");
    if(!f) return;

    int count = 0;
    fputs("{\"root\":", f);
    lv_obj_t * root = lv_screen_active();
    if(root) dump_node(f, root, 0, &count);
    else fputs("null", f);
    fprintf(f, ",\"nodes\":%d}", count);
    fclose(f);
}

int ui_attach(int width, int height)
{
    if(width <= 0 || height <= 0) return -1;

    s_width = width;
    s_height = height;

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
#if LV_USE_OBJ_NAME
    dump_names(s_screen, 0);
#endif

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
    if(w) *w = s_width;
    if(h) *h = s_height;
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