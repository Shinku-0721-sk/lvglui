#pragma once
#include "lvgl.h"

/*
 * UI 与业务代码的唯一边界。
 *
 * 约定：
 * - 本文件只声明 UI 需要的取数/命令函数。
 * - 固件实现在目标工程的业务文件（例如 main/ui_port_impl.c）。
 * - host 预览的桩实现放在 src/ui_port_stub.c 的 #ifdef LVGLUI_HOST 内。
 * - 不要 include ESP-IDF/驱动头文件。
 */
