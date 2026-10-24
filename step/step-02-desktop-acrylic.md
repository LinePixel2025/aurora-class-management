# Step 02 — v1.2.0 桌面层与原生亚克力

- Task: widget-notify-calendar
- Step: 2 / 7
- Status: done
- Depends on: step 1
- Produces: `manifest.json` 为 1.2.0，2 张桌面浮窗默认 `windowLevel: "desktop"` + `windowMaterial: "acrylic"`，`minAuroraVersion: "0.5.2"`；README 与旧限制文档同步
- Phase: 核心链路
- Writes: `class-management/manifest.json`、`class-management/README.md`、`README.md`、`docs/aurora-widget-desktop-level.md`、`dev/test-plugin.mjs`
- Size: S
- Risk: 0.5.2 的 `desktop` 层级是尽力而为，owner 亲和失败会回退 `normal`；Acrylic 仅在 Windows 11 22H2+ 且外观毛玻璃开启时生效。插件只能声明默认值，用户仍可在插件详情覆盖层级
- Sources: <https://github.com/LinePixel2025/Aurora-releases/releases/tag/v0.5.2>（访问 2026-10-24，Aurora v0.5.2）；`plugin-dev-kit/docs/01-contract.md` §5.3（v0.5.2）；`plugin-dev-kit/docs/02-guide.md` §7.5（v0.5.2）

## 目标

把 v1.1.0 里“浮窗只能置顶”的旧限制真正消掉：两张桌面浮窗默认落在桌面层，不再覆盖普通应用窗口；同时声明原生 Acrylic 材质，在满足条件的机器上获得半透明卡片。版本升到 v1.2.0，最低宿主版本抬到 0.5.2。

## 输入

- `class-management/manifest.json`：当前 `version` 为 `1.1.0`，`minAuroraVersion` 为 `0.5.1`，`contributes.widgets` 为 `week-overview` 与 `week-tasks`，均无 `windowLevel` / `windowMaterial`。
- `dev/test-plugin.mjs`：当前断言 `manifest.version === '1.1.0'`、`manifest.minAuroraVersion === '0.5.1'`，并断言 2 个 widget 的 slot/schema/defaultSize。
- 0.5.2 契约：桌面小组件支持 `windowLevel ∈ { floating, normal, desktop }`、`windowMaterial ∈ { none, acrylic }`；提示条小组件不接受非默认值；不新增权限或宿主 API；用户覆盖写入 `plugin-widget-layout.json` 的 `windowLevelOverride`。
- `docs/aurora-widget-desktop-level.md`：当前内容描述“插件无法实现桌面层”，已被 0.5.2 解决，必须改写，不能继续作为未解决需求文档。
- 根 `README.md` 与 `class-management/README.md` 当前写“Aurora ≥ 0.5.1”和“浮窗无法只在桌面显示”，需要同步。

## 操作

1. 修改 `class-management/manifest.json`：
   - `"version": "1.2.0"`；
   - `"minAuroraVersion": "0.5.2"`；
   - `contributes.widgets` 的两个桌面 widget 都加入：
     ```json
     "windowLevel": "desktop",
     "windowMaterial": "acrylic"
     ```
   - 保留现有 `id`、`title`、`icon`、`slot`、`schema`、`defaultSize`，不要改 widget id。
2. 修改 `docs/aurora-widget-desktop-level.md`：改成“0.5.2 已支持”的说明，记录：
   - `desktop` 是普通窗口 + Win32 owner 亲和 + 恢复守护，不是壁纸层/桌面图标层/点击穿透；
   - Acrylic 需要 Windows 11 22H2+ 且 `appearance.glass` 开启，失败回退不透明；
   - 插件默认 `desktop` + `acrylic`，用户可在插件详情逐 widget 覆盖层级；
   - 旧版本 0.5.1 会忽略字段并按 `floating` 渲染，因此最低版本抬到 0.5.2。
3. 修改根 `README.md`：
   - 版本/最低 Aurora 版本改为 `1.2.0` / `0.5.2`；
   - “平台特性与边界”不再写“无法只在桌面显示”，改为“默认桌面层 + 可覆盖；desktop 非壁纸层；Acrylic 条件与回退”；
   - 保留“不是壁纸层嵌入、不是点击穿透”的边界说明。
4. 修改 `class-management/README.md`：同样更新版本、最低宿主版本、桌面浮窗表和平台特性说明。
5. 修改 `dev/test-plugin.mjs`：
   - 清单断言改为 `version === '1.2.0'`、`minAuroraVersion === '0.5.2'`；
   - 小组件断言增加：两个 widget 的 `windowLevel === 'desktop'`、`windowMaterial === 'acrylic'`；
   - 保留宿主原版 zod `parsePluginManifest` 校验，确保新字段被 0.5.2 接受；
   - 如果新增独立测试，更新最终测试计数并在 step 6 同步 README。
6. 运行静态检查、离线测试和预览，确认无回归。

## 验收标准

- [ ] `node plugin-dev-kit/tools/check-plugin.mjs class-management` 退出码 0，输出 `v1.2.0`。
- [ ] `node dev/test-plugin.mjs` 全绿，输出中的清单版本为 `1.2.0`；测试数与最终记录一致，无失败项。
- [ ] `node dev/preview.mjs` 退出码 0，生成 11 个 PNG；本步不改变 schema，视觉应与 v1.1.0 一致。
- [ ] `node -e "const m=require('./class-management/manifest.json'); const ok=m.version==='1.2.0'&&m.minAuroraVersion==='0.5.2'&&m.contributes.widgets.length===2&&m.contributes.widgets.every(w=>w.slot==='desktop'&&w.windowLevel==='desktop'&&w.windowMaterial==='acrylic'); process.exit(ok?0:1)"` 退出码 0。
- [ ] `Select-String -Path README.md,class-management/README.md -Pattern '无法.*桌面|不能.*桌面'` 无输出；两处平台说明包含 `windowLevel` 或“桌面层”。
- [ ] `git diff --check` 无空白错误。
- [ ] 真机手动核对（安装 v1.2.0 后）：插件详情里两张浮窗层级默认显示“桌面层”；浏览器或 Office 可以覆盖浮窗；Win+D 后浮窗仍在桌面；Acrylic 生效或按条件回退为不透明；用户把层级改回“置顶”后恢复旧行为。

## 交接

- `manifest.json` 已是 v1.2.0，后续 step 3/4/5 都在此版本上继续升版本。
- 用户覆盖层级仍由宿主管理，插件不读取/修改 `plugin-widget-layout.json`。
- 旧 `docs/aurora-widget-desktop-level.md` 已从“需求”改为“0.5.2 能力说明”，后续文档不再引用“插件无法实现”。

## 执行记录

- 实际改动（提交 `29ad322`，5 个文件）：
  - `class-management/manifest.json`：`version` 1.2.0、`minAuroraVersion` 0.5.2，两个 widget 增加 `windowLevel: "desktop"` + `windowMaterial: "acrylic"`（位于 `slot` 之后，其余字段与 widget id 未动）。
  - `docs/aurora-widget-desktop-level.md`：整篇从“0.5.1 需求说明”改写为《Aurora 桌面层与亚克力小组件能力说明（v0.5.2）》：能力字段、插件声明示例、用户覆盖层级（`windowLevelOverride`）、边界（非壁纸层/图标层/点击穿透、owner 亲和失败回退 normal、Acrylic 条件与不透明回退）、旧宿主 0.5.1 静默忽略字段因此抬最低版本、生效自查清单。
  - `README.md`（根）：Aurora 版本口径改 0.5.2；「平台特性与边界（Aurora 0.5.2）」重写为桌面层 + 可覆盖 + Acrylic 条件与回退；删除“浮窗无法只在桌面显示”的旧限制；目录说明里 docs 文档描述同步。
  - `class-management/README.md`：版本 1.2.0 / Aurora ≥ 0.5.2；桌面浮窗表增加 `windowLevel` / `windowMaterial` 两列；平台特性同步 0.5.2。
  - `dev/test-plugin.mjs`：清单断言改 1.2.0 / 0.5.2；widget 测试增加两个 `windowLevel === 'desktop'` / `windowMaterial === 'acrylic'` 断言；`ctx.plugin.version` 同步 1.2.0；仍保留宿主原版 zod `parsePluginManifest` 校验。
- 子代理分片与结果：
  - 分片 A（docs/aurora-widget-desktop-level.md）：完成；自检 33 行关键字段命中、过时断言 0 命中、文档内 manifest 片段与真实清单逐字段一致。
  - 分片 B（README.md + class-management/README.md）：完成；自检两文件均命中 0.5.2 / windowLevel / 桌面层，旧限制表述 0 命中。
  - 主代理：manifest、`dev/test-plugin.mjs` 断言；集成与验收复跑。
- 验证命令与结果（均为主代理实跑）：
  - `node plugin-dev-kit/tools/check-plugin.mjs class-management` → 退出码 0，`✓ 清单通过：…v1.2.0`；
  - `node dev/test-plugin.mjs` → **59/59** 通过（校验器：Aurora 0.5.2 宿主校验器；含宿主原版 zod 清单解析通过）；
  - 清单断言 `node -e ...` → 退出码 0；
  - `node dev/preview.mjs` → 退出码 0，11 张 PNG 生成（视觉与 v1.1.0 一致，本步未改 schema）；
  - `Select-String -Path README.md,class-management/README.md -Pattern '无法.*桌面|不能.*桌面'` → 无命中；两处平台说明包含 `windowLevel` / 桌面层 / acrylic；
  - `git diff --check` → 无输出。
- 遗留问题：验收标准中的“真机手动核对（安装 v1.2.0 后校验桌面层/Acrylic/层级覆盖）”无法在离线环境自动完成，需用户在 Aurora 0.5.2 真机验收；代码侧已按契约声明默认值，未做外部 Win32 修改。
