# DSH 安装与手工验收（Task 16）

本文记录把 `lvglui` 装进 DeepSeek Harness（DSH）的步骤，以及重启后的检查项。

## 1. 生成 bundle patch

```bash
cd D:/LVGL_preview
node cli/lvglui.mjs dsh install
```

它会读取 `dsh/cordis.patch.template.yml`，把 `__TOOL_DIR__` 替换成当前工具目录的正斜杠绝对路径，生成 **gitignored** 的：

```text
dsh/cordis.patch.yml
```

不要提交这个文件。移动工具目录后必须重新跑 `dsh install`。

## 2. 安装 bundle

在 DSH 里执行：

```text
plugin_manager install_bundle target="file:D:/LVGL_preview/dsh"
```

成功结果应包含：

- bundle: `dsh-lvglui`
- version: `0.1.0`
- application: `applied`
- enabled: `true`

它会把两样东西挂进当前 profile：

1. `dsh-lvglui` 里的 Host 小插件（`dsh/lib/index.js`）注册 `lvglui` skill；
2. `@deepseek-ai/dsh-mcp-client` 行，用 stdio 启动：

```text
node D:/LVGL_preview/cli/lvglui-mcp.mjs
```

## 3. 重启 DSH

MCP client 在启动时拉起 server，所以必须重启 DSH（不是刷新页面）。

重启后检查：

- 技能列表出现 `lvglui`
- 工具列表出现 `mcp__lvglui__*`：`detect_project`、`init_ui`、`render_ui`、`build_ui`、`doctor`、`preview_ui`

如果工具没出现，先看 DSH 日志里 `lvglui-mcp` 的 stderr；再单独跑：

```bash
node D:/LVGL_preview/cli/lvglui-mcp.mjs
```

它应该在 stdin 上等 JSON-RPC，不应向 stdout 打任何非 JSON 日志。

## 4. 手工验收对话

示例：

> 在 D:/esps3_test/my_lcd 里，把 home 页改成三个传感器卡片：温度、湿度、气压。数据通过 ui_port 取，只改 components/app_ui；改完截图并告诉我控件树。

期望：

1. LLM 先 `detect_project`，确认 `uiDir=components/app_ui`、`entry=sensor_ui_create`；
2. `doctor` 通过，或只报可接受的 warning；
3. 只改 `components/app_ui` 下的 `.c/.h`；
4. `render_ui` 返回 PNG image + tree text；
5. 截图里能看到三个卡片，tree 里能查到对应 `name`。

## 5. 已知限制

- skill 只是文字约定：没有受控写入、没有自动审计；
- 只做静态渲染 + 控件树，不做点击/滑动/动画；
- 只支持 16bit 色深、Windows、IDF 6.x、LVGL 9.x；
- 预览窗口需要桌面会话，headless 环境只能 `render`。