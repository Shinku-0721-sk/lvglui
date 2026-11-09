#include "demo_page.h"

#define C_BG       0x0B1220
#define C_CARD     0x141E32
#define C_BORDER   0x24314D
#define C_TEXT     0xE6EDF7
#define C_MUTED    0x8FA3BF
#define C_CYAN     0x4FD1C5
#define C_BLUE     0x60A5FA
#define C_AMBER    0xFBBF24
#define C_GREEN    0x34D399

static lv_obj_t *card_new(lv_obj_t *parent)
{
    lv_obj_t *card = lv_obj_create(parent);

    lv_obj_remove_flag(card, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_style_bg_color(card, lv_color_hex(C_CARD), 0);
    lv_obj_set_style_bg_opa(card, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(card, 1, 0);
    lv_obj_set_style_border_color(card, lv_color_hex(C_BORDER), 0);
    lv_obj_set_style_radius(card, 12, 0);
    lv_obj_set_style_pad_all(card, 9, 0);
    lv_obj_set_style_pad_row(card, 2, 0);
    lv_obj_set_flex_flow(card, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(card, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_START);

    return card;
}

static void metric_card(lv_obj_t *parent, const char *caption, const char *value, uint32_t color)
{
    lv_obj_t *card = card_new(parent);
    lv_obj_set_height(card, 54);
    lv_obj_set_width(card, 0);
    lv_obj_set_flex_grow(card, 1);

    lv_obj_t *cap = lv_label_create(card);
    lv_label_set_text(cap, caption);
    lv_obj_set_style_text_color(cap, lv_color_hex(C_MUTED), 0);

    lv_obj_t *val = lv_label_create(card);
    lv_label_set_text(val, value);
    lv_obj_set_style_text_color(val, lv_color_hex(color), 0);
}

static lv_obj_t *row_new(lv_obj_t *parent)
{
    lv_obj_t *row = lv_obj_create(parent);

    lv_obj_remove_flag(row, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_size(row, LV_PCT(100), 54);
    lv_obj_set_style_bg_opa(row, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(row, 0, 0);
    lv_obj_set_style_pad_all(row, 0, 0);
    lv_obj_set_style_pad_column(row, 6, 0);
    lv_obj_set_flex_flow(row, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(row, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);

    return row;
}

lv_obj_t *demo_sensor_create(lv_obj_t *parent)
{
    lv_obj_t *root = lv_obj_create(parent);

    lv_obj_remove_flag(root, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_size(root, LV_PCT(100), LV_PCT(100));
    lv_obj_set_style_bg_color(root, lv_color_hex(C_BG), 0);
    lv_obj_set_style_bg_opa(root, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(root, 0, 0);
    lv_obj_set_style_radius(root, 0, 0);
    lv_obj_set_style_pad_all(root, 10, 0);
    lv_obj_set_style_pad_row(root, 6, 0);
    lv_obj_set_flex_flow(root, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(root, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_START);

    lv_obj_t *header = lv_obj_create(root);
    lv_obj_remove_flag(header, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_size(header, LV_PCT(100), 24);
    lv_obj_set_style_bg_opa(header, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(header, 0, 0);
    lv_obj_set_style_pad_all(header, 0, 0);
    lv_obj_set_flex_flow(header, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(header, LV_FLEX_ALIGN_SPACE_BETWEEN, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);

    lv_obj_t *title = lv_label_create(header);
    lv_label_set_text(title, "环境监测");
    lv_obj_set_style_text_color(title, lv_color_hex(C_TEXT), 0);

    lv_obj_t *badge = lv_obj_create(header);
    lv_obj_remove_flag(badge, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_size(badge, LV_SIZE_CONTENT, 20);
    lv_obj_set_style_bg_color(badge, lv_color_hex(C_GREEN), 0);
    lv_obj_set_style_bg_opa(badge, LV_OPA_20, 0);
    lv_obj_set_style_border_width(badge, 0, 0);
    lv_obj_set_style_radius(badge, 10, 0);
    lv_obj_set_style_pad_all(badge, 5, 0);
    lv_obj_set_style_pad_column(badge, 4, 0);
    lv_obj_set_flex_flow(badge, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(badge, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);

    lv_obj_t *dot = lv_obj_create(badge);
    lv_obj_remove_flag(dot, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_size(dot, 5, 5);
    lv_obj_set_style_bg_color(dot, lv_color_hex(C_GREEN), 0);
    lv_obj_set_style_bg_opa(dot, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(dot, 0, 0);
    lv_obj_set_style_radius(dot, LV_RADIUS_CIRCLE, 0);

    lv_obj_t *online = lv_label_create(badge);
    lv_label_set_text(online, "在线");
    lv_obj_set_style_text_color(online, lv_color_hex(C_GREEN), 0);

    lv_obj_t *hero = card_new(root);
    lv_obj_set_size(hero, LV_PCT(100), 92);
    lv_obj_set_style_pad_all(hero, 10, 0);
    lv_obj_set_style_pad_column(hero, 10, 0);
    lv_obj_set_flex_flow(hero, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(hero, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);

    lv_obj_t *arc = lv_arc_create(hero);
    lv_obj_set_size(arc, 70, 70);
    lv_arc_set_rotation(arc, 0);
    lv_arc_set_bg_angles(arc, 135, 45);
    lv_arc_set_range(arc, 0, 100);
    lv_arc_set_value(arc, 68);
    lv_obj_set_style_arc_width(arc, 7, LV_PART_MAIN);
    lv_obj_set_style_arc_color(arc, lv_color_hex(C_BORDER), LV_PART_MAIN);
    lv_obj_set_style_arc_width(arc, 7, LV_PART_INDICATOR);
    lv_obj_set_style_arc_color(arc, lv_color_hex(C_CYAN), LV_PART_INDICATOR);
    lv_obj_set_style_bg_opa(arc, LV_OPA_TRANSP, LV_PART_KNOB);
    lv_obj_set_style_border_width(arc, 0, LV_PART_KNOB);
    lv_obj_remove_flag(arc, LV_OBJ_FLAG_CLICKABLE);

    lv_obj_t *arc_value = lv_label_create(arc);
    lv_label_set_text(arc_value, "68%");
    lv_obj_set_style_text_color(arc_value, lv_color_hex(C_TEXT), 0);
    lv_obj_center(arc_value);

    lv_obj_t *info = lv_obj_create(hero);
    lv_obj_remove_flag(info, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_height(info, LV_PCT(100));
    lv_obj_set_width(info, 0);
    lv_obj_set_flex_grow(info, 1);
    lv_obj_set_style_bg_opa(info, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(info, 0, 0);
    lv_obj_set_style_pad_all(info, 0, 0);
    lv_obj_set_style_pad_row(info, 2, 0);
    lv_obj_set_flex_flow(info, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(info, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_START);

    lv_obj_t *caption = lv_label_create(info);
    lv_label_set_text(caption, "室内温度");
    lv_obj_set_style_text_color(caption, lv_color_hex(C_MUTED), 0);

    lv_obj_t *temperature = lv_label_create(info);
    lv_label_set_text(temperature, "23.5 °C");
    lv_obj_set_style_text_color(temperature, lv_color_hex(C_TEXT), 0);

    lv_obj_t *comfort = lv_label_create(info);
    lv_label_set_text(comfort, "舒适 · 58% RH");
    lv_obj_set_style_text_color(comfort, lv_color_hex(C_CYAN), 0);

    lv_obj_t *row1 = row_new(root);
    metric_card(row1, "湿度", "58 %", C_CYAN);
    metric_card(row1, "气压", "1013 hPa", C_BLUE);

    lv_obj_t *row2 = row_new(root);
    metric_card(row2, "光照", "320 lx", C_AMBER);
    metric_card(row2, "空气质量", "优", C_GREEN);

    lv_obj_t *footer = lv_obj_create(root);
    lv_obj_remove_flag(footer, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_size(footer, LV_PCT(100), 18);
    lv_obj_set_style_bg_opa(footer, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(footer, 0, 0);
    lv_obj_set_style_pad_all(footer, 0, 0);
    lv_obj_set_flex_flow(footer, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(footer, LV_FLEX_ALIGN_SPACE_BETWEEN, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);

    lv_obj_t *updated = lv_label_create(footer);
    lv_label_set_text(updated, "12:30 更新");
    lv_obj_set_style_text_color(updated, lv_color_hex(C_MUTED), 0);

    lv_obj_t *stack = lv_label_create(footer);
    lv_label_set_text(stack, "LVGL 9.6");
    lv_obj_set_style_text_color(stack, lv_color_hex(C_MUTED), 0);

    return root;
}