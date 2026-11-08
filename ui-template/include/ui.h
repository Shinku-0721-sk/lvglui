#pragma once
#include "lvgl.h"

#ifdef __cplusplus
extern "C" {
#endif

/* 在 parent 内创建页面；parent 为 NULL 时创建并加载根 screen。 */
lv_obj_t *ui_start(lv_obj_t *parent);

#ifdef __cplusplus
}
#endif