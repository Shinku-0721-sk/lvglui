#include "ui.h"
#include "ui_pages.h"

/* 固件的唯一入口。页面表在 ui_pages.c 里，第一页就是启动页，所以新增页面
 * 只需要改页面表一处；只想做单屏的工程可以删掉 ui_pages.c，把这个函数
 * 换回自己建 root、调 ui_theme_init、再建页面的老写法。 */
lv_obj_t *ui_start(lv_obj_t *parent)
{
    return ui_page_show(0, parent);
}