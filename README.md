# lvglui — 在 PC 上预览任意 ESP-IDF + LVGL 工程

`lvglui` 把工程里同一份 LVGL 界面源码编成 PC 程序：一张 PNG 给无头渲染/CI/模型看，一个窗口给你实时改。

它面向**已有的 ESP-IDF 6.x + LVGL 9.x 工程**：LVGL 组件、显示驱动、触摸 BSP 都由工程自己准备好；`lvglui` 只负责 UI 层的搭建、预览、截图和控件树。

## 前置条件

- Windows 10/11
- Node.js 22+
- Visual Studio 2022（C++ 桌面开发）
- ESP-IDF **6.x**（工具会从工程自己的 `build/project_description.json`、`.vscode/settings.json`、`lvglui.json` 或 `IDF_PATH` 发现它，不信任全局环境）
- 工程里已有可用的 LVGL **9.x**，并且显示/触摸已经能工作
- 界面 `.c` 只 include LVGL 和 UI 自己的头；**不要** include `driver/`、`esp_`、`freertos/` 等平台头

## 快速开始

```bash
# 1. 在现有工程里注入 UI 组件（只新增文件，不改现有文件）
node cli/lvglui.mjs init --project D:/my_project --width 240 --height 320

# 2. 检查工程/LVGL/IDF/工具链
node cli/lvglui.mjs doctor --project D:/my_project

# 3. 无头渲染 → .lvglui/out/shot.png + tree.json + meta.json
node cli/lvglui.mjs render --project D:/my_project

# 4. 实时预览窗口（改 UI 保存即重编）
node cli/lvglui.mjs preview --project D:/my_project
```

`init` 会：

- 创建 `components/app_ui/`（或 `lvglui.json` 指定的 `uiDir`）
- 创建 `lvglui.json`
- 在 stdout 打印一段接入代码；需要你把它粘到 `main` 里（通常替换原来的 `lv_screen_load(...)`）

如果 `sdkconfig` 里能唯一推断出宽高，可以省略 `--width/--height`；推断不出时命令会失败，不会偷偷用 240×320。

## 目录

```
cli/                 CLI 入口 + MCP stdio server
core/                工程发现、配置、IDF/LVGL、构建、渲染、诊断、DSH 安装
host/                PC 壳：窗口、计时、PNG、UI 树、ABI
ui-template/         init 注入的 UI 组件模板
dsh/                 DeepSeek Harness bundle（skill + MCP client）
test/                node:test 单测 + 集成测试
```

产物只写 `<project>/.lvglui/build/` 和 `<project>/.lvglui/out/`：

- `build/`：`lv_conf.h`、`lvglui.cmake`、`build.cmd`、`build.log`、`shot.exe`、`preview.exe`、`ui.dll`
- `out/`：`shot.png`、`tree.json`、`meta.json`

## lvglui.json

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

- `idfPath` / `lvglDir` / `uiDir` 可相对工程根
- `entry` 是 UI 入口函数，默认 `ui_start`
- `colorDepth` 目前只接受 `16`
- `font.cjk` 默认 `true`；预览用的 `lv_conf.h` 会强制开启 LVGL 自带的 14/16 中文（固件侧要自己开 `CONFIG_LV_FONT_SOURCE_HAN_SANS_SC_*_CJK`）
- `build.dir` 只能指向工程内；默认 `.lvglui/build`

## UI 契约

```c
/* ui.h */
lv_obj_t *ui_start(lv_obj_t *parent);
```

- `parent == NULL`：创建并返回根 screen
- `parent != NULL`：在父对象里建页面，返回页面根

业务数据只通过 `ui_port.h`：

```c
/* ui_port.h —— 由用户在 main/ui_port_impl.c 实现强符号 */
float ui_port_get_temperature(void);
float ui_port_get_humidity(void);
void  ui_port_set_relay(bool on);
```

- UI 层只声明/调用 `ui_port_*`，不碰业务状态
- `ui_template` 里的 `ui_port_stub.c` 在 PC 构建时提供桩；固件构建时是空 TU，用户在 `main/ui_port_impl.c` 提供强符号
- 缺实现会在链接期报错，不会悄悄编过

控件命名用 `ui_set_name(obj, "val_temp")`（内部包了 `LV_USE_OBJ_NAME`），渲染时 `tree.json` 和 PNG 一起给你。

## 命令

| 命令 | 作用 |
| --- | --- |
| `render` | 编译 + 跑 12 帧 + 输出 PNG/tree/meta（默认命令） |
| `build` | 只编译 host 渲染器 |
| `watch` | 监听 `uiDir` 的 `.c/.h`，防抖 300ms 后重渲 |
| `serve` | HTTP + SSE 预览（`127.0.0.1:8765`，占用自动 +1） |
| `preview` | 打开实时窗口；保存→重编→换 `ui.dll`，失败保留旧画面 |
| `init` | 注入 UI 组件骨架和 `lvglui.json` |
| `doctor` | 检查工程、IDF/LVGL 版本、工具链、显示配置、平台头 |
| `dsh install` | 生成 DSH bundle 用的 `dsh/cordis.patch.yml` 并打印安装命令 |
| `help` | 帮助 |

常用选项：

- `--project <dir>`：工程目录（默认 `LVGLUI_PROJECT` 或 cwd）
- `--width/--height`：显示尺寸；工程没配置时必填
- `--frames <n>`：渲染帧数，默认 12
- `--out <dir>`：输出**目录**（不是 PNG 文件路径）
- `--no-build`：复用已有 `shot.exe`（shot 缺失时会自动构建）
- `--json`：`render/build/doctor` 只向 stdout 输出 JSON，日志走 stderr
- `--no-render`：`init` 后不做空白页渲染

退出码：`0` 成功，`1` 构建/渲染失败，`2` 用法/配置错误，`3` 运行时/IO 错误。

## 在 DSH 里用

```bash
node cli/lvglui.mjs dsh install
# 输出里会给你：
# plugin_manager install_bundle target="file:D:/LVGL_preview/dsh"
```

然后重启 DSH。重启后：

- 技能列表里出现 `lvglui`
- 工具里出现 `mcp__lvglui__*`（`detect_project`、`init_ui`、`render_ui`、`build_ui`、`doctor`、`preview_ui`）

直接说：

> 在 D:/my_project 里把 home 页改成三个传感器卡片，数据走 ui_port，改完截图给我看。

skill 的约束是文字约定：只改 `uiDir`、不改 `main`/BSP/`sdkconfig`/工程 CMakeLists、不 include 平台头、业务只走 `ui_port`。没有强制写入围栏，也没有自动审计。

> 移动工具目录后必须重新跑 `dsh install`，再重新安装 bundle；`dsh/cordis.patch.yml` 是生成文件，已被 `.gitignore` 忽略。

## 限制

- 只做**静态**渲染 + 控件树；不做点击/滑动/动画模拟
- 只支持 **16bit** 色深
- Windows + ESP-IDF 6.x + LVGL 9.x
- 不拉 LVGL 组件、不配 component manager、不搭显示/触摸 BSP
- 不做写入审计；UI 层边界靠 skill 约定

## 故障排查

| 现象 | 处理 |
| --- | --- |
| `需要 ESP-IDF 6.x，发现 5.3` | 在 `lvglui.json` 写 `idfPath`，或修 `.vscode/settings.json` 的 `idf.currentSetup` |
| `需要 LVGL 9.x` | 检查 `managed_components/lvgl__lvgl` 或 `lvglDir` |
| 找不到 vcvars/cmake/ninja | 装 VS2022 C++ 工具；或在 `lvglui.json.build` 写显式路径 |
| `cannot determine display resolution` | 传 `--width/--height`，或写 `lvglui.json.display`，或让 `sdkconfig` 有唯一的一对宽高 |
| 编译失败 | 看 `<project>/.lvglui/build/build.log` 和 `render --json` 的 `diagnostics` |
| 中文显示方块 | 预览侧已强制开 CJK；固件侧要自己开 `CONFIG_LV_FONT_SOURCE_HAN_SANS_SC_*_CJK` |
| `--no-build` 仍构建 | `shot.exe` 不存在时这是预期行为；先跑一次完整 `render` |

## 开发

```bash
npm test                 # 单测
npm run test:integration # 集成（my_lcd 不存在时跳过）
node cli/lvglui.mjs doctor --project D:/esps3_test/my_lcd
```

回归基线：`D:/esps3_test/my_lcd`、240×320、`sensor_ui_create`、12 帧、PNG sha256 `8f3a7ad7e177e94953547ae30e47149d5139de638d87a56449a2f9ea03ddd287`。