---
name: lvglui
description: 在 ESP-IDF 6.x + LVGL 9.x 工程里编写或调整 UI 页面：用 lvglui MCP 渲染截图、读控件树、只改 UI 层，业务数据通过 ui_port 注入。
---

# lvglui：LVGL 页面编写

当用户要在 ESP32 工程里新增/修改 LVGL 页面、布局、控件、字体，或要看当前 UI 的 PC 预览时使用本技能。UI 是 C，写在工程的 `uiDir` 里；同一份源码会同时编进固件和 PC 预览。业务逻辑归用户，UI 只通过 `ui_port.h` 取数/发命令。

## 先确认工具看到了正确的工程

1. 调 `mcp__lvglui__detect_project`，确认：
   - `root` 是目标工程；
   - `uiDir` 是 UI 目录；
   - `entry` 是入口函数（如 `sensor_ui_create`）；
   - `idf` 是 6.x，`lvgl` 是 9.x，`display` 是预期分辨率。
2. 调 `mcp__lvglui__doctor`。有 `fail` 先修：
   - IDF/LVGL 版本不对：让用户改工程，不要自己拉组件；
   - 工具链缺失：让用户装 VS2022 Build Tools / CMake / Ninja；
   - 平台头文件：UI 里只能 include LVGL 和 UI 自己的头；
   - 缺分辨率：让用户给 `--width/--height` 或在 `lvglui.json` 写 `display`。
3. 工程还没有 UI 骨架时，调 `mcp__lvglui__init_ui`（显式传 width/height，除非已有 `lvglui.json`/sdkconfig）。它只新增 `uiDir` 和 `lvglui.json`，返回接入片段；把片段交给用户粘到 `main`，**不要**自己改 `main/`。

## 写页面的流程

1. 读 `uiDir` 里现有的 `ui.c`、`ui.h`、`ui_port.h`、`ui_theme.h` 和 `pages/`，沿用既有命名和风格。
2. 先给出一个短计划：页面结构、控件、数据来源（哪个 `ui_port` 函数）、中文字体。用户确认后再写。
3. 只改 `<uiDir>/**`。新增页面放在 `<uiDir>/src/pages/<name>.c`，在 `ui.c` 里挂载。
4. 布局用 flex/grid；尺寸用 `lv_pct` 或相对常量；不要写死与屏幕分辨率无关的像素；屏幕尺寸以 `ctx.display`/`lvglui.json` 为准。
5. 每个业务要读/改的控件用 `lv_obj_set_name()` 起名（契约）；名字用英文 snake_case，如 `val_temp`、`btn_save`。
6. 中文文本不要依赖 LVGL 自带的 CJK 子集；让用户先运行 `lvglui font add --preset noto-sans-sc --size 16` 生成工程字体（默认 `font.mode=off`）；动态中文（设备名/用户输入）用 `--dynamic common`；任意中文/大字符集用 `--dynamic freetype`（用户需自带 `esp_freetype` 与文件系统，TTF 走 `fs-path`）。UI 页面里的中文照常写，预览/固件共用；缺字看 `font status`。不要在 UI 里 include 字体源文件。
7. 调 `mcp__lvglui__render_ui`（第一次 `rebuild:true`，之后可 `rebuild:false`），看返回的 `image` 和 `tree`：
   - `tree` 的 `name/cls/x/y/w/h/text/value` 用来核对布局和文字；
   - 图片用来看溢出、对齐、颜色、中文是否正确；
   - 有编译错误先按 `diagnostics` 第一条修，不要猜 LVGL API。
8. 改完再 render，直到截图合理；最后报告改了哪些文件、截图路径、剩余 warning。

## 业务边界（硬约束）

- UI 只依赖 LVGL 和 UI 自己的头（`ui.h`、`ui_port.h`、`ui_theme.h` 等）；**禁止** `#include "esp_..."`、`freertos/...`、`driver/...`、`nvs...`。
- 业务数据/命令只通过 `ui_port.h` 的 `ui_port_*` 函数。UI 不直接读传感器、不写 NVS、不建任务、不调 `vTaskDelay`。
- `ui_port_stub.c` 是 host 预览用的桩，全部包在 `#ifdef LVGLUI_HOST` 里；固件里是空 TU。用户在 `main/ui_port_impl.c` 实现强符号。
- 不改 `main/`、BSP、`sdkconfig`、工程级 `CMakeLists.txt`、`managed_components/`。
- 不做点击/滑动/动画的交互模拟；v1 只验证静态布局和初始数据。
- 不拉 LVGL 组件、不搭显示/触摸 bridge；这些是用户的前置工作。
- **不烧录、不碰串口**：禁止运行 `idf.py flash/monitor/erase-flash`、`esptool`、任何串口读写或 eFuse/分区表/bootloader 操作；工具本身也没有 `flash` 命令。用户要求烧板时，说明这是人工步骤：给出编译产物和 `idf.py -p <PORT> flash` 命令，由用户自己执行。原因：烧录本身可恢复，但未验证的业务逻辑可能驱动执行器（电机/加热/继电器），风险由固件内容决定，须由人把关。

## 典型页面骨架

```c
// <uiDir>/src/pages/home.c
#include "ui.h"
#include "ui_port.h"

lv_obj_t *page_home_create(lv_obj_t *parent) {
    lv_obj_t *root = lv_obj_create(parent);
    lv_obj_set_size(root, lv_pct(100), lv_pct(100));
    lv_obj_set_flex_flow(root, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_style_pad_all(root, 12, 0);

    lv_obj_t *title = lv_label_create(root);
    lv_label_set_text(title, "环境");
    lv_obj_set_name(title, "title_env");

    lv_obj_t *temp = lv_label_create(root);
    lv_label_set_text_fmt(temp, "温度 %.1f °C", ui_port_get_temperature());
    lv_obj_set_name(temp, "val_temp");
    return root;
}
```

## 失败处理

- `doctor` 的 `fail`：先修配置/头文件/版本，不要绕过。
- 编译错误：读 `render_ui` 返回的 `diagnostics`，按文件:行修第一条；不要一次改很多处。
- 链接错误 `ui_port_*`：说明用户在 `main/ui_port_impl.c` 还没实现，报告缺失符号，不要替用户写业务。
- 渲染成功但图片不对：先查 `tree` 的尺寸/文本，再查字体和 flex 参数；一次只改一个变量。
- 工具不可用：让用户跑 `node cli/lvglui.mjs doctor --project <path>` 或 `dsh install` 后重启。