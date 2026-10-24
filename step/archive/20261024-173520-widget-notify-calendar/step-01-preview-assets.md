# Step 01 — 修复预览脚本适配 0.5.2 资源哈希

- Task: widget-notify-calendar
- Step: 1 / 7
- Status: done
- Depends on: none
- Produces: `dev/preview.mjs` 能按文件名模式发现 Aurora 0.5.2 的渲染资源，`node dev/preview.mjs` 退出码 0 并生成完整预览与截图
- Phase: 基础与配置
- Writes: `dev/preview.mjs`、`dev/.cache/`
- Size: S
- Risk: asar 头解析/数据偏移写错会导致读到错误字节；保持现有 `readAsarEntry` 的解析逻辑，只新增“列出文件再匹配”的发现层，失败时给出明确错误
- Sources: 本机 Aurora 0.5.2 `C:\Users\22798\AppData\Local\Programs\Aurora\resources\app.asar` 资源清单（访问 2026-10-24）；0.5.2 的 `widget` CSS 文件名为 `out/renderer/assets/widget-CG0kUrlE.css`

## 目标

Aurora 0.5.2 更换了 widget CSS 的构建哈希，当前 `dev/preview.mjs` 硬编码旧文件名，导致 `node dev/preview.mjs` 在“app.asar 中缺少预览所需的样式文件”处失败。本步改为按前缀/扩展名自动发现资源，使预览脚本在 0.5.2 上恢复可用，同时不改变任何插件运行代码。

## 输入

- `dev/preview.mjs`：现有 `readAsarEntry(asarPath, parts)` 与 `mainRun()` 中 4 个硬编码资源读取：
  - `out/renderer/assets/theme-BXOgGZMN.css`
  - `out/renderer/assets/PluginSchemaRenderer-B9w_IhaU.css`
  - `out/renderer/assets/widget-D6DYJhPI.css`
  - `out/renderer/assets/PluginPageFrame-Cq1k62Fi.css`
- 本机 0.5.2 实际资源：
  - `out/renderer/assets/theme-BXOgGZMN.css`
  - `out/renderer/assets/PluginSchemaRenderer-B9w_IhaU.css`
  - `out/renderer/assets/widget-CG0kUrlE.css`
  - `out/renderer/assets/PluginPageFrame-Cq1k62Fi.css`
- `dev/preview.mjs` 已有 `readAsarEntry`/`asarFiles`/`findChrome`/`screenshot`，字体提取仍按主题 CSS 里的文件名调用 `readAsarEntry`，不需要改字体逻辑。
- 0.5.2 契约：预览脚本只读取本机宿主 CSS 做静态渲染，不随插件发布；`dev/.cache/` 已被 `.gitignore` 忽略。

## 操作

1. 在 `dev/preview.mjs` 中定义 `listAsarFiles(asarPath)`：复用现有 asar 头解析方式，返回 `out/renderer/assets/` 下的全部文件名（或全部文件路径），供后续匹配。
2. 新增 `findAsset(asarPath, pattern, label)`：在文件列表里按正则匹配，找不到时抛出包含 `label` 与已见文件名的错误；不要静默回退到旧哈希。
3. 在 `mainRun()` 中用 `findAsset` 替换 4 个硬编码调用：
   - `theme-*.css`；
   - `PluginSchemaRenderer-*.css`；
   - `widget-*.css`；
   - `PluginPageFrame-*.css`。
4. 保留 `readAsarEntry` 与现有字体文件提取逻辑；字体文件仍从 `theme` 内容里的 `url('./<name>')` 读取。
5. 运行 `node dev/preview.mjs`，确认 10 个 HTML 与 11 个 PNG 都能生成（页面型周历的截图由 step 5 单独增加，本步不要求）。

## 验收标准

- [ ] `node dev/preview.mjs` 退出码 0，输出不再出现“app.asar 中缺少预览所需的样式文件”。
- [ ] `Get-ChildItem dev/.cache -Filter *.png | Measure-Object` 的 Count ≥ 11；`dev/.cache/` 下存在 `widgets-dark.png`、`panel-board-full-dark.png`、`panel-board-edit-dark.png`。
- [ ] `node dev/test-plugin.mjs` 仍为 **59/59** 通过（本步不动插件代码，测试数应保持 59/59）。
- [ ] `git diff --name-only` 只出现 `dev/preview.mjs`（`dev/.cache/` 被忽略，不应出现在 git 变更中）。
- [ ] 运行 `git diff --check` 无空白错误。

## 交接

- `dev/preview.mjs` 已支持 0.5.2 的资源哈希发现；step 2 的桌面层/亚克力改动可直接用它做视觉回归。
- 不修改 `class-management/` 下任何文件；若发现预览渲染与 0.5.2 宿主 CSS 不一致，把差异记录到执行记录，不扩大本步范围。

## 执行记录

- 实际改动（`dev/preview.mjs`）：
  - 把 asar 头解析抽成 `readAsarHeader(asarPath)`（返回 `{ headerSize, index }`），`readAsarEntry` 改为复用它，数据偏移公式不变；
  - 新增 `walkAsarFiles` / `listAsarFiles(asarPath, parts = ['out','renderer','assets'])`，递归列出 asar 内资源路径；
  - 新增 `findAsset(asarPath, pattern, label)`，按正则匹配资源名，找不到时抛错并列出已见资源（不回退旧哈希）；
  - `mainRun()` 中 4 处硬编码资源读取改为 `findAsset` 模式匹配：`theme-*.css`、`PluginSchemaRenderer-*.css`、`widget-*.css`、`PluginPageFrame-*.css`；保留 `readAsarEntry` 与字体提取逻辑。
- 与计划核对：本机 0.5.2 `app.asar` 的 `out/` 子树共 200 个文件（全包约 2701 个），`out/renderer/assets/` 下匹配到 `theme-BXOgGZMN.css`、`PluginSchemaRenderer-B9w_IhaU.css`、`widget-CG0kUrlE.css`、`PluginPageFrame-Cq1k62Fi.css`，与计划列出的实际资源一致。
- 验证命令与结果：
  - `node dev/preview.mjs` → 退出码 0，11 个 HTML + 11 张 PNG 全部生成（✓），输出无“app.asar 中缺少预览所需的样式文件”；
  - `Get-ChildItem dev/.cache -Filter *.png | Measure-Object` → Count 14（本次生成 11 张 + 3 张历史残留：`aurora-mark-*.png` ×2、`panel-notice-dark.png`），`widgets-dark.png` / `panel-board-full-dark.png` / `panel-board-edit-dark.png` 均存在；
  - `node dev/test-plugin.mjs` → 59/59 通过（本步未动插件代码）；
  - `git diff --name-only` → 仅 `dev/preview.mjs`；`git diff --check` → 无输出。
- 提交：`420d1d6`（fix: 预览脚本按模式发现 Aurora 0.5.2 资源哈希）；计划文件提交 `6616399`。
- 遗留问题：无。`dev/.cache/` 中 3 张历史残留截图不参与验收（已被 `.gitignore` 忽略）。
