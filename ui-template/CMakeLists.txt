idf_component_register(
  SRCS
    "src/ui.c"
    "src/ui_pages.c"
    "src/ui_theme.c"
    "src/ui_port_stub.c"
    "src/pages/home.c"
  INCLUDE_DIRS "include"
  REQUIRES __LVGL_COMPONENT__
)