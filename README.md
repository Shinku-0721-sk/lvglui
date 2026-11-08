# lvglui（D:\LVGL_preview）— 在电脑上跑你的 LVGL 界面

在 PC 上用**同一份 LVGL 源码**渲染 240×320 的界面：一个窗口实时看，一张 PNG 给模型/CI 看。
不依赖 LVGL Pro、不依赖许可证、不依赖网络。

```
D:\LVGL_preview\
├─ build.bat / build-cli.bat   编译全部 / 编译（给 CLI 用，重定向 TMP）
├─ shot.bat / lvglui.bat       出图 / CLI 入口
├─ CMakeLists.txt
├─ mcp.example.json            MCP 服务器配置样例（贴进 VSCode / Claude）
├─ host/                       壳：窗口、计时、文件监听、PNG 编码（不含 LVGL）
│  ├─ preview_main.c           240x320 窗口 + 保存即重载
│  ├─ shot_main.c              无头渲染 → PNG（或 --raw 出原始帧）
│  ├─ png_write.c              自带的极简 PNG 编码器（无第三方依赖）
│  ├─ ui_host.h                preview.exe ↔ ui.dll 的 ABI
│  └─ lv_conf.h                PC 侧 LVGL 配置：16bpp、无 OS、CLIB
│
├─ (../../components/app_ui/screen1_c.c)  ★ 界面真身，固件与预览共用
├─ ui/
│  ├─ ui_entry.c               PC 宿主 ABI（attach/tick/pixels/detach），不含界面
│  └─ ui.def                   只导出 4 个 ABI 符号
└─ cli/
   ├─ lvglui.mjs               CLI：render / build / preview / doctor
   ├─ lvglui-mcp.mjs           MCP server（stdio）
   ├─ core.mjs                 两边共用的实现
   └─ png.mjs                  RGB565 → PNG（用 node zlib，3 KB 一张）
```

## 用法

```bat
cd D:\LVGL_preview
build.bat                              :: 第一次约 1.5 分钟，之后增量 1~2 秒

lvglui.bat render                      :: 出图 → out\preview.png（JSON 结果打到 stdout）
lvglui.bat render --out out\a.png --quiet   :: 只打印路径
lvglui.bat preview                     :: 开窗口，改 ui_entry.c 保存即刷新，Esc 退出
lvglui.bat doctor                      :: 检查这台机器能不能编
```

`render` 的 JSON：

```json
{"ok":true,"png":"...\\out\\preview.png","width":240,"height":320,"bytes":3483,
 "repaints":1,"timings":{"build":2319,"shot":38,"encode":12}}
```

失败时：

```json
{"ok":false,"stage":"build","errors":[{"msg":"...ui_entry.c(146): error C2065: \"NOPE\": 未声明的标识符"}],"png":null}
```

## 三个产物，各管一头

| 工具 | 谁看 | 特点 |
|---|---|---|
| `lvglui render` / `shot.exe` | 模型 / CI | 无窗口、无墙钟，12 帧定时刻，**同一份代码每次出图逐像素相同** |
| `preview.exe` | 人 | 常驻窗口，保存源码后约 1 秒自动重载 |
| MCP `render_ui` | 任意 agent 客户端 | 直接返回 PNG image 块，模型能"看见"自己写的界面 |

## 接进 agent：MCP

`cli/lvglui-mcp.mjs` 是一个 stdio MCP server，四个工具：

| 工具 | 作用 |
|---|---|
| `render_ui` | 渲染并返回 PNG（image content block）+ 元数据 JSON |
| `build_ui` | 只编译，返回错误列表 |
| `preview_ui` | 打开实时窗口 |
| `doctor` | 环境自检 |

VSCode（Copilot agent 模式）把 `mcp.example.json` 里的内容并进你的 `mcp.json` 即可；
Claude Code 用 `claude mcp add lvglui -- node <绝对路径>\cli\lvglui-mcp.mjs`。
任何支持 MCP 的客户端同理 —— 路径必须是绝对路径。

模型侧的标准循环：

```
读 ui_entry.c → 改布局/颜色 → render_ui → 看图 → 不满意就再改
```

## 写界面的约定

界面代码在 `components/app_ui/screen1_c.c` —— **同一份文件既给固件编，也给预览编**。
它顶部有一个**参数区**，所有坐标、尺寸、颜色都在那里：

```c
#define TITLE_Y         15
#define ROW_R_Y         60
#define ACCENT          0x2196F3
```

下面的 `ui_build()` 才写控件逻辑。改外观 = 改参数区，不需要读逻辑代码。

几点硬约束（和固件保持一致）：

- 画布固定 **240×320**，按这个尺寸排版；
- 颜色用 `lv_color_hex(0xRRGGBB)`；
- 不要在这里做业务逻辑（串口、SPI、数据采集都在 `main/app_ui.c`、`main.c` 里）；
- 控件名要和 Pro 项目一致（`slider_r/g/b`、`button_1`），业务代码用 `lv_obj_find_by_name()` 找它们；
- 只用 LVGL 公开 API，别用 `lv_*_private`。

## 热重载是怎么做到的

`preview.exe` 只负责窗口和消息循环，**完全不含 LVGL**；LVGL 和你的界面一起被编进 `ui.dll`。
保存 `ui_entry.c` → 壳检测到改动 → 卸载旧 DLL（整个引擎状态一起丢弃）→ 重新编译 → 加载新 DLL → 重画。
因为引擎整个被卸载重建，不存在悬空 `lv_obj_t` 指针，这是热重载最容易崩的地方。

编译发生在 `preview.exe` 的子进程里，日志写到 `out/build.log`；编译失败时窗口保留上一帧，终端会打印
`BUILD FAILED`。另外，如果你在别的终端手动跑了 `build.bat`，窗口也会检测到新的 `ui.dll` 并自动换上去。

## 已知限制

- 需要 VS2022 的 C++ 工具链（`cl.exe`）。没有的话 `lvglui.bat doctor` 会告诉你缺什么。
- 热重载会重置界面状态（滑块归零、输入框清空）。做交互态预览时才需要担心。
- 中文字体要先自己转 `.c`（`lv_font_conv`），默认只有 Montserrat，中文显示为方块。
- 触摸/按键事件在 PC 上用鼠标模拟，行为与真机不完全一致。
- 渲染是确定性的：**故意不读真实时间**，动画类界面在 PNG 里只会看到第 12 帧。

## 从 Pro 的 XML 搬到 C

搬运记录、XML→C 对照表、以及接到固件要改的那两行：见
[`docs/LVGL_UI_C_ROUTE.md`](../../docs/LVGL_UI_C_ROUTE.md)。

## 设计背景

架构取舍、为什么不用 LVGL Pro 的 CLI 或它的 wasm 运行时，见
[`docs/LVGL_UI_PREVIEW_DESIGN.md`](../../docs/LVGL_UI_PREVIEW_DESIGN.md)。

## M1 之后：用 CLI 对任意 ESP-IDF 工程工作

```bat
rem 在任何目录，指向一个工程
node cli\lvglui.mjs doctor  --project D:\\path\\to\\project
node cli\lvglui.mjs init    --project D:\\path\\to\\project   rem 生成 components/app_ui/ 四件套 + lvglui.json
node cli\lvglui.mjs render  --project D:\\path\\to\\project   rem 出图（JSON 里有 png 路径与 names）
node cli\lvglui.mjs preview --project D:\\path\\to\\project   rem 开实时窗口
```

不传 `--project` 就用当前目录，并自动往上找带 `project()` 的 `CMakeLists.txt`。

**它会自己找这几样东西**（`cli/project.mjs`）：

| 找什么 | 顺序 |
|---|---|
| 界面目录 | `lvglui.json` → `components/app_ui` → `components/ui` → `ui` → `src/ui` → 按 `lv_screen_load(xxx_create(...))` 调用点反查 → 按 `xxx_create` 定义反查 |
| 入口函数 | `lvglui.json` → 调用点 → 定义 |
| 配置 | 工程的 `sdkconfig` → 内置默认（`host/lv_conf.h`） |
| LVGL | 工程 `managed_components/lvgl__lvgl` → `vendor/lvgl`（工具自带，28 MB） |

构建产物在 `build/<工程名>-<路径哈希>/`，所以多个工程共用这一个工具目录也不会互相踩。

**`vendor/lvgl`** 是给"连 LVGL 都还没拉进来"的新工程兜底的；工程自己装了 lvgl 就永远用工程那份，保证预览和固件是同一个版本。打包插件时这一份应该放进 vsix，而不是扔进用户的仓库。

`render` 的输出比原来多了两个字段：

- `config`：`"sdkconfig"`（配置跟着固件走）或 `"default"`（工程还没 configure 过）
- `names`：界面里所有 `lv_obj_set_name()` 起的名字。固件靠这些名字 `lv_obj_find_by_name()` 找控件，**名字写错在真机上是"界面能显示但点了没反应"，没有任何报错**。

`shot.bat` 现在只是 `lvglui.bat render` 的快捷方式。`build.bat` 保留给 `preview.exe` 的热重载用（它走的是"工具就在工程里"的老路径，只对 my_lcd 有效）。

## 看界面：三种方式，按"想不想切窗口"选

```bat
rem 1) 钉在屏幕边上的小窗（300x460，无地址栏，不用切窗口）——改一行存一下，图自己变
lvglui.bat serve --open

rem 2) 普通网页：自己在浏览器里开 http://127.0.0.1:8765，可以放到第二块屏
lvglui.bat serve --port 8765

rem 3) 只要一张图（给模型看、给 CI 比对）
lvglui.bat render --out out\preview.png
```

窗口大小可以调：`--open --width 264 --height 400`。

`serve` 的页面自己带着状态行（成功时显示字节数/编译耗时，失败时显示第一条编译错误），
文件改了 300 ms 防抖后自动重渲——所以不管是你在 VSCode 里手改，还是让模型在别的地方改，
窗口里都会自己刷新，不需要回来问"改好了吗"。

页面内部走的是 SSE（`/events`），`/shot.png` 拿图、`/state` 拿最近一次的 JSON。
以后做 VS Code 插件时，webview 里直接用这套地址就行，不用另写一套。
