# Step 06 — v2.0.0 文档、截图与构建

- Task: widget-notify-calendar
- Step: 6 / 7
- Status: done
- Depends on: step 5
- Produces: 根 README 与插件 README 更新到 2.0.0；`docs/images/calendar-dark.png` 与 `calendar-light.png` 截图；全量验证通过并构建 `dist/class-management-2.0.0.zip`
- Phase: 测试与文档
- Writes: `README.md`、`class-management/README.md`、`docs/images/calendar-dark.png`、`docs/images/calendar-light.png`、`dev/preview-calendar.mjs`、`dev/.cache/`、`dist/`
- Size: M
- Risk: README 与真实清单/测试数量/构建 SHA 不一致；截图必须来自 step 5 的真实页面预览，不能手工画
- Sources: 本仓库 `README.md`、`class-management/README.md`、`dev/preview-calendar.mjs`（当前版本，2026-10-24）

## 目标

把 v2.0.0 的三个功能完整写进文档和截图，并跑通全部验收命令、构建发布包。文档要明确：桌面层与亚克力的边界、通知默认关闭且只在 Aurora 运行时生效、页面周历是第二个面板且只走沙箱桥。

## 输入

- step 2-5 的产出：`manifest.json` v2.0.0、2 个 panels（`board` + `calendar`）、3 个 commands（`class` / `week-plan` / `calendar`）、`notifications` 权限、5 个通知配置字段、页面文件、页面预览脚本。
- `dev/preview-calendar.mjs`：step 5 生成单张 `dev/.cache/calendar-preview.png`；本步扩展为生成暗色/亮色两张。
- 现有 `README.md` 与 `class-management/README.md`：仍描述 v1.1.0 的 2 浮窗/4 视图/12 工具、无通知、无页面面板。
- 离线测试会输出最终 `N/N` 数字，必须用真实输出更新 README，不得沿用旧数字。
- `scripts/build.ps1` 会输出 zip 大小与 SHA-256，必须把真实值写回根 README。

## 操作

1. 修改 `dev/preview-calendar.mjs`：
   - 生成两张页面截图：默认暗色 `dev/.cache/calendar-preview.png` 与浅色 `dev/.cache/calendar-preview-light.png`；
   - 浅色通过给预览 HTML 加 `data-theme="light"` 或 `prefers-color-scheme` 模拟，保证 `calendar.css` 的浅色变量生效；
   - 退出码与截图存在性检查与 `dev/preview.mjs` 保持一致。
2. 把两张截图复制到 `docs/images/calendar-dark.png` 与 `docs/images/calendar-light.png`。
3. 修改根 `README.md`：
   - 标题/首段改为 v2.0.0，增加“桌面层 + 亚克力”“系统通知”“页面型班级周历”三条能力；
   - 浮窗图片后增加 `docs/images/calendar-dark.png`（可再加 light 链接）；
   - 管理台说明增加第二个面板“班级周历”（`/calendar`），强调垂直 7 天时间线、拖动事务、页面沙箱；
   - 权限列表增加 `notifications`；
   - 配置说明增加 5 个通知字段及默认全关；
   - 平台特性说明：`windowLevel: desktop` / `windowMaterial: acrylic` 已启用，`desktop` 非壁纸层，Acrylic 条件与回退；
   - 验证结果更新为真实测试数、check-plugin 结果、zip 大小与 SHA-256；
   - 故障排查增加“桌面层不生效”的检查项（用户覆盖、Windows 版本/毛玻璃、owner 亲和失败回退）。
4. 修改 `class-management/README.md`：
   - 版本/最低 Aurora 版本改为 `2.0.0` / `0.5.2`；
   - 目录/面板说明增加 `ui/calendar.*`、`lib/notify.js`、`lib/calendar.js`；
   - 桌面浮窗表补充 `windowLevel` / `windowMaterial`；
   - 管理台改为“2 个面板：声明式今日 + 页面型班级周历”；
   - 权限、配置、通知行为、页面沙箱限制写清楚；
   - 验证命令与测试数更新。
5. 运行全部验证：
   - `node plugin-dev-kit/tools/check-plugin.mjs class-management`；
   - `node dev/test-plugin.mjs`；
   - `node dev/preview.mjs`；
   - `node dev/preview-calendar.mjs`；
   - `powershell -ExecutionPolicy Bypass -File scripts\build.ps1`。
6. 用构建输出的真实大小/SHA 更新根 README 的“验证结果”。
7. 检查 `dist/class-management-2.0.0.zip` 存在，且 zip 根包含 `manifest.json`。

## 验收标准

- [ ] `node plugin-dev-kit/tools/check-plugin.mjs class-management` 退出码 0，输出 `v2.0.0`。
- [ ] `node dev/test-plugin.mjs` 全绿，输出真实 `N/N`；根 README 的测试数字与输出一致。
- [ ] `node dev/preview.mjs` 退出码 0；`node dev/preview-calendar.mjs` 退出码 0，`dev/.cache/calendar-preview.png` 与 `dev/.cache/calendar-preview-light.png` 都存在。
- [ ] `docs/images/calendar-dark.png`、`docs/images/calendar-light.png` 存在且非空；根 README 能链接到它们。
- [ ] `powershell -ExecutionPolicy Bypass -File scripts\build.ps1` 退出码 0；生成 `dist/class-management-2.0.0.zip`；根 README 中的 zip 大小与 SHA-256 与 `Get-FileHash` 输出一致。
- [ ] `node -e "const fs=require('fs'); const r=fs.readFileSync('README.md','utf8'); const p=fs.readFileSync('class-management/README.md','utf8'); const ok=['2.0.0','notifications','班级周历','windowLevel','windowMaterial'].every(k=>r.includes(k)&&p.includes(k)); process.exit(ok?0:1)"` 退出码 0。
- [ ] 根 README 仍保留“插件不是 OS 沙箱，安装即信任”和“desktop 不是壁纸层/点击穿透”的边界说明。
- [ ] `git diff --check` 无空白错误。

## 交接

- 文档、截图、构建产物就绪；step 7 只做归档，不再改功能或文档。
- 若构建 SHA 与 README 不一致，先修 README 再进入归档。
- 不把 `dist/` 或 `dev/.cache/` 加入 git；它们已被 `.gitignore` 忽略。

## 执行记录

- 实际改动：
  - `README.md`（根）：版本口径 v2.0.0 / Aurora ≥ 0.5.2；能力列表增加「页面型班级周历」、命令 3 条；新增 `docs/images/calendar-dark.png` 截图与浅色链接；新增「班级周历（页面型面板）」小节（7 天时间线、拖动、页内编辑、过去周只读、页面沙箱、4 条推送）；交付物树补 `lib/calendar.js` / `lib/notify.js` / `ui/calendar.*` / `dev/preview-calendar.mjs` / 周历截图；验证段更新为 check-plugin v2.0.0、`88/88`、preview 与 preview-calendar；真机验收补周历与通知项；故障排查新增「桌面层不生效 / 没有亚克力」；zip 行更新为 `dist/class-management-2.0.0.zip` 72.4 KB + SHA-256；保留「不是 OS 沙箱，安装即信任」「desktop 不是壁纸层/点击穿透」边界。
  - `class-management/README.md`（随包发布）：版本 2.0.0 / Aurora ≥ 0.5.2；面板改为 2 个（声明式事务台 + 页面型班级周历）；新增页面沙箱说明（仅 `window.auroraPlugin.request/onEvent`、无内联脚本/CDN/fetch）；目录补 `lib/calendar.js` / `ui/calendar.*`；命令 3 条；推送 2 面板 + 2 浮窗 = 4 条（≤5）；测试 `88/88`。
  - `docs/images/calendar-dark.png`（183 KB）、`docs/images/calendar-light.png`（186 KB）：由 `dev/preview-calendar.mjs` 从真实 `ui/calendar.html|css|js` 渲染后截图拷入（暗色主视图 / 浅色主题）。
  - 构建：`dist/class-management-2.0.0.zip`，**72.4 KB**，SHA-256 `19A3ED666E7F7E3FC99DE460756FA3D5894DA37DE8BDA8A0D10B448D0847FC6E`，22 个条目、manifest 在 zip 根、无 `node_modules` / `dev/` / `.cache`。
  - 本步集成期间的两个补充修复：`e0ec476`（声明式面板动作推送改为 4 个目标，含周历面板，并补 1 条断言）；`0da28dd`（页面弹层 `[hidden]` 显隐、窄栏统计换行、`＋ 安排` 按钮样式、预览截图健壮性）。
- 子代理分片与结果（3 个并行分片）：
  - A 根 `README.md`：完成；关键项自检与截图引用核对通过。
  - B `class-management/README.md`：完成；版本/权限/面板/目录/测试数更新，`1.3.0` 无残留。
  - C 页面预览最终验证（`dev/preview-calendar.mjs` 作者）：三张截图重跑通过，并用 headless DOM 校验 7 个 `.cal-day`、今日高亮、编辑弹层回填；提醒文档截图需用最新 CSS/JS 重新拷贝（已由主代理刷新）。
- 验证命令与结果（主代理实跑）：
  - `node plugin-dev-kit/tools/check-plugin.mjs class-management` → 退出码 0，`✓ 清单通过：…v2.0.0`；
  - `node dev/test-plugin.mjs` → **88/88** 通过；
  - `node dev/preview.mjs` → 退出码 0（11 张声明式预览图）；`node dev/preview-calendar.mjs` → 退出码 0（3 张页面截图，470×1500）；
  - `powershell -ExecutionPolicy Bypass -File scripts\build.ps1` → 退出码 0，生成 `dist/class-management-2.0.0.zip`（72.4 KB / SHA 见上）；zip 根含 `manifest.json`，含 `ui/calendar.html` / `lib/calendar.js` / `lib/notify.js` / 插件 README；
  - 文档/产物静态验收脚本（25 项）：两份 README 均含 `2.0.0` / `notifications` / `班级周历` / `windowLevel` / `windowMaterial`；根 README 保留边界说明并链接两张周历截图、无 `1.1.0` 残留；README 写的大小与实际 zip 一致（72.4 KB）；`Get-FileHash` 与 README SHA 一致；
  - `git diff --check` → 无输出。
- 遗留问题：真机手动核对需用户在 Aurora 0.5.2 上完成（安装 v2.0.0 包、桌面层/Acrylic、通知、`/calendar` 页面交互、刷新后数据保留）；离线侧清单/测试/预览/构建/文档一致性均已验证。
