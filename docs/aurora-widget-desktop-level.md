# Aurora 桌面小组件与页面型小组件说明（班级事务台 v2.1.1）

> 适用宿主：Aurora **0.5.3 及以上**（`hideCloseButton` 需要 0.5.3+）
> 插件：`com.classmanagement.board`（班级事务台）
> 契约依据：宿主插件契约 §3.1 / §5.3（桌面小组件）、开发指南 §7.5（桌面 / 提示条小组件）

## 1. 本版声明的组合

班级事务台 v2.1.1 的 2 张桌面小组件都声明为**页面型小组件**（`entry` 页面），默认层级 `desktop`、
材质 `none`（不启用原生 Acrylic / 毛玻璃），并通过 `hideCloseButton: true` 请求宿主隐藏标题栏右上角的
「隐藏小组件」按钮；`minAuroraVersion` 为 `0.5.3`。

| 小组件 | widget id | 形态 | 默认层级 | 默认材质 | 默认尺寸 |
| --- | --- | --- | --- | --- | --- |
| 班级速览 | `week-overview` | 页面型（`ui/widget-overview.html`） | `desktop` | `none` | 320×300 |
| 今日事务 | `week-tasks` | 页面型（`ui/widget-tasks.html`） | `desktop` | `none` | 360×460 |

清单片段：

```json
{
  "version": "2.1.1",
  "minAuroraVersion": "0.5.3",
  "contributes": {
    "widgets": [
      {
        "id": "week-overview",
        "title": "班级速览",
        "icon": "Gauge",
        "slot": "desktop",
        "windowLevel": "desktop",
        "windowMaterial": "none",
        "hideCloseButton": true,
        "entry": "ui/widget-overview.html",
        "defaultSize": { "width": 320, "height": 300 }
      },
      {
        "id": "week-tasks",
        "title": "今日事务",
        "icon": "ListChecks",
        "slot": "desktop",
        "windowLevel": "desktop",
        "windowMaterial": "none",
        "hideCloseButton": true,
        "entry": "ui/widget-tasks.html",
        "defaultSize": { "width": 360, "height": 460 }
      }
    ]
  }
}
```

三枚清单字段：

| 字段 | 取值 | 默认 | 作用范围 |
| --- | --- | --- | --- |
| `windowLevel` | `"floating"` / `"normal"` / `"desktop"` | `"floating"` | 仅 `slot: "desktop"` |
| `windowMaterial` | `"none"` / `"acrylic"` | `"none"` | 仅 `slot: "desktop"` |
| `hideCloseButton` | `true` / `false` | `false` | 仅 `slot: "desktop"` |

- `desktop`：不置顶；宿主在 Windows 上把窗口的 Win32 owner 指向桌面 shell 视图，并带最小化恢复守护，
  让 Win+D / Win+M 后仍尽量可见；属**尽力而为**，owner 亲和失败时回退 `normal`。
- `none`：不透明卡片，不使用 DWM Acrylic。v2.0.0 曾使用 `acrylic`，v2.1.0 起改回 `none`，
  避免「宿主外观毛玻璃关闭时不生效、开启时又过透」的观感不一致；小组件内容自带不透明底。
- `hideCloseButton: true`：宿主不渲染标题栏右上角的「隐藏小组件」按钮；本插件两张小组件均已开启。
  旧宿主会静默忽略该字段，仍显示按钮；需要支持它的 Aurora 版本。

## 2. 页面型小组件（`entry`）

- 宿主为每个可见小组件创建一张无边框 `BrowserWindow`，窗口内由宿主渲染标题栏（标题；声明
  `hideCloseButton: true` 时不渲染隐藏按钮），页面本体以 `webview` 加载
  `aurora-plugin://<pluginId>/<entry>`；
- 页面只通过 `window.auroraPlugin.request(method, params)` / `onEvent(listener)` 与插件进程通信
  （与页面型面板同一套沙箱口径），没有内联脚本、没有 CDN、没有 `fetch`；
- 页面布局位于宿主标题栏下方，可用高度约为 `defaultSize.height - 28px`；内容超出时页面内滚动；
- 宿主在插件写入后通过 `ctx.ui.panelEvent({ widgetId })` 推送 `board.changed`，页面收到后重新 `load`；
- 插件不创建窗口、不读取或修改宿主窗口属性，也不调用任何 Win32 API；层级与材质的实际效果由宿主实现。

## 3. 关于小组件右上角的「×」

宿主在小组件窗口标题栏里自绘一枚 `×`（隐藏小组件）按钮，点击后把该 widget 的 `visible` 置为 `false`
（写入 `<userData>/plugin-widget-layout.json`）。v2.1.x 起本插件在两张小组件上声明
`hideCloseButton: true`，宿主不再渲染该按钮；隐藏 / 恢复改到 **Aurora → 设置 → 插件 → 班级事务台 →
显示在桌面** 操作（位置 / 尺寸沿用布局文件，不会丢）。

该字段需要支持它的 Aurora 版本；旧宿主会静默忽略未知字段，仍显示 `×`。插件侧不修改宿主安装包，
也不通过 CSS / 页面内容遮挡——按钮属于宿主窗口 chrome，不在页面 DOM 里。

## 4. 用户如何覆盖层级

设置 → 插件 → 班级事务台 → 插件详情，每个桌面小组件有一枚「显示在桌面」开关和一枚层级下拉：

| 下拉项 | 效果 |
| --- | --- |
| 跟随插件 | 使用清单声明的默认层级（本插件为 `desktop`） |
| 置顶 | 按 `floating` 渲染（置顶浮动卡片） |
| 普通 | 按 `normal` 渲染，不置顶 |
| 桌面层 | 按 `desktop` 渲染，尽力贴合桌面 |

- 覆盖值由宿主写入 `<userData>/plugin-widget-layout.json` 的 `windowLevelOverride` 字段；缺省表示跟随清单。
- **插件不读取、也不修改 `plugin-widget-layout.json`**；用户改层级不需要重装插件。
- 关闭「显示在桌面」开关会销毁窗口，但保留布局条目；重新打开后沿用原位置。

## 5. 边界说明

- `desktop` 的语义是「普通窗口 + Win32 owner 亲和 + 恢复守护」，**不是**壁纸层嵌入、
  **不是**桌面图标层、**也不是**点击穿透。
- `desktop` 不置顶：浏览器、Office 等普通应用窗口被激活时可以覆盖小组件。
- Win+D / Win+M 后小组件「尽量」保持可见，这是恢复守护带来的尽力而为，不是硬保证。
- 页面型小组件窗口仍由宿主创建和管理；插件只声明 `entry`、`windowLevel`、`windowMaterial`、`defaultSize`。
- 提示条小组件（`slot: "edge-bar"`）不创建窗口，也不接受 `windowLevel` / `windowMaterial` 非默认值；
  本项目未使用提示条槽位。

## 6. 旧版本对照

| 版本 | 形态 | 毛玻璃 | 说明 |
| --- | --- | --- | --- |
| v1.0.x / v1.1.0 | 声明式 widget | 无 | 宿主按置顶浮动卡片渲染 |
| v2.0.0 | 声明式 widget | `acrylic` | 新增 `windowLevel: desktop` + `windowMaterial: acrylic` |
| v2.1.0 | **页面型 widget（`entry`）** | **`none`** | 自定义 HTML/CSS 与班级周历同一套视觉；不再使用 Acrylic |

## 7. 生效自查

- 宿主为 0.5.3 及以上，插件为 v2.1.1 且状态「运行中」；
- 插件详情里，两张小组件显示「桌面 · 页面」且不带「毛玻璃」标记；
- 桌面小组件为不透明卡片（无 Acrylic 透出），内容排版与班级周历一致；
- 打开浏览器或 Office，小组件可被普通应用窗口覆盖；回到桌面时仍在；
- 两张小组件标题栏只有标题、右上角无 `×`（`hideCloseButton: true`）；需要隐藏 / 恢复时到设置里
  切换「显示在桌面」；
- 把某张小组件层级改为「置顶」可恢复置顶浮动行为；改回「跟随插件」恢复桌面层。
