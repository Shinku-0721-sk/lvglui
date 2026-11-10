#pragma once
#include "lvgl.h"

/*
 * UI 与业务代码的唯一边界。
 *
 * 约定：
 * - 本文件只声明 UI 需要的取数/命令函数。
 * - 头文件住在 ui_port 组件里，UI 组件 REQUIRES 它，所以两边都能 include。
 * - 固件实现在 ui_port_impl.c（同组件，业务侧自己维护）。
 * - host 预览的桩实现放在 UI 组件的 src/ui_port_stub.c 的 #ifdef LVGLUI_HOST 内。
 * - 不要 include ESP-IDF/驱动头文件。
 */

/* ---- 对外暴露的数据获取接口 ---- */
float ui_port_get_temperature(void);
float ui_port_get_humidity(void);
float ui_port_get_pressure(void);