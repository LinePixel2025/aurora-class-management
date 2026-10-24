# Aurora 桌面层与亚克力小组件能力说明（v0.5.2）

> 状态：**已由宿主 0.5.2 提供，本插件已采用**（班级事务台 v2.0.0；桌面层 / 亚克力自 v1.2.0 引入，v2.0.0 沿用）
> 适用宿主：Aurora **0.5.2 及以上**（插件 API v1）
> 插件：`com.classmanagement.board`（班级事务台）
> 契约依据：宿主插件契约 §3.1 / §5.3（桌面小组件）、开发指南 §7.5（桌面 / 提示条小组件）

## 1. 能力概览

Aurora 0.5.2 为**桌面小组件**（`slot: "desktop"`）新增两枚清单声明字段：`windowLevel` 与
`windowMaterial`。插件在 `contributes.widgets` 里声明默认层级与材质，窗口仍由宿主创建和管理；
该能力**不新增权限，也不新增宿主 API**。

| 字段 | 取值 | 默认 | 作用范围 |
| --- | --- | --- | --- |
| `windowLevel` | `"floating"` / `"normal"` / `"desktop"` | `"floating"` | 仅 `slot: "desktop"` |
| `windowMaterial` | `"none"` / `"acrylic"` | `"none"` | 仅 `slot: "desktop"` |

`windowLevel` 的三档：

- `floating`：置顶浮动卡片（`alwaysOnTop`），与 0.5.1 行为一致；
- `normal`：不置顶，按普通无边框窗口参与 z-order；
- `desktop`：不置顶；宿主在 Windows 上把窗口的 Win32 owner 指向桌面 shell 视图，并带最小化
  恢复守护，让 Win+D / Win+M 后仍尽量可见。**属尽力而为**：owner 亲和失败时回退 `normal`。

`windowMaterial` 的两档：

- `none`：默认，不透明卡片；
- `acrylic`：原生 Acrylic 材质，**仅 Windows 11 22H2 及以上、且宿主外观设置
  `appearance.glass`（毛玻璃）开启时**逐 widget 生效；不满足条件或启用失败时保持不透明卡片。

提示条小组件（`slot: "edge-bar"`）不创建窗口，**不接受非默认值**：在其中声明
`windowLevel` / `windowMaterial` 会被清单校验直接拒绝。本插件当前只使用 2 个桌面小组件，
未使用提示条槽位。

## 2. 本插件如何声明

班级事务台 v2.0.0 的 2 张桌面浮窗都默认声明 `desktop` + `acrylic`，并把 `minAuroraVersion`
抬到 `0.5.2`。清单片段如下（完整清单见
[`class-management/manifest.json`](../class-management/manifest.json)）：

```json
{
  "version": "2.0.0",
  "minAuroraVersion": "0.5.2",
  "contributes": {
    "widgets": [
      {
        "id": "week-overview",
        "title": "班级速览",
        "icon": "Gauge",
        "slot": "desktop",
        "windowLevel": "desktop",
        "windowMaterial": "acrylic",
        "schema": "ui/widget-overview.json",
        "defaultSize": { "width": 320, "height": 300 }
      },
      {
        "id": "week-tasks",
        "title": "今日事务",
        "icon": "ListChecks",
        "slot": "desktop",
        "windowLevel": "desktop",
        "windowMaterial": "acrylic",
        "schema": "ui/widget-tasks.json",
        "defaultSize": { "width": 360, "height": 460 }
      }
    ]
  }
}
```

| 浮窗 | widget id | 默认层级 | 默认材质 | 默认尺寸 |
| --- | --- | --- | --- | --- |
| 班级速览 | `week-overview` | `desktop` | `acrylic` | 320×300 |
| 今日事务 | `week-tasks` | `desktop` | `acrylic` | 360×460 |

- 插件只声明**默认值**：不创建窗口、不读取或修改宿主窗口属性，也不调用任何 Win32 API；
  层级与材质的实际效果由宿主实现。
- 沿用现有 `ui.widgets` 权限；这两个字段不引入新权限，也不需要新的插件 API。
- 入口、schema、`defaultSize` 与 v1.1.0 相同，只增加默认层级与材质。

## 3. 用户如何覆盖层级

设置 → 插件 → 班级事务台 → 插件详情，每个桌面 widget 有一枚「显示在桌面」开关和一枚层级下拉：

| 下拉项 | 效果 |
| --- | --- |
| 跟随插件 | 使用清单声明的默认层级（本插件为 `desktop`） |
| 置顶 | 按 `floating` 渲染，恢复 0.5.1 的置顶行为 |
| 普通 | 按 `normal` 渲染，不置顶 |
| 桌面层 | 按 `desktop` 渲染，尽力贴合桌面 |

- 覆盖值由宿主写入 `<userData>/plugin-widget-layout.json` 的 `windowLevelOverride` 字段；
  缺省表示跟随清单。
- **插件不读取、也不修改 `plugin-widget-layout.json`**；用户改层级不需要重装插件，也不会
  改到 `manifest.json`。
- 关闭「显示在桌面」开关会销毁窗口，但保留布局条目；重新打开后沿用原位置。

## 4. 边界说明

- `desktop` 的语义是「普通窗口 + Win32 owner 亲和 + 恢复守护」，**不是**壁纸层嵌入、
  **不是**桌面图标层、**也不是**点击穿透。浮窗仍是宿主创建的独立无边框窗口，不进入壁纸
  或桌面图标层。
- owner 亲和**属尽力而为**：宿主无法完成亲和（例如桌面 shell 结构变化）时回退 `normal`，
  不会因此隐藏或销毁浮窗。
- `desktop` 不置顶：浏览器、Office 等普通应用窗口被激活时可以覆盖浮窗。
- Win+D / Win+M 后浮窗「尽量」保持可见，这是恢复守护带来的尽力而为，不是硬保证。
- Acrylic **不是所有机器都生效**：仅 Windows 11 22H2 及以上且 `appearance.glass` 开启；
  Windows 10、旧版 Windows 11、毛玻璃关闭或启用失败时都保持不透明卡片，不影响可用性。
- `floating` 仍是宿主默认值；未声明这两个字段的插件行为不变。

## 5. 旧宿主（0.5.1）的行为与最低版本

0.5.1 时代没有这两个字段：宿主把桌面 widget 的窗口层级硬编码为置顶
（`alwaysOnTop: true`、`setAlwaysOnTop(true, 'floating')`），`contributes.widgets` 只有 `slot`，
插件 API 也不提供窗口控制。这是旧文档记录的历史背景，已不再是当前限制。

0.5.2 起宿主才识别这两个字段。0.5.1 会**静默忽略**未知字段：即使清单写了
`windowLevel: "desktop"` / `windowMaterial: "acrylic"`，也仍按默认的 `floating` 渲染并且
不会报错。因此本插件把 `minAuroraVersion` 声明为 `0.5.2`；低于该版本时不满足最低宿主版本
要求，避免出现「声明了桌面层、实际却仍然置顶」的预期落差。

## 6. 生效自查

- 宿主为 0.5.2 及以上，插件为 v2.0.0 且状态「运行中」；
- 插件详情里，两张浮窗在「跟随插件」（首次安装的默认状态）时显示「桌面层」；
- 打开浏览器或 Office，浮窗可被普通应用窗口覆盖；回到桌面时浮窗仍在；
- Win+D 后浮窗仍在桌面（尽力而为，失败时按 `normal` 处理）；
- Windows 11 22H2 及以上且外观毛玻璃开启时卡片呈亚克力效果，否则为不透明卡片；
- 把某张浮窗层级改为「置顶」可恢复 0.5.1 的置顶行为；改回「跟随插件」恢复桌面层。
