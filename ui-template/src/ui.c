#include "ui.h"
#include "ui_theme.h"
#include "pages/home.h"

lv_obj_t *ui_start(lv_obj_t *parent) {
    lv_obj_t *root = parent;
    if (root == NULL) {
        root = lv_obj_create(NULL);
    }
    ui_theme_init(root);
    ui_page_home_create(root);
    if (parent == NULL) {
        lv_screen_load(root);
    }
    return root;
}
