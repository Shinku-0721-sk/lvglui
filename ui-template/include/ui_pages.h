#pragma once
#include "lvgl.h"

#ifdef __cplusplus
extern "C" {
#endif

/* 多页预览契约（可选）。
 *
 * 三个函数都实现时，`lvglui render --all-pages` 会逐页渲染出
 * shot-<name>.png，并额外拼一张 shot-sheet.png 总览图；固件侧行为不变，
 * 仍然从 ui_start() 进第一页。
 *
 * 一个都不实现时，工具退回单入口单屏，和加入页面表之前完全一样。
 *
 * ui_page_show(index, NULL) 应自己创建根 screen、加载它，并返回根控件；
 * parent 非 NULL 时只在 parent 里建这一页，不要 lv_screen_load。
 */
int         ui_page_count(void);
const char *ui_page_name(int index);              /* 稳定 id，用于文件名 */
lv_obj_t   *ui_page_show(int index, lv_obj_t *parent);

#ifdef __cplusplus
}
#endif