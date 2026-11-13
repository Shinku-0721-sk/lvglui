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
   - `uiDir`/`entry` 只是 `warn` 且提示 `lvglui init` 时，说明 UI 还没注入，继续第 3 步即可；
   - IDF/LVGL 版本不对：让用户改工程，不要自己拉组件；
   - 工具链缺失：让用户装 VS2022 Build Tools / CMake / Ninja；
   - 平台头文件：UI 里只能 include LVGL 和 UI 自己的头；
   - 缺分辨率：让用户给 `--width/--height` 或在 `lvglui.json` 写 `display`。
3. 工程还没有 UI 骨架时，调 `mcp__lvglui__init_ui`（显式传 width/height，除非已有 `lvglui.json`/sdkconfig）。它只新增 `uiDir` 和 `lvglui.json`，返回接入片段；把片段交给用户粘到 `main`，**不要**自己改 `main/`。

## 写页面的流程

1. 读 `uiDir` 里现有的 `ui.c`、`ui.h`、`ui_theme.h` 和 `pages/`，以及同级的 `ui_port` 组件（`ui_port.h` 在那），沿用既有命名和风格。
2. 涉及新页面、新数据源或跨文件改动时，先给出一个短计划（页面结构、控件、数据来源、中文字体），等用户确认；单个页面的布局微调直接改，不必等确认。
3. 只改 `<uiDir>/**`，以及同级的 `components/ui_port/ui_port.h` 与 `ui_port_stub.c`：
   - `ui_port.h` 只做追加声明，不改已有签名/类型；
   - `ui_port_stub.c` 只改 `#ifdef LVGLUI_HOST` 内的预览值；
   - `ui_port_impl.c` **只读**。缺 getter 时在报告里写清“固件需在 `ui_port_impl.c` 补 `ui_port_xxx()`（`return <已有数据>;`）”，不要替用户实现业务。
   新增页面放在 `<uiDir>/src/pages/<name>.c`，在 `ui.c` 里挂载。
4. 布局用 flex/grid；尺寸用 `lv_pct` 或相对常量；不要写死与屏幕分辨率无关的像素；屏幕尺寸以 `ctx.display`/`lvglui.json` 为准。
5. 每个业务要读/改的控件用 `lv_obj_set_name()` 起名（契约）；名字用英文 snake_case，如 `val_temp`、`btn_save`。
6. 中文文本不要依赖 LVGL 自带的 CJK 子集；用 MCP 的 `font` 工具生成工程字体（`action:"add"`，参数同 `lvglui font add`，默认 `--preset noto-sans-sc --size 16`；工程默认 `font.mode=off`）。动态中文（设备名/用户输入）用 `dynamic:"common"`；任意中文/大字符集用 `dynamic:"freetype"`（用户需自带 `esp_freetype` 与文件系统，TTF 走 `fsPath`）。工具会返回 `created/updated/removed`，报告里说明改了哪些文件；字号是全局的，改完重新 render 看布局。缺字看 `font` 的 `status`。不要在 UI 里 include 字体源文件。
7. 调 `mcp__lvglui__render_ui`（第一次 `rebuild:true`，之后可 `rebuild:false`），看返回的 `image` 和 `tree`：
   - `tree` 的 `name/cls/x/y/w/h/text/value` 用来核对布局和文字；`absX/absY` 是相对屏幕的绝对坐标（`x/y` 相对父容器）；
   - 图片用来看溢出、对齐、颜色、中文是否正确；
   - 有编译错误先按 `diagnostics` 第一条修，不要猜 LVGL API；
   - `warnings` 里的 `[clip] ...` 表示内容超出自身盒子或落在不滚动/不 overflow 的父容器外，先调布局再交付；`artifact.sha256` 是本次截图的指纹，比较时只认它，不要拿 out 目录里旧文件猜；
   - 同时看 `memory.lvgl`（`usedPct`/`maxUsed`）和 `budget`，别为了观感把堆吃超；
   - `--frames` 每帧推进 33 ms：70 帧≈2.3 s，足以看到 1 s 定时器的第二次触发；验证周期刷新就多跑几帧，不要只看默认 12 帧的首屏。
8. 改完再 render，直到截图合理；最后报告改了哪些文件、截图路径、剩余 warning。
9. 多页界面：如果 UI 组件实现了 `ui_page_count/ui_page_name/ui_page_show`，用 `render_ui` 的 `allPages:true` 一次看全部页（返回 contact sheet，每页图在 `pages[]`），或用 `page:"<name>"` 单看一页。页面表在 `<uiDir>/src/ui_pages.c`，新增页只往表里加一行 + 加 `include/pages/x.h` 与 `src/pages/x.c`。页面里创建的 `lv_timer` 不随屏幕对象销毁，清理规则见“业务边界”。
10. 用户想边改边看时调 `mcp__lvglui__preview_ui`（需要看得见就传 `topmost:true` 让它置顶）；保存 UI 源码后窗口约 1 秒自动重建并刷新，失败会保留上一版画面。若返回 `BUILD_BUSY`（预览 watcher 与 CLI/MCP 共用一把构建锁），用 `preview_ui {stop:true}` 关窗后重试；不要杀进程或删 `.lvglui/build/`。

## 业务边界（硬约束）

- UI 只依赖 LVGL 和 UI 自己的头（`ui.h`、`ui_port.h`、`ui_theme.h` 等）；**禁止** `#include "esp_..."`、`freertos/...`、`driver/...`、`nvs...`。
- 业务数据/命令只通过 `ui_port.h` 的 `ui_port_*` 函数。UI 不直接读传感器、不写 NVS、不建任务、不调 `vTaskDelay`。
- 默认不创建 `lv_timer`：动效用 `lv_anim`（随对象删除自动清理），数据变化直接更新控件。
- 确实需要周期刷新时，一个页面至多一个 timer：在页面入口创建、句柄存 static，并在页面根的 `LV_EVENT_DELETE` 里 `lv_timer_delete`；不要每个控件各建一个。页面可能被反复创建时，先确认旧 timer 已删除。
- timer 回调里只读 `ui_port_*` 和更新控件：不 `delay`、不阻塞、不建/删屏幕或控件；回调可能在页面已隐藏或销毁后触发，访问控件前先确认页面仍有效。
- `ui_port.h` 可追加声明、`ui_port_stub.c` 可加 host 桩；`ui_port_impl.c` 只读。数据在工程里根本不存在时（例如没有分贝传感器），先问用户口径与来源，只做 UI + 声明 + 桩，并说明“固件缺实现会链接失败”，不要编造数据或采集逻辑。

### 内存预算（硬约束）

- 预览和固件共用 LVGL 的 builtin 堆（`lv_conf.h` 的 `LV_MEM_SIZE`，通常 64 KB）。`render_ui` 返回的 `memory.lvgl` 是这个池的真实占用：`usedPct`、`maxUsed`、`usedCount`、`fragPct`；报告里必须带上 `usedPct` 和 `maxUsed`。
- 用户给了上限时，把它传给 `render_ui` 的 `maxHeapPct`（1-100）。返回 `budget.exceeded: true` 时**不许交付**：先降级再截图，直到不超过上限；不要用“再加点装饰更好看”换内存。
- 没给上限时按默认线把握：`usedPct ≥ 70%` 视为偏紧，要在报告里说明；`≥ 85%` 视为不可交付，先优化或请用户明确同意。`fragPct` 持续偏高（>30%）时把大对象放到页面初期一次性创建，避免反复分配。
- 优化顺序：删装饰（阴影/模糊/渐变/过多圆角）→ 复用样式与对象 → 减少嵌套层级和控件数 → 缩小字号/字符集（`font add --dynamic labels`）→ 小图/少动画。优先保布局与可读性，不要用更多控件堆视觉效果。
- 只认 `memory.lvgl`；进程内存、设备端 `esp_get_free_heap_size` 都混了别的子系统，不能拿来说“UI 用了多少”。工程换成 clib/外部分配器时 `memory` 缺失，如实说无法测量，不要编数字。
- `ui_port_stub.c` 是 host 预览用的桩，全部包在 `#ifdef LVGLUI_HOST` 里；固件里是空 TU。真正的实现在 `components/ui_port/ui_port_impl.c`（独立组件，app_ui 依赖它）。**不要**把它放进 `main/`：链接顺序会导致 `undefined reference to ui_port_*`。
- 不改 `main/`、BSP、`sdkconfig`、工程级 `CMakeLists.txt`、`managed_components/`。
- 不做点击/滑动/动画的交互模拟；1.x 只验证静态布局和初始数据（交互注入排在 2.0）。用户若要求验证点击后的状态，说明做不到，并改成建议用回调逻辑走查或上板自测。
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
- `BUILD_BUSY`：另一个构建（通常是预览 watcher）正在写同一个 build 目录；`preview_ui {stop:true}` 后重试，不要删目录、不要归因于文件权限。
- 链接错误 `ui_port_*`：说明 `components/ui_port/ui_port_impl.c` 还没实现（或实现被挪进了 `main/`，链接顺序拉不进来）；报告缺失符号和需要补的那一行，不要替用户写业务，也不要改 `ui_port_impl.c`。
- 渲染成功但图片不对：先查 `tree` 的尺寸/文本，再查字体和 flex 参数；一次只改一个变量。
- 工具不可用：让用户跑 `node cli/lvglui.mjs doctor --project <path>` 或 `dsh install` 后重启。