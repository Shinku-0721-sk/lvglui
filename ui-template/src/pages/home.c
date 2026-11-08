#include "lvgl.h"
#include "pages/home.h"

lv_obj_t *ui_page_home_create(lv_obj_t *parent) {
    lv_obj_t *page = lv_obj_create(parent);
    lv_obj_set_size(page, LV_PCT(100), LV_PCT(100));
    lv_obj_set_flex_flow(page, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(page, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_START);

    lv_obj_t *title = lv_label_create(page);
    lv_label_set_text(title, "Home");
#if LV_USE_OBJ_NAME
    lv_obj_set_name(title, "title");
#endif

    return page;
}