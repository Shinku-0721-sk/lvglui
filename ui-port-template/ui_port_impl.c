#include "ui_port.h"

/*
 * 业务侧实现：把工程自己的传感器/服务数据接到 UI。
 *
 * 为什么这个文件在 components/ui_port，而不是 main 或 UI 组件里：
 * app_ui 依赖本组件，链接时本组件的静态库排在 libapp_ui.a 之后，
 * home.c 里的 ui_port_* 未定义符号才能被解析。放在 main 里会失败，
 * 因为 libmain.a 排在 libapp_ui.a 之前，且只被扫描一次。
 *
 * 这里可以 REQUIRES 驱动组件（BSP/传感器）——依赖方向永远是
 * app_ui -> ui_port -> 驱动，不要反过来。
 */
float ui_port_get_temperature(void)
{
    return 0.0f;
}

float ui_port_get_humidity(void)
{
    return 0.0f;
}

float ui_port_get_pressure(void)
{
    return 0.0f;
}