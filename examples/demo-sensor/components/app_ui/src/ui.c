#include "ui.h"
#include "demo_page.h"

lv_obj_t *ui_start(lv_obj_t *parent)
{
    lv_obj_t *root = parent;

    if (root == NULL) {
        root = lv_obj_create(NULL);
    }

    demo_sensor_create(root);
    return root;
}