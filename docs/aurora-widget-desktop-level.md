# Aurora 桌面小组件层级需求：允许“只在桌面显示”

> 状态：需求说明（不是本插件已实现的功能）
> 适用宿主：Aurora 0.5.1 / 插件 API v1
> 提出方：班级事务台插件（`com.classmanagement.board`）

## 1. 需求

班级事务台把「班级速览 / 本周值日 / 今日事务 / 本周安排」做成 2 张桌面小组件。当前它们会一直显示在其他应用窗口之上；希望宿主提供一种**非置顶 / 桌面层**的小组件层级，让浮窗只在桌面可见，切换到其他应用时被正常窗口覆盖。

期望行为：

- 小组件仍然在桌面上可见、可拖动、可缩放、可隐藏；
- 用户打开浏览器、Office、全屏视频等窗口后，小组件被这些窗口覆盖；
- 不要求壁纸层嵌入、桌面图标层或点击穿透；
- 默认行为保持现状（置顶），由插件或用户显式选择新层级。

## 2. 现状与证据

Aurora 0.5.1 中，桌面小组件由主进程的 `WidgetManager` 创建，层级是硬编码的：

- 创建 `BrowserWindow` 时固定 `alwaysOnTop: true`、`skipTaskbar: true`；
- 创建后固定调用 `win.setAlwaysOnTop(true, 'floating')`；
- manifest 的 `contributes.widgets` 只有 `slot: "desktop" | "edge-bar"`，没有窗口层级字段；
- 插件 API v1 不向插件暴露 `BrowserWindow` / `BrowserWindow.setAlwaysOnTop`；
- `plugin-dev-kit/docs/01-contract.md §5.3` 明确：桌面小组件是**置顶浮动卡片**，v1 不做壁纸层嵌入、桌面图标层、点击穿透；
- Aurora 0.5.1 发行说明的“已知限制”同样写明“桌面小组件是置顶浮动卡片”。

因此，该需求无法由插件侧实现；插件不应通过外部 Win32 调用修改宿主窗口层级（不符合“不修改插件目录以外文件/环境”的插件规范，也容易被宿主重启或未来版本破坏）。

## 3. 建议的宿主 API

任选其一即可满足本需求，推荐方案 A：

### 方案 A：widget 声明增加 `windowLevel`

```json
{
  "id": "week-overview",
  "title": "班级速览",
  "slot": "desktop",
  "windowLevel": "desktop",
  "schema": "ui/widget-overview.json",
  "defaultSize": { "width": 320, "height": 300 }
}
```

- `windowLevel`：`"floating"`（默认，兼容现状）| `"normal"` | `"desktop"`；
- `"normal"`：不设置 `alwaysOnTop`，按普通无边框窗口参与 z-order；
- `"desktop"`：在 `"normal"` 基础上尽量放到普通窗口之下（Windows 可用 WorkerW / Progman 父窗口或等效层级方案）；
- 由宿主在插件详情里为每个 widget 提供覆盖开关，便于用户临时改回置顶；
- 插件 API 不需要新增方法，只扩展 manifest 与宿主窗口创建逻辑。

### 方案 B：widget 声明增加布尔值

```json
{ "alwaysOnTop": false }
```

实现简单，但表达力弱于 `windowLevel`；默认值必须为 `true` 以保持兼容。

## 4. 验收标准

- 默认配置下，现有插件行为不变（仍为置顶卡片）；
- 声明 `windowLevel: "normal"` 或 `"desktop"` 时，小组件不再覆盖其他普通应用窗口；
- 显示桌面时小组件可见；
- 拖动 / 缩放 / 显隐 / 多显示器夹取 / 重启后位置恢复与现状一致；
- 插件卸载 / 停用 / 总开关关闭时窗口销毁逻辑不变；
- 不要求新增插件权限；不改变提示条（edge-bar）行为。

## 5. 已否决的插件侧 workaround

- 用 PowerShell / Win32 `SetWindowPos` 修改宿主窗口 z-order：超出插件 API、依赖窗口标题枚举、无法跨版本保证、违反插件规范；
- 用页面型 widget 的 `window` API 调用层级方法：宿主 preload 只暴露 `auroraPlugin.request/onEvent`，没有窗口控制；
- 将桌面小组件换成提示条（edge-bar）：提示条本身也是置顶，且交互形态不同，不能替代。

在宿主提供上述能力之前，本插件保留 2 张置顶浮窗，并通过减少数量、精简按钮与内容来降低打扰。
