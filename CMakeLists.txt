# ===========================================================================
#  LVGL UI Preview —— 主机侧工具（在 PC 上把你的界面编出来并截图）
#
#  这不是一个独立工程：CLI 会带上下面这些 -D 参数把它指向「你的工程」。
#  不传参数时，按"我就在被测工程里"的老路子兜底（tools/ui-preview/ 旁边）。
#
#    LVGLUI_PROJECT_DIR : 被测 ESP-IDF 工程根目录
#    LVGLUI_UI_DIR      : 界面源码目录（components/app_ui）
#    LVGLUI_ENTRY       : 界面入口函数名（home_create）
#    LVGLUI_LVGL_DIR    : LVGL 源码根
#    LVGLUI_CONF_DIR    : 放着 lv_conf.h 的目录（每次渲染由 CLI 生成）
#
#    ui_obj   : host/ui_entry.c + 你的界面 .c（与固件编译的是同一批文件）
#    ui.dll   : ui_obj + lvgl，给 preview.exe 热重载
#    preview  : 240x320 窗口，不含任何 LVGL
#    shot     : 无头渲染，吐出原始 RGB565 帧
# ===========================================================================
cmake_minimum_required(VERSION 3.20)
project(lvglui C)

# CMake 4 defaults single-config generators (Ninja) to Debug, whose /RTC1
# conflicts with the hardcoded /O2 below (MSVC error D8016). Pick Release
# explicitly unless the caller chose a build type, and keep /O2 conditional.
if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "Build type" FORCE)
endif()

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

set(LVGLUI_TOOL_DIR "${CMAKE_CURRENT_SOURCE_DIR}" CACHE PATH "工具根目录")
set(LVGLUI_PROJECT_DIR "" CACHE PATH "被测工程根目录")
set(LVGLUI_UI_DIR "" CACHE PATH "界面源码目录")
set(LVGLUI_LVGL_DIR "" CACHE PATH "LVGL 源码根")
set(LVGLUI_CONF_DIR "" CACHE PATH "包含 lv_conf.h 的目录")
set(LVGLUI_ENTRY "" CACHE STRING "界面入口函数名")
set(LVGLUI_WIDTH "" CACHE STRING "预览宽度")
set(LVGLUI_HEIGHT "" CACHE STRING "预览高度")

# ---- 兜底：不带参数时，假定工程就是工具所在仓库 ---------------------------
if(NOT LVGLUI_PROJECT_DIR)
  get_filename_component(LVGLUI_PROJECT_DIR "${LVGLUI_TOOL_DIR}/../.." ABSOLUTE)
endif()
if(NOT LVGLUI_UI_DIR)
  set(LVGLUI_UI_DIR "${LVGLUI_PROJECT_DIR}/components/app_ui")
endif()
if(NOT LVGLUI_LVGL_DIR)
  set(LVGLUI_LVGL_DIR "${LVGLUI_PROJECT_DIR}/managed_components/lvgl__lvgl")
endif()
if(NOT LVGLUI_CONF_DIR)
  set(LVGLUI_CONF_DIR "${LVGLUI_TOOL_DIR}/host")
endif()
if(NOT LVGLUI_ENTRY)
  # 只有绕过 CLI、直接跑 .lvglui/build/build.cmd 时才会走到这里
  set(LVGLUI_ENTRY "sensor_ui_create")
  message(WARNING "LVGLUI_ENTRY 未指定，兜底用 ${LVGLUI_ENTRY}（走 CLI 时不会出现这条）")
endif()

if(NOT LVGLUI_WIDTH MATCHES "^[1-9][0-9]*$" OR NOT LVGLUI_HEIGHT MATCHES "^[1-9][0-9]*$")
  message(FATAL_ERROR "LVGLUI_WIDTH/LVGLUI_HEIGHT 必须由构建脚本传入")
endif()

if(NOT EXISTS "${LVGLUI_LVGL_DIR}/src")
  message(FATAL_ERROR "找不到 LVGL 源码：${LVGLUI_LVGL_DIR}")
endif()
if(NOT EXISTS "${LVGLUI_UI_DIR}")
  message(FATAL_ERROR "找不到界面目录：${LVGLUI_UI_DIR}")
endif()
if(NOT EXISTS "${LVGLUI_CONF_DIR}/lv_conf.h")
  message(FATAL_ERROR "找不到配置文件：${LVGLUI_CONF_DIR}/lv_conf.h")
endif()

message(STATUS "工程      : ${LVGLUI_PROJECT_DIR}")
message(STATUS "界面目录  : ${LVGLUI_UI_DIR}")
message(STATUS "入口函数  : ${LVGLUI_ENTRY}")
message(STATUS "预览尺寸  : ${LVGLUI_WIDTH}x${LVGLUI_HEIGHT}")
message(STATUS "LVGL      : ${LVGLUI_LVGL_DIR}")
message(STATUS "配置文件  : ${LVGLUI_CONF_DIR}/lv_conf.h")

# ---- LVGL 静态库 ----------------------------------------------------------
file(GLOB_RECURSE LVGL_SOURCES CONFIGURE_DEPENDS "${LVGLUI_LVGL_DIR}/src/*.c")
list(LENGTH LVGL_SOURCES LVGL_SOURCE_COUNT)
message(STATUS "LVGL 源文件: ${LVGL_SOURCE_COUNT}")

add_library(lvgl STATIC ${LVGL_SOURCES})
target_include_directories(lvgl PUBLIC
  "${LVGLUI_LVGL_DIR}/include"
  "${LVGLUI_LVGL_DIR}/include/lvgl"
  "${LVGLUI_LVGL_DIR}/src"
  "${LVGLUI_CONF_DIR}"
)
target_compile_definitions(lvgl PUBLIC
  LV_CONF_INCLUDE_SIMPLE
  $<$<C_COMPILER_ID:MSVC>:_CRT_SECURE_NO_WARNINGS>
)
if(MSVC)
  target_compile_options(lvgl PRIVATE /utf-8 /W1 $<$<CONFIG:Release>:/O2>)
endif()

# ---- 界面（和固件同一批 .c）----------------------------------------------
file(GLOB_RECURSE APP_UI_SOURCES CONFIGURE_DEPENDS "${LVGLUI_UI_DIR}/*.c")
list(LENGTH APP_UI_SOURCES APP_UI_COUNT)
message(STATUS "界面源文件: ${APP_UI_COUNT}")
if(APP_UI_COUNT EQUAL 0)
  message(FATAL_ERROR "${LVGLUI_UI_DIR} 里没有 .c 文件")
endif()

add_library(ui_obj OBJECT "${LVGLUI_TOOL_DIR}/host/ui_entry.c" ${APP_UI_SOURCES})
target_include_directories(ui_obj PUBLIC
  "${LVGLUI_TOOL_DIR}/host"
  "${LVGLUI_UI_DIR}/include"
  "${LVGLUI_UI_DIR}"
)
target_compile_definitions(ui_obj PRIVATE
  LVGLUI_HOST=1
  LVGLUI_WIDTH=${LVGLUI_WIDTH}
  LVGLUI_HEIGHT=${LVGLUI_HEIGHT}
  LVGLUI_ENTRY=${LVGLUI_ENTRY}
)
if(MSVC)
  target_compile_options(ui_obj PRIVATE /utf-8)
endif()
target_link_libraries(ui_obj PUBLIC lvgl)

# ---- 可热重载的 UI + 引擎 -------------------------------------------------
add_library(ui SHARED $<TARGET_OBJECTS:ui_obj> "${LVGLUI_TOOL_DIR}/host/ui.def")
target_link_libraries(ui PRIVATE lvgl)
set_target_properties(ui PROPERTIES PREFIX "" OUTPUT_NAME "ui")
if(MSVC)
  target_compile_options(ui PRIVATE /utf-8)
endif()

# ---- 窗口壳 ---------------------------------------------------------------
add_executable(preview "${LVGLUI_TOOL_DIR}/host/preview_main.c")
if(MSVC)
  target_compile_options(preview PRIVATE /utf-8)
endif()

# ---- 无头渲染 -------------------------------------------------------------
add_executable(shot $<TARGET_OBJECTS:ui_obj>
  "${LVGLUI_TOOL_DIR}/host/shot_main.c"
  "${LVGLUI_TOOL_DIR}/host/png_write.c"
)
target_compile_definitions(shot PRIVATE
  LVGLUI_WIDTH=${LVGLUI_WIDTH}
  LVGLUI_HEIGHT=${LVGLUI_HEIGHT}
)
target_link_libraries(shot PRIVATE lvgl)
if(MSVC)
  target_compile_options(shot PRIVATE /utf-8)
endif()