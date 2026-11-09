#include "ui_pages.h"

#include "pages/home.h"
#include "ui_theme.h"

/* 页面表：新增页面时在这里加一行，并补齐 include/pages/ 与 src/pages/。
 * 顺序就是渲染顺序，也是总览图里从左到右、从上到下的排列顺序。 */
static const struct {
    const char *name;
    lv_obj_t *(*create)(lv_obj_t *parent);
} s_pages[] = {
    { "home", ui_page_home_create },
};

int ui_page_count(void)
{
    return (int)(sizeof(s_pages) / sizeof(s_pages[0]));
}

const char *ui_page_name(int index)
{
    if(index < 0 || index >= ui_page_count()) return NULL;
    return s_pages[index].name;
}

lv_obj_t *ui_page_show(int index, lv_obj_t *parent)
{
    if(index < 0 || index >= ui_page_count()) return NULL;

    lv_obj_t *root = parent;
    if(root == NULL) root = lv_obj_create(NULL);

    ui_theme_init(root);
    s_pages[index].create(root);

    if(parent == NULL) lv_screen_load(root);
    return root;
}