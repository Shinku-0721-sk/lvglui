#include "ui_theme.h"

void ui_theme_init(lv_obj_t *root) {
    if (root == NULL) {
        return;
    }
#if defined(LV_FONT_SOURCE_HAN_SANS_SC_16_CJK) && LV_FONT_SOURCE_HAN_SANS_SC_16_CJK
    lv_obj_set_style_text_font(root, &lv_font_source_han_sans_sc_16_cjk, 0);
#else
    lv_obj_set_style_text_font(root, &lv_font_montserrat_14, 0);
#endif
}