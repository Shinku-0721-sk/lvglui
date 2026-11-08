# lvglui 通用化设计（v1）

- 状态：待用户审阅
- 日期：2026-11-08
- 目标工程：任意已集成 LVGL 的 ESP-IDF 6.x 工程
- 参考回归工程：`D:/esps3_test/my_lcd`（ESP-IDF 6.1、LVGL 9.6.0、esp32s3、240×320）

## 1. 背景与目标

现有 `D:/LVGL_preview` 是给 `my_lcd` 专用的 PC 预览工具：它已经能把固件里的同一批界面 `.c` 编到 PC 上，跑固定帧，输出 PNG，并且结果确定。但它的默认路径、分辨率、入口和构建脚本都绑死在 `my_lcd` 上，也没有面向 Agent 的稳定工具面。

本项目把它泛化为 `lvglui`，服务两类使用者：

1. **人**：在已有 ESP-IDF 工程里快速补上 LVGL 的 UI 层，并在 PC 上看到静态预览。
2. **DSH 里的 LLM**：用户用自然语言提需求，模型借助 MCP 工具写 UI 页面、渲染、看图和控件树、按编译错误修正；业务逻辑仍由用户实现。

成功的样子：在一个只装好 LVGL、显示/触摸 BSP 已工作的 IDF 6.x 工程上，`lvglui init` 只新增文件；用户在 DSH 里说“做一个温湿度页”，模型写出 UI，`render` 出图；用户按 `ui_port_*` 补业务，固件照常 `idf.py build`。

## 2. 非目标（v1 明确不做）

- 不拉取 LVGL 组件、不配 component manager、不改 `idf_component.yml`。
- 不搭建显示/触摸 BSP，不初始化 LCD、不注册 `lv_indev`。
- 不修改目标工程的任何现有文件；`init` 只新增。
- 不做点击/滑动/动画/多帧的交互模拟；只做静态截图和控件树。
- 不构建、不烧录 ESP-IDF 固件；固件构建仍由用户 `idf.py` 完成。
- 不支持非 Windows 主机；不支持 LVGL 8.x；不支持 16bit 以外色深。
- 不做写入审计、不做文件锁、不做“禁止改业务文件”的强制机制；边界只靠 skill 文字约定（用户已确认）。

## 3. 约束与假设

- 主机：Windows 10/11 x64，Node.js >= 22。
- 目标工程：ESP-IDF 6.x（以 6.1 回归），LVGL 9.x（以 9.6.0 回归），RGB565 16bit。
- 目标工程已有可显示的 LVGL：`lv_display` 已创建，`lv_timer_handler` 已在某个任务里跑。
- UI 源码只依赖 LVGL 与 UI 自己的头（`ui.h` / `ui_port.h` / `ui_theme.h`），不 include 任何 `esp_*` / `driver/` / `freertos/` / `sdkconfig.h`。
- 工具不信任当前 shell 的 `IDF_PATH`；按工程发现 IDF。
- 工具的构建产物不写进工程的 `build/`，统一放 `.lvglui/build`。

## 4. 术语

- **uiDir**：UI 组件目录，默认 `components/app_ui`，是 Agent 唯一可写的工程目录。
- **entry**：UI 入口函数，签名 `lv_obj_t *entry(lv_obj_t *parent)`，默认 `ui_start`。
- **port**：UI 向业务取数/下命令的接口，声明在 `uiDir/include/ui_port.h`，实现由用户在 `main/` 完成。
- **tree**：渲染后从 `lv_screen_active()` 遍历出的控件树 JSON。
- **host 构建**：只编译“项目 LVGL + uiDir + host 入口”的 PC 构建，不参与 IDF 构建。

## 5. 端到端流程

1. 用户在已有工程根执行：
   ```
   lvglui init --project D:\proj --width 240 --height 320
   ```
   工具探测 IDF/LVGL/入口/色深，创建 `components/app_ui` 与 `lvglui.json`，打印 `ui_start()` 接入片段，跑一次 `doctor` 和空白页 `render`。
2. 用户把片段粘进自己的 `main`（唯一需要手工做的一步），或在 DSH 里让模型写页面。
3. DSH 内：skill 先 `detect_project`，确认分辨率和字体，然后只改 `uiDir`；每次改完 `render_ui`，看 PNG + tree + 编译错误，循环修正。
4. 用户按 render 结果末尾列出的 `ui_port_*` 清单，在 `main/ui_port_impl.c` 实现业务。
5. 固件侧：`idf.py build`。若端口没实现完，链接期会报未定义符号；不会静默。
6. 可选：`lvglui preview` 打开热重载窗口；`lvglui serve` 浏览器预览。

## 6. 总体架构

```
CLI (cli/) ─┐
MCP (cli/lvglui-mcp.mjs) ─┼─> core/ ─> host C 构建 ─> shot.exe ─> PNG + tree.json + meta.json
DSH bundle (dsh/) ─┘                          └─> ui.dll + preview.exe（热重载）
```

- `core/` 是唯一业务逻辑层：探测、配置、lv_conf 生成、构建、渲染、诊断、树。
- CLI 和 MCP 都只是 `core/` 的薄适配器；不存在第二套构建/渲染逻辑。
- `host/` 是 C 侧：`ui_entry.c`（ABI/树/像素）、`shot_main.c`（无头）、`preview_main.c`（窗口）、`png_write.c`。
- `ui-template/` 是 `init` 写进目标工程的模板文件。
- `dsh/` 是 DSH 插件包：MCP 客户端配置 + 一个只注册 skill 的 Host 小插件。

### 6.1 工具自身布局

```
package.json          # private，type=module，bin: lvglui -> cli/lvglui.mjs，scripts: test
lvglui.cmd            # Windows 入口包装（node cli/lvglui.mjs %*）
.gitignore            # .lvglui/、build/、out/、node_modules/
```

- 不发布 npm；本机用 `npm link` 或直接 `node cli/lvglui.mjs`。
- `lvglui.cmd` 保证命令行和双击都能跑。
- 工具仓库允许改自己的构建脚本；目标工程仍零改动。

## 7. 工程模型与配置

### 7.1 配置文件

工程根新增 `lvglui.json`（工具唯一会写进工程根的文件）：

```json
{
  "schema": 1,
  "idfPath": "E:/esp/v6.1/esp-idf",
  "lvglDir": "managed_components/lvgl__lvgl",
  "uiDir": "components/app_ui",
  "entry": "ui_start",
  "display": { "width": 240, "height": 320, "colorDepth": 16 },
  "build": { "dir": ".lvglui/build" },
  "font": { "cjk": true }
}
```

字段说明：

| 字段 | 必填 | 缺省/说明 |
| --- | --- | --- |
| `schema` | 是 | 固定 1 |
| `idfPath` | 否 | 探测得到的 IDF 根；可手改 |
| `lvglDir` | 否 | 相对工程根；探测得到 |
| `uiDir` | 是 | 相对工程根；`init` 写入 |
| `entry` | 是 | 默认 `ui_start`；兼容 `sensor_ui_create` 这类旧入口 |
| `display.width/height` | 是 | 不猜默认值；探测不到必须 `--width/--height` |
| `display.colorDepth` | 是 | v1 只接受 16 |
| `build.dir` | 否 | 默认 `.lvglui/build` |
| `font.cjk` | 否 | 默认 true；false 时不强制中文宏 |

CLI 参数优先于配置；环境变量 `LVGLUI_PROJECT`、`LVGLUI_IDF_PATH` 作为最后兜底。工具不会为了“修正”而重写 `lvglui.json`，只有 `init` 创建它。

### 7.2 探测顺序

**工程根**：
1. `--project` 指定目录；
2. 从 cwd 向上找 `lvglui.json`；
3. 从 cwd 向上找同时含 `CMakeLists.txt` 与 `sdkconfig` 的目录；
4. 失败，报“这里不像 ESP-IDF 工程”，并列出已尝试的目录。

**IDF**：
1. `lvglui.json.idfPath`；
2. `<project>/build/project_description.json` 的 `idf_path`；
3. `<project>/.vscode/settings.json` 的 `idf.currentSetup`（或 `idf.espIdfPath`）；
4. 环境变量 `IDF_PATH`，且必须存在 `<idf>/tools/idf.py`；
5. 失败，报错并给出“在 lvglui.json 里写 idfPath”的修复建议。

校验 IDF 版本读 `<idf>/components/esp_common/include/esp_idf_version.h` 的 `ESP_IDF_VERSION_MAJOR/MINOR`；v1 要求 6.x，5.x 明确拒绝。

**LVGL**：
1. `lvglui.json.lvglDir`；
2. `<project>/managed_components/lvgl__lvgl`；
3. 在工程内深度 ≤ 4 搜 `include/lvgl/lvgl.h` 或 `lvgl.h`；
4. 失败，报“工程里没找到 LVGL；本工具不负责拉取，请先集成”。

版本读 `include/lvgl/lv_version.h` 的 `LVGL_VERSION_MAJOR/MINOR/PATCH`；要求 9.x。`< 9.2` 只警告，不阻断（回归只保证 9.6）。

**分辨率**：
1. `lvglui.json.display`；
2. `--width/--height`；
3. sdkconfig 候选键：`CONFIG_BSP_LCD_H_RES`、`CONFIG_BSP_LCD_V_RES`、`CONFIG_LCD_H_RES`、`CONFIG_LCD_V_RES`、`CONFIG_DISPLAY_WIDTH`、`CONFIG_DISPLAY_HEIGHT`；
4. 源码候选宏：`BSP_LCD_H_RES`、`BSP_LCD_V_RES`、`LCD_H_RES`、`LCD_V_RES`、`DISPLAY_WIDTH`、`DISPLAY_HEIGHT`；
5. 只有“唯一且成对”命中才采用；否则报错，要求显式给。`init` 不猜。

**色深**：读 `CONFIG_LV_COLOR_DEPTH=16`。不是 16 直接报“v1 只支持 16bit”。

### 7.3 构建目录

- 配置与日志：`<project>/.lvglui/`
- 构建：`<project>/.lvglui/build/`
- 产物：`<project>/.lvglui/out/`（`shot.png`、`tree.json`、`meta.json`）
- 不写 `<project>/build/`，不与 IDF 构建目录混用。
- 不修改 `.gitignore`；`init` 和 `doctor` 打印一行建议（用户自己决定加不加）。

## 8. init

`init` 的步骤：

1. 解析工程、IDF、LVGL、分辨率、色深。
2. 若 `lvglui.json` 已存在，或 `uiDir` 已存在，**拒绝并列出冲突**；不覆盖、不合并。
3. 创建 `uiDir` 及骨架文件（见第 9 节）。
4. 写 `lvglui.json`。
5. 打印接入片段：
   ```c
   #include "ui.h"
   /* display/LVGL 已初始化，且在 LVGL 锁内： */
   lv_screen_load(ui_start(NULL));
   ```
6. 运行 `doctor`；默认再跑一次空白页 `render` 证明链路通（`--no-render` 可跳过）。若工具链缺失，文件仍已创建，但命令以非零退出并打印缺什么。
7. 不改任何现有文件；不写 `.gitignore`；不碰 `main/`、根 `CMakeLists.txt`、`sdkconfig`、`lv_conf`。

`init` 不提供 `--force`。需要重来时由用户自己删目录。

## 9. UI 组件骨架与端口契约

### 9.1 生成的目录

```
components/app_ui/
  CMakeLists.txt
  include/
    ui.h
    ui_port.h
    ui_theme.h
  src/
    ui.c
    ui_theme.c
    ui_port_stub.c
    pages/
      home.c
```

### 9.2 入口

`ui.h`：

```c
#pragma once
#include "lvgl.h"

/* parent == NULL 时创建并返回根 screen；否则在 parent 里创建页面。 */
lv_obj_t * ui_start(lv_obj_t * parent);
```

`ui.c` 负责：幂等保护；`parent == NULL` 时建根 screen，否则在 `parent` 上建 home 页；然后 `ui_theme_init(root)`、`ui_page_home_create(root)`。host 和固件都按这个签名调用；`my_lcd` 的 `lv_obj_t *sensor_ui_create(lv_obj_t *)` 可直接作为 `entry` 回归。

### 9.3 组件 CMake

```cmake
idf_component_register(
    SRCS
        "src/ui.c"
        "src/ui_theme.c"
        "src/ui_port_stub.c"
        "src/pages/home.c"
    INCLUDE_DIRS "include"
    REQUIRES lvgl
)
```

- 新页面必须把 `.c` 加进 `SRCS`；host 构建按目录 glob，`doctor` 检查“`src/` 下的 `.c` 是否都列进 SRCS”，漏了直接报。
- v1 只支持组件名 `lvgl`（ESP-IDF 托管组件的默认名）。若工程用了别的名字，`doctor` 报错并让用户改 `CMakeLists.txt`；工具不自动改。

### 9.4 主题与中文字体

- host 仍初始化 `lv_theme_simple`，保证 my_lcd 像素回归；`ui_theme_init()` 只在其上设字体、颜色、间距，不抢主题。`default` 主题留作后续配置项。
- 中文字体：LVGL 9.6 自带 `lv_font_source_han_sans_sc_14_cjk` / `_16_cjk`。`ui_theme.c` 在宏开启时用 16px CJK，否则退回 `lv_font_montserrat_14`；根 screen 设一次 `text_font`，子控件继承。
- 宏没开时 UI 仍能编译，只是中文显示方块；`doctor` 警告固件 sdkconfig 没开 `CONFIG_LV_FONT_SOURCE_HAN_SANS_SC_16_CJK`。

### 9.5 控件命名

- 需要被 tree/业务引用的控件：`lv_obj_set_name(obj, "home.card.temp")`，ID 形如 `页面.区域.语义`，页面内唯一。
- 必须包 `#if LV_USE_OBJ_NAME`，因为固件可能没开；预览侧强制开。
- 没名字的控件在 tree 里 `name` 为空，方便发现漏命名。

### 9.6 端口契约

`ui_port.h` 是唯一业务边界：

```c
#pragma once

/* UI 需要的业务能力。用户在 main/ 下实现；host 预览用桩。 */
/* 示例：
void    ui_port_refresh(void);
float   ui_port_get_temperature(void);
*/
```

- UI 只调用 `ui_port_*`，不 include 任何平台头。
- `ui_port_stub.c` 的所有实现包在 `#ifdef LVGLUI_HOST` 中：host 构建定义 `LVGLUI_HOST`，得到返回 0/false 的桩；固件构建不定义，文件是空 TU。
- 用户在 `main/ui_port_impl.c` 实现同名强符号；缺了就在链接期报未定义，不静默。
- 不用 weak 符号（MSVC 不支持），边界由条件编译 + 链接器保证。
- `init` 生成的初始 `ui_port.h` 可以没有函数；页面开始用数据时再逐个加。每加一个端口，LLM 同时补 `ui_port_stub.c` 的 host 桩。

### 9.7 接入

```c
#include "ui.h"

/* 在 display 初始化之后、LVGL 锁内： */
lv_screen_load(ui_start(NULL));
```

- `main` 组件在 ESP-IDF 中自动依赖所有组件，因此不必改 `main/CMakeLists.txt`；若业务放在别的组件里，该组件需要 `REQUIRES app_ui`。
- 工具不生成 `main` 文件，也不改调用点。

## 10. Host 构建

- 工具链：`cl`（MSVC）、`cmake`、`ninja`。查找顺序：`lvglui.json.build` 显式路径 → `vswhere` 找到 VS2022 的 `vcvars64.bat` → PATH → IDF tools 下的 cmake/ninja。找不到就 `doctor` 报具体缺哪一项。
- 只编译：
  - `<lvglDir>/src/**/*.c`（LVGL 静态库）；
  - `<uiDir>/**/*.c`（界面，和固件同一批文件）；
  - `host/ui_entry.c`、`host/shot_main.c`、`host/png_write.c`。
- **不编译** `<project>/main`、`components/*`（除 uiDir）、IDF 组件；host 看不到业务代码。
- 编译宏：
  - `LVGLUI_HOST=1`
  - `LVGLUI_WIDTH=<display.width>`、`LVGLUI_HEIGHT=<display.height>`
  - `LVGLUI_ENTRY=<entry>`
  - `LV_CONF_INCLUDE_SIMPLE`
- 构建目录 `<project>/.lvglui/build`；生成临时 `build.cmd` 调 `vcvars64.bat` + `cmake --build`，避免 cmd 引号问题；失败时把实际命令打印出来。
- 增量：CMake/Ninja 原生增量；`lv_conf.h` 内容不变不落盘，避免 LVGL 全量重编。

## 11. lv_conf 生成

- 从目标工程 `sdkconfig` 的 `CONFIG_LV_*` 生成，保留项目自己的开关（`cli/kconfig.mjs` 现有逻辑）。
- 预览侧强制覆盖：
  - `LV_COLOR_DEPTH 16`
  - `LV_USE_OBJ_NAME 1`
  - `LV_FONT_SOURCE_HAN_SANS_SC_14_CJK 1`、`LV_FONT_SOURCE_HAN_SANS_SC_16_CJK 1`（`font.cjk` 为 false 时不强制）
  - `LV_FONT_MONTSERRAT_14 1`、`LV_FONT_MONTSERRAT_16 1`
  - `LV_USE_THEME_SIMPLE 1`、`LV_USE_THEME_DEFAULT 1`
  - `LV_USE_FLEX 1`、`LV_USE_GRID 1`
- 输出到 `<project>/.lvglui/build/lv_conf.h`；与上次内容相同则不写。
- 若 `sdkconfig` 里没有任何 `CONFIG_LV_*`，`doctor` 报“未找到 LVGL Kconfig”，不偷偷用默认配置。
- 模板过滤、空值/弃用项丢弃沿用现有 `cli/kconfig.mjs` 规则。

## 12. 渲染与产物

- 固定 12 帧，每帧 `lv_tick_inc(33)`，不读墙钟；`lv_timer_handler()` + `lv_refr_now()`。
- 帧缓冲 RGB565，`LV_DISPLAY_RENDER_MODE_FULL`；PNG 用 Node 内置 `zlib`，level 9。
- 产物：
  - `.lvglui/out/shot.png`
  - `.lvglui/out/tree.json`
  - `.lvglui/out/meta.json`：分辨率、入口、LVGL 版本、build/shot/encode 耗时、PNG sha256、帧数。
- 确定性：同一工程、同一配置、同一帧数 → PNG sha256 必须一致。my_lcd 回归目标 `8f3a7ad7e177e94953547ae30e47149d5139de638d87a56449a2f9ea03ddd287`。
- `--no-build` 直接复用上次 `shot.exe`，只重跑截图。
- `render` 退出码：0 成功；1 编译/链接失败；2 工程/配置错误；3 运行时失败（入口返回 NULL、分辨率不匹配等）。

## 13. 控件树

从 `lv_screen_active()` 递归，输出嵌套 JSON：

```json
{
  "screen": { "w": 240, "h": 320 },
  "root": {
    "name": "home",
    "cls": "lv_obj",
    "x": 0, "y": 0, "w": 240, "h": 320,
    "hidden": false,
    "children": [
      { "name": "home.card.temp", "cls": "lv_label", "x": 16, "y": 56, "w": 120, "h": 20,
        "text": "23.5 °C", "children": [] }
    ]
  },
  "truncated": false
}
```

- 字段：`name/cls/x/y/w/h/hidden/text/value/checked/children`。
- `text` 只对 label 取，截 64 字符；`value` 对 slider/bar；`checked` 对 switch/checkbox。
- 类名通过 `lv_obj_get_class()` + LVGL 私有头 `core/lv_obj_class_private.h` 的 `class_p->name` 读取；host 构建包含 `<lvglDir>/include`、`<lvglDir>/include/lvgl`、`<lvglDir>/src`，v1 锁 9.6。小版本不兼容时降级为空 `cls`，不阻断渲染。
- 深度 ≤ 16，节点 ≤ 500；超限 `truncated: true`。
- 完整 tree 写文件；MCP 返回紧凑版（去掉空 `children`、文本截断、最多 200 节点），并给完整文件路径。

## 14. 诊断

- 同时解析：
  - MSVC：`file(line,col): error C####: ...`、`fatal error C####`、`LNK####`；
  - GCC/Clang：`file:line:col: error: ...`、`undefined reference to ...`；
  - Ninja：`FAILED: ...`、`ninja: build stopped`。
- 输出结构：`{ file, line, col, severity, message, raw }`，路径转工程相对；最多 50 条 + 原始输出尾部 100 行。
- 人话提示（匹配到就给）：
  - 找不到 `lvgl.h` → “检查 lvglDir / LVGL 组件是否完整”；
  - `undefined reference to ui_port_*` → “业务端口未实现，去 main/ 补”；
  - UI 里 include `driver/`、`esp_*`、`freertos/`、`sdkconfig.h` → “UI 层不能碰平台头；改用 ui_port_*”；
  - 色深不是 16 → “v1 只支持 16bit”。
- `doctor` 的检查项：
  - 工程根、IDF 6.x、LVGL 9.x、分辨率、色深；
  - `uiDir` 存在、入口符号可编译、`src/` 下 `.c` 都在 SRCS；
  - UI 里没有平台头（静态扫描）；
  - `LV_USE_OBJ_NAME`、CJK 字体在预览/固件配置里的状态；
  - MSVC/cmake/ninja 可执行；
  - `.lvglui/` 可写；
  - 业务端口实现情况（设备侧链接期才能最终确认，doctor 只提示清单）。
- `doctor` 输出 `{ ok, checks: [{id, status, message, fix}] }`，`status` 为 `ok|warn|fail`。

## 15. preview 与 serve

- `preview.exe` 改为接收参数：`--dll <path>`、`--ui-dir <path>`、`--build-dir <path>`、`--width`、`--height`；不再从 exe 位置猜 `ui/`、`build/ui.dll`、`build.bat`。
- 热重载：卸 `ui.dll` 前先 `ui_detach()`；重建成功后 `LoadLibrary`；失败保留旧 DLL 并在窗口状态栏显示错误。
- 文件监听：`uiDir` 的 `.c/.h`、`lvglui.json`、`sdkconfig`；debounce 200ms。LVGL 源码不默认监听（483 文件太重），需要时 `--watch-lvgl`。
- 重建异步：`spawn` 而非 `spawnSync`，窗口/HTTP 事件循环不被阻塞。
- `serve`：HTTP + SSE 保持 127.0.0.1:8765 起，端口被占 +1 最多 10 次；编译异步，事件里推 `status/image/tree/errors`。
- `preview_ui` MCP 工具保留，用于启动窗口；skill 不调用它。

## 16. MCP

### 16.1 传输与协议

- stdio，换行分隔 JSON-RPC 2.0；不使用 Content-Length 头。
- `initialize`：读取客户端 `protocolVersion`，在 `2024-11-05` / `2025-03-26` / `2025-06-18` 中则原样回；否则回 `2025-06-18`。返回 `capabilities.tools = {}`、`serverInfo`。
- 处理 `notifications/initialized`、`ping`、`tools/list`、`tools/call`；未知方法回 `-32601`。
- 工具错误用 `isError: true` + 文本；参数错误回 `-32602`。

### 16.2 工具

| 名称 | 输入 | 输出 |
| --- | --- | --- |
| `detect_project` | `{ project? }` | 工程摘要：idfPath/version、lvglDir/version、uiDir、entry、display、缺什么 |
| `init_ui` | `{ project, width, height, dir? }` | 已创建文件、接入片段、doctor 摘要 |
| `render_ui` | `{ project?, noBuild? }` | 图片（MCP image，base64 PNG）+ 文本：meta、紧凑 tree、完整 tree 路径、错误 |
| `build_ui` | `{ project? }` | 编译结果、诊断 |
| `doctor` | `{ project? }` | 结构化检查 |
| `preview_ui` | `{ project? }` | 窗口 pid/状态（不阻塞） |

- 所有工具接受绝对 `project`；缺省时依次用 `LVGLUI_PROJECT`、MCP 进程 cwd 向上找。
- `render_ui` 的文本不超过 ~20KB；tree 太大时只给摘要 + 文件路径。
- 图片内容：
  ```json
  { "type": "image", "data": "<base64>", "mimeType": "image/png" }
  ```
- 若 DSH 客户端不渲染 MCP image，退回“返回 PNG 绝对路径 + 让模型用 `read_image`”；阶段 3 第一件事验证。

## 17. DSH bundle 与 skill

### 17.1 包结构

```
dsh/
  package.json
  cordis.patch.yml
  lib/index.js
  skills/lvglui/SKILL.md
```

`package.json`：

```json
{
  "name": "dsh-lvglui",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`cordis.patch.yml`：

```yaml
- insert:
    - id: lvglui-skill
      name: dsh-lvglui
    - id: lvglui-mcp
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: lvglui
        transport: stdio
        command: node
        args: ["D:/LVGL_preview/cli/lvglui-mcp.mjs"]
        cwd: "D:/LVGL_preview"
        failOnStartupError: true
```

- 绝对路径由 `lvglui dsh install` 写死（写 `dsh/cordis.patch.yml`）；搬动工具目录后要重跑 `dsh install` 并重装 bundle。
- `lvglui-skill` 是一个只注册 SkillProvider 的 Host 小插件，参考 `@wenaixi/dsh-superpower` 的 `ctx.skills.registerProvider`；只读 `skills/lvglui/SKILL.md`，不做 UI、不做设置页。
- 安装：用户在 DSH 里 `plugin_manager install_bundle target: "<tool>/dsh"`；或由 `lvglui dsh install` 打印确切命令。安装后 MCP 工具名 `mcp__lvglui__*`，skill 出现在技能列表。
- 不改 DSH 的 `cordis.yml`；bundle 走 patch 层。

### 17.2 Skill 内容

`SKILL.md` 至少包含：

1. **何时使用**：用户要在 ESP-IDF 工程里新建/修改 LVGL UI 页面，且工程已集成 LVGL。
2. **前置检查**：`detect_project`；没有 LVGL 就停止，让用户先集成，工具不代劳；确认分辨率、色深、CJK 字体。
3. **工作流**：detect → 规划控件与命名 → 只写 `uiDir` → `render_ui` → 看 PNG + tree + 诊断 → 修正 → 重复 → 输出端口清单。
4. **硬约束**：
   - 只改 `uiDir`；不碰 `main/`、根 `CMakeLists.txt`、`sdkconfig`、`lv_conf`、component manager、依赖。
   - UI 只 include `lvgl.h` + UI 自己的头（`ui.h` / `ui_port.h` / `ui_theme.h`）；不 include 平台头。
   - 业务逻辑不进 UI；只声明/调用 `ui_port_*`。
   - 新控件必须命名；新页面必须加进 SRCS。
   - 每次改完必须 render；有编译错误先修再继续。
5. **UI 规范**：240×320 安全区、flex/grid 百分比布局、CJK 字体、不写死绝对坐标（除非必要）、颜色/字号走 `ui_theme`。
6. **收尾报告**：改了哪些文件、当前截图、用户需要实现的 `ui_port_*` 清单、固件侧要开的配置（CJK、LV_USE_OBJ_NAME）。
7. **失败处理**：编译错误、入口返回 NULL、端口未实现、图片不显示，各自给出下一步。

### 17.3 分发与安装

- 工具仓库同时是 bundle 源；`lvglui dsh install` 写绝对路径并打印安装命令。
- 不发布 npm 包（v1）；DSH 从本地目录安装。
- 技能开关走 DSH 自带技能列表；不额外做开关面板。

## 18. 边界与安全

- 工具写入范围：`<project>/lvglui.json`、`<project>/<uiDir>/`、`<project>/.lvglui/`。不写其他工程文件。
- MCP `init_ui` 只新增；已存在则拒绝。
- 无网络、无遥测、无后台服务（除本地 preview/serve）。
- 用户已选择“只靠约定”：不做写入审计、不做文件锁、不阻止模型用 bash 改别的文件；风险由 skill 文字约束和用户审阅承担。
- 预览只验证静态布局；交互/业务正确性仍由固件和用户保证。

## 19. 兼容与回归

- CLI 命令保留：`render/build/preview/serve/init/doctor`；新增 `dsh install`（写 bundle 绝对路径并打印安装命令）；`--project`、`--no-build` 修好。
- MCP 旧工具名保留：`render_ui/build_ui/preview_ui/doctor`；新增 `detect_project/init_ui`。
- `my_lcd` 像素回归：
  - 入口 `sensor_ui_create`、240×320、simple theme、12 帧、RGB565；
  - 目标 sha256 `8f3a7ad7e177e94953547ae30e47149d5139de638d87a56449a2f9ea03ddd287`；
  - host 继续 `lv_theme_simple_init`，UI 只覆盖字体/颜色，确保像素不变。
- 旧 `build.bat` / `build-cli.bat` 的硬编码路径删除，改为按 config 生成临时构建脚本；工具仓库自身可改，不涉及目标工程。
- `mcp.example.json` 更新为通用示例；README 重写，去掉“cd D:\LVGL_preview”这类过时步骤。

## 20. 测试

**单元（`node --test`）**：
- `lvglui.json` 解析/校验/缺字段；
- 工程根、IDF、LVGL 探测（临时夹具目录，含 `.vscode`、`project_description.json`、`managed_components`）；
- sdkconfig → lv_conf 映射与强制覆盖；
- MSVC/GCC/Ninja 诊断解析；
- tree JSON 形状与截断；
- 分辨率候选唯一/歧义。

**集成**：
- `my_lcd` render：sha256 回归、names/tree 含 `val_temp` 等；
- `--no-build` 不再触发编译（计时/日志断言）；
- `init` 在临时空工程：只新增文件、第二次拒绝；
- MCP：起子进程，跑 `initialize`/`tools/list`/`detect_project`，断言协议版本与 JSON；
- preview 热重载：改一个 label 文本，重建后窗口像素变化（手工/半自动）。

**不做**：真机烧录、IDF 固件构建、交互模拟、Linux/macOS。

CI 暂不引入；先本地 `node --test`，后续可加 Windows runner。

## 21. 分阶段

**阶段 1：内核与工程模型**
- 抽 `core/`；实现 config/探测/IDF/LVGL/分辨率/色深；
- `init` 骨架 + `lvglui.json`；
- host 参数化（宽度/高度/入口/构建目录）、preview 参数修复；
- my_lcd 回归通过（sha256 一致）。
- 验收：`doctor` ok；`render --no-build` 生效；`preview` 热重载可用。

**阶段 2：可验证性**
- 控件树 JSON + 紧凑版；
- 诊断解析 + 人话提示；
- `--no-build`、增量、meta；
- 单测。
- 验收：编译错误能定位到文件:行；tree 能看到命名控件。

**阶段 3：Agent 闭环**
- MCP 重写（协议协商、工具、image）；
- DSH bundle + skill；
- 在 my_lcd 上跑通“一句话 → 图 → 改”。
- 验收：DSH 里 `mcp__lvglui__render_ui` 返回图片；skill 能引导模型只改 uiDir。

**阶段 4：收尾**
- README、示例、`dsh install`、打包；
- 边界 case（无 LVGL、5.x、非 16bit、uiDir 已存在）。
- 验收：新工程从零到出图 ≤ 10 分钟（不含用户装 LVGL）。

## 22. 风险与对策

| 风险 | 对策 |
| --- | --- |
| IDF 6.1 路径/版本差异 | 多级探测；doctor 明确报错；不猜 |
| MSVC/CMake 环境差异 | 探测 + config 覆盖；失败打印实际命令 |
| LVGL 9.x 小版本 API 差异 | v1 以 9.6 为准；<9.2 警告；私有类名读取失败则降级 |
| `lv_conf` 与项目 sdkconfig 不同步 | 每次按 sdkconfig 生成；内容不变不落盘 |
| DSH 不渲染 MCP image | 阶段 3 首验；退回 PNG 路径 + `read_image` |
| 软约束被绕过 | 用户已选只靠约定；工具只保证 uiDir 可编译/可预览 |
| preview 热重载卸载 DLL 崩溃 | 先 `ui_detach`，再 `FreeLibrary`；失败保留旧 DLL |
| 中文字体在固件没开 | doctor 警告 + 收尾报告列出要开的宏 |

## 23. 验收标准

1. `my_lcd`：`doctor` ok；`render` 的 PNG sha256 与基线一致；tree 含 `val_temp/val_hum/val_press/val_lux`；`--no-build` 跳过编译；`preview` 保存后热重载。
2. 新工程（IDF 6.1 + LVGL 9.6 已集成）：`init` 只新增文件；`render` 出空白页；LLM 写一页后出图；业务端口未实现时固件链接报错。
3. DSH：bundle 安装后 `mcp__lvglui__detect_project` 可用；`render_ui` 图片进对话；skill 出现在列表并能引导“只改 uiDir”。
4. 错误路径：无 LVGL、IDF 5.x、非 16bit、uiDir 已存在，四种情况都有明确报错和修复建议。

## 24. 后续版本（不在 v1）

- 交互模拟：点击/滑动/切屏后截图。
- 动画/多帧导出。
- 32bit 色深、旋转、多分辨率预设。
- `default` 主题配置与主题切换。
- npm 发布、跨平台（Linux/macOS）。
- 多工程并发构建缓存隔离。
- 受控写入/审计（若用户改口要强制边界）。