# Step 06 — v2.0.0 文档、截图与构建

- Task: widget-notify-calendar
- Step: 6 / 7
- Status: pending
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

（执行后填写：实际改动、验证结果、遗留问题。）
