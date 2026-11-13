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
#ifdef LVGLUI_FONT_APPLY
extern void lvglui_apply_font(lv_obj_t * root);
#endif
#ifdef LVGLUI_HAS_PAGES
/* 页面契约（可选）：与 ui_entry.c 之间只传函数指针，不共享结构体。 */
extern int ui_page_count(void);
extern const char * ui_page_name(int index);
extern lv_obj_t * ui_page_show(int index, lv_obj_t * parent);
#endif

#define MAX_TREE_DEPTH 16
#define MAX_TREE_NODES 500
#define MAX_TEXT_BYTES 256

static lv_obj_t * s_screen;
/* 预览切页时缓存每页的根屏；见 ui_goto_page() 里不删旧屏的理由。 */
static lv_obj_t ** s_page_screens;
static int s_page_screens_n;
static lv_display_t * s_disp;
static uint8_t * s_fb;
static uint32_t s_version;
static int s_width;
static int s_height;
static bool s_attached;
/* -1 = 走 LVGLUI_ENTRY（单入口老路子）；>=0 = 走 ui_page_show(index)。 */
static int s_page = -1;

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
    lv_area_t coords;
    lv_obj_get_coords(obj, &coords);
    fprintf(f, ",\"x\":%d,\"y\":%d,\"w\":%d,\"h\":%d,\"absX\":%d,\"absY\":%d"
            ",\"selfW\":%d,\"selfH\":%d,\"overflow\":%s,\"scrollable\":%s,\"hidden\":%s",
            (int)lv_obj_get_x(obj), (int)lv_obj_get_y(obj),
            (int)lv_obj_get_width(obj), (int)lv_obj_get_height(obj),
            (int)coords.x1, (int)coords.y1,
            (int)lv_obj_get_self_width(obj), (int)lv_obj_get_self_height(obj),
            lv_obj_has_flag(obj, LV_OBJ_FLAG_OVERFLOW_VISIBLE) ? "true" : "false",
            lv_obj_has_flag(obj, LV_OBJ_FLAG_SCROLLABLE) ? "true" : "false",
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

int ui_page_total(void)
{
#ifdef LVGLUI_HAS_PAGES
    int n = ui_page_count();
    return n > 0 ? n : 0;
#else
    return 0;
#endif
}

const char * ui_page_name_at(int index)
{
#ifdef LVGLUI_HAS_PAGES
    if(index < 0 || index >= ui_page_total()) return NULL;
    const char * name = ui_page_name(index);
    return (name && name[0]) ? name : NULL;
#else
    (void)index;
    return NULL;
#endif
}

int ui_set_page(int index)
{
    if(index < -1) return -1;
#ifdef LVGLUI_HAS_PAGES
    if(index >= ui_page_total()) return -1;
#else
    if(index >= 0) return -1;
#endif
    s_page = index;
    return 0;
}

int ui_page_index(const char * name)
{
#ifdef LVGLUI_HAS_PAGES
    if(!name || !name[0]) return -1;
    int total = ui_page_total();
    for(int i = 0; i < total; i++) {
        const char * page = ui_page_name(i);
        if(page && strcmp(page, name) == 0) return i;
    }
#else
    (void)name;
#endif
    return -1;
}

/* 实时预览切页：每页建一次、之后复用缓存的屏幕。
   不删旧屏：页面可能创建了不挂在屏幕对象下的 lv_timer，删屏会让它的回调
   在下一拍访问已释放的控件。缓存的上限是"页数"，不会随按键次数增长。 */
int ui_goto_page(int index)
{
    if(!s_attached) return -1;
#ifdef LVGLUI_HAS_PAGES
    int total = ui_page_total();
    if(index < 0 || index >= total) return -1;

    lv_obj_t * next = NULL;
    if(s_page_screens && index < s_page_screens_n) next = s_page_screens[index];
    if(!next) {
        next = ui_page_show(index, NULL);
        if(!next) return -1;
        if(s_page_screens && index < s_page_screens_n) s_page_screens[index] = next;
    }
    if(next != lv_screen_active()) lv_screen_load(next);
    s_screen = next;
    s_page = index;
#ifdef LVGLUI_FONT_APPLY
    lvglui_apply_font(next);
#endif
    lv_refr_now(s_disp);
    s_version++;
    return 0;
#else
    (void)index;
    return -1;
#endif
}

/* ---- 滚动 --------------------------------------------------------------
 * LVGL 只画可视区：滚动容器超出视口的部分被裁剪，不会进入帧缓冲。所以
 * “滚到某个位置再截图”不需要新的渲染路径，只要移动滚动偏移，得到的就是
 * 固件在同一偏移下的同一批像素。 */

static bool vertical_scrollable(lv_obj_t * obj)
{
    return lv_obj_has_flag(obj, LV_OBJ_FLAG_SCROLLABLE)
           && (lv_obj_get_scroll_dir(obj) & LV_DIR_VER) != 0;
}

static bool has_vertical_overflow(lv_obj_t * obj)
{
    return lv_obj_get_scroll_top(obj) > 0 || lv_obj_get_scroll_bottom(obj) > 0;
}

/* 深度优先找第一个“能竖着滚、且有内容可滚”的对象。 */
static lv_obj_t * first_scrollable(lv_obj_t * obj)
{
    if(!obj) return NULL;
    if(vertical_scrollable(obj) && has_vertical_overflow(obj)) return obj;
    uint32_t n = lv_obj_get_child_count(obj);
    for(uint32_t i = 0; i < n; ++i) {
        lv_obj_t * found = first_scrollable(lv_obj_get_child(obj, (int32_t)i));
        if(found) return found;
    }
    return NULL;
}

/* (x,y) 处最深的、可竖滚的对象。不用 lv_obj_hit_test：它要求 CLICKABLE，
   而滚动容器本身常常不可点击，它下面的 label 也不可点击。 */
static lv_obj_t * scrollable_at(lv_obj_t * obj, const lv_point_t * p)
{
    if(!obj) return NULL;
    lv_area_t a;
    lv_obj_get_coords(obj, &a);
    if(p->x < a.x1 || p->x > a.x2 || p->y < a.y1 || p->y > a.y2) return NULL;

    lv_obj_t * found = vertical_scrollable(obj) ? obj : NULL;
    uint32_t n = lv_obj_get_child_count(obj);
    for(uint32_t i = 0; i < n; ++i) {
        lv_obj_t * child = lv_obj_get_child(obj, (int32_t)i);
        if(!child || lv_obj_is_hidden(child)) continue;
        lv_obj_t * sub = scrollable_at(child, p);
        if(sub) found = sub;
    }
    return found;
}

int ui_scroll(const char * spec)
{
    if(!s_attached || !s_screen) return -1;
    if(!spec || !spec[0]) {
        fprintf(stderr, "[ui] scroll: 空参数\n");
        return -1;
    }

    char name[64] = {0};
    const char * value = spec;
    const char * eq = strchr(spec, '=');
    if(eq) {
        size_t len = (size_t)(eq - spec);
        if(len == 0 || len >= sizeof(name)) {
            fprintf(stderr, "[ui] scroll: 无法解析 \"%s\"\n", spec);
            return -1;
        }
        memcpy(name, spec, len);
        name[len] = 0;
        value = eq + 1;
    }

    lv_obj_t * target = NULL;
    if(name[0]) {
        target = lv_obj_find_by_name(s_screen, name);
        if(!target) {
            fprintf(stderr, "[ui] scroll: 找不到名为 \"%s\" 的控件\n", name);
            return -1;
        }
        if(!vertical_scrollable(target)) {
            fprintf(stderr, "[ui] scroll: \"%s\" 不能竖向滚动\n", name);
            return -1;
        }
    }
    else {
        target = first_scrollable(s_screen);
        if(!target) {
            fprintf(stderr, "[ui] scroll: 当前屏幕没有可竖向滚动的内容\n");
            return -1;
        }
    }

    int32_t y;
    int32_t current = lv_obj_get_scroll_y(target);
    if(strcmp(value, "bottom") == 0) {
        y = current + lv_obj_get_scroll_bottom(target);
    }
    else if(strcmp(value, "top") == 0) {
        y = 0;
    }
    else {
        char * end = NULL;
        long parsed = strtol(value, &end, 10);
        if(!end || *end != 0 || end == value) {
            fprintf(stderr, "[ui] scroll: \"%s\" 不是数字、top 或 bottom\n", value);
            return -1;
        }
        y = (int32_t)parsed;
    }

    lv_obj_scroll_to_y(target, y, LV_ANIM_OFF);
    lv_obj_update_layout(target);
    lv_refr_now(s_disp);
    s_version++;

    printf("scroll %s %d %d\n", name[0] ? name : "-",
           (int)lv_obj_get_scroll_x(target), (int)lv_obj_get_scroll_y(target));
    return 0;
}

int ui_wheel(int x, int y, int dx, int dy)
{
    if(!s_attached || !s_screen) return -1;
    lv_point_t p = { (lv_coord_t)x, (lv_coord_t)y };
    lv_obj_t * target = scrollable_at(s_screen, &p);
    if(!target) return -1;
    if(dx == 0 && dy == 0) return -1;

    if(dy) {
        if((lv_obj_get_scroll_dir(target) & LV_DIR_VER) == 0) return -1;
        lv_obj_scroll_to_y(target, lv_obj_get_scroll_y(target) + dy, LV_ANIM_ON);
    }
    if(dx) {
        if((lv_obj_get_scroll_dir(target) & LV_DIR_HOR) == 0) return -1;
        lv_obj_scroll_to_x(target, lv_obj_get_scroll_x(target) + dx, LV_ANIM_ON);
    }
    return 0;
}

/* 内存：预览与固件共用 LVGL 的 builtin 堆（lv_conf.h 的 LV_MEM_SIZE），
   所以这里的 used_pct / max_used 就是设备上 UI 层会看到的同一个池。
   换成 clib 或外部分配器时没有 monitor，返回 -1，让调用方别伪造数字。 */
int ui_mem_info(char * buf, int cap)
{
    if(!buf || cap <= 0) return -1;
#if defined(LV_USE_STDLIB_MALLOC) && defined(LV_STDLIB_BUILTIN)
#if LV_USE_STDLIB_MALLOC == LV_STDLIB_BUILTIN
    lv_mem_monitor_t mon;
    memset(&mon, 0, sizeof(mon));
    lv_mem_monitor(&mon);
    snprintf(buf, (size_t)cap,
             "mem total=%lu free=%lu max_used=%lu used_cnt=%lu used_pct=%u frag_pct=%u",
             (unsigned long)mon.total_size, (unsigned long)mon.free_size,
             (unsigned long)mon.max_used, (unsigned long)mon.used_cnt,
             (unsigned)mon.used_pct, (unsigned)mon.frag_pct);
    return 0;
#endif
#endif
    LV_UNUSED(cap);
    return -1;
}

/* 建根控件：有页面契约且指定了页就走页面，否则走单入口函数。 */
static lv_obj_t * build_root(void)
{
    if(s_page >= 0) {
#ifdef LVGLUI_HAS_PAGES
        return ui_page_show(s_page, NULL);
#else
        fprintf(stderr, "[ui] 指定了页 %d，但界面没有 ui_page_* 契约\n", s_page);
        return NULL;
#endif
    }
    return LVGLUI_ENTRY(NULL);
}

/* PC 端没有真实显示控制器：帧缓冲就是 s_fb，flush 立即算完成。
   必须调 lv_display_flush_ready() 清掉 disp->flushing；否则单缓冲路径
   会在下一次刷新时卡在 wait_for_flushing() 的忙等里（界面"冻住"）。 */
static void ui_flush_cb(lv_display_t * disp, const lv_area_t * area, uint8_t * px_map)
{
    LV_UNUSED(area);
    LV_UNUSED(px_map);
    lv_display_flush_ready(disp);
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
    lv_display_set_flush_cb(s_disp, ui_flush_cb);

    /* 主题跟随 lv_conf 和工程自己的选择：lv_display_create() 已按
       LV_USE_THEME_DEFAULT / SIMPLE / MONO 选好，和固件走同一条路径。
       不要在这里硬编码，否则没写显式样式的控件会和固件长得不一样；
       工程若在 UI 入口里自己调 lv_display_set_theme()，同样会生效。 */

#ifdef LVGLUI_HAS_PAGES
    free(s_page_screens);
    s_page_screens = NULL;
    s_page_screens_n = ui_page_total();
    if(s_page_screens_n > 0) {
        s_page_screens = (lv_obj_t **)calloc((size_t)s_page_screens_n, sizeof(*s_page_screens));
        if(!s_page_screens) s_page_screens_n = 0;
    }
#endif

    s_screen = build_root();
    if(!s_screen) {
        if(s_page >= 0) fprintf(stderr, "[ui] 第 %d 页没有返回根控件\n", s_page);
        else fprintf(stderr, "[ui] 入口函数返回了 NULL\n");
#ifdef LVGLUI_HAS_PAGES
        free(s_page_screens);
        s_page_screens = NULL;
        s_page_screens_n = 0;
#endif
        return -3;
    }
#ifdef LVGLUI_HAS_PAGES
    /* 模板工程的入口就是第 0 页（ui_start() -> ui_page_show(0, parent)），
       把它记进缓存，第一次切走再切回来就不用重建。 */
    if(s_page_screens && s_page_screens_n > 0) {
        if(s_page >= 0 && s_page < s_page_screens_n) s_page_screens[s_page] = s_screen;
        else s_page_screens[0] = s_screen;
    }
#endif
    lv_screen_load(s_screen);
#ifdef LVGLUI_FONT_APPLY
    lvglui_apply_font(s_screen);
#endif
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
    free(s_page_screens);
    s_page_screens = NULL;
    s_page_screens_n = 0;
    free(s_fb);
    s_fb = NULL;
}