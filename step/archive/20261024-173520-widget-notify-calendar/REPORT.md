# 任务归档报告：widget-notify-calendar

- 任务：为班级事务台增加桌面层/亚克力、系统通知与页面型班级周历
- 项目：D:\AICOP\ClassManagement（Aurora 插件 com.classmanagement.board）
- 完成时间：2026-10-24 17:35
- 归档路径：step/archive/20261024-173520-widget-notify-calendar
- 基线提交：54719f5；任务结束提交：3aa8128（含 4a9a37c）
- 版本：插件 v1.1.0 → v2.0.0（minAuroraVersion 0.5.2）

## 各步骤结果（离线验收均通过）

- step 1：dev/preview.mjs 按模式发现 Aurora 0.5.2 资源哈希（listAsarFiles/findAsset）；preview 11 张 PNG、59/59。提交 420d1d6。
- step 2：manifest v1.2.0 + 两 widget windowLevel=desktop/windowMaterial=acrylic；docs/aurora-widget-desktop-level.md 改写为 0.5.2 能力说明；两份 README 平台特性同步；59/59。提交 29ad322。
- step 3：lib/notify.js（每日简报/截止提醒/周一值日、notify.v1 去重、失败只记日志）；manifest v1.3.0 + notifications 权限 + 5 配置字段；main 接线与激活补发；71/71。审查修复 5f47d77（截止窗口与跨天截止任务，73/73）。提交 c29e651。
- step 4：ops.loadWeekGrid/moveTask；lib/calendar.js 页面请求处理器；main.invokePanel calendar 分支；81/81。提交 9d7b9a9。
- step 5：manifest v2.0.0 + 页面型 calendar 面板（ui/calendar.html|css|js）+ calendar 命令；push 2 面板 + 2 浮窗 4 条；dev/preview-calendar.mjs 三张页面截图（暗/浅/编辑弹层）；88/88。提交 f830be5；集成修复 e0ec476（面板动作推 4 目标）、0da28dd（页面弹层/窄栏/预览健壮性）。
- step 6：两份 README 更新到 v2.0.0；docs/images/calendar-dark.png / calendar-light.png；构建 dist/class-management-2.0.0.zip。提交 91e1ee3、af30489。
- 审查修复：4a9a37c（页面写推送、onEvent 签名、过去周写拒绝、dueLabel、push 口径、manifest 描述、类型注释、build 语法门禁与 zip 断言）、3aa8128（测试补强 88→98、文档与执行记录回填）。

## 最终验证（主代理实跑）

- node plugin-dev-kit/tools/check-plugin.mjs class-management → 通过，v2.0.0（2 面板 / 3 命令 / 12 工具 / 9 权限 / 9 配置字段）。
- node dev/test-plugin.mjs → 98/98 通过（宿主原版 zod 清单解析 + schema 校验；含通知去重、周历后端、页面静态约束、推送 4 目标）。
- node dev/preview.mjs → 退出码 0（声明式预览 11 张 PNG）。
- node dev/preview-calendar.mjs → 退出码 0（3 张 470×1500 页面截图；7 天时间线/值日条/添加表单/编辑弹层/浅色主题均可见）。
- powershell -ExecutionPolicy Bypass -File scripts\build.ps1 → 退出码 0；生成 dist/class-management-2.0.0.zip，73.2 KB，SHA-256 574B2C8D321E1C390C9B46D6FD446DCDEFC1FF3CDD8D1C2649EFC2E3D62DBC94；zip 根含 manifest.json，无 dev//node_modules/.cache。
- git diff --check 通过；构建产物的 SHA/大小与根 README 一致。

## 代码审查结论与处置

- 7 个独立审查子代理（干净上下文）：验收复跑、页面 CSP/前端、后端边界、安全与权限、测试质量、清单/推送/文档一致性、回归一致性。结论均为「有条件可交付」，无 P0。
- 已修复 P1：①周历页写操作未推送（现写动作成功后 pushAll 4 目标；过去周写后端拒绝）；②页面 onEvent 用错宿主签名（改为 onEvent(listener) 并在 pagehide 取消）；③00-index 执行记录缺 step 3-5（已补齐并附 SHA）。
- 已修复 P2/P3（择要）：dueLabel 未来日期仅填时间误显示“今天”；manifest description 未体现 v2.0.0 能力；docs 插件版本旧值；push “宿主单次 5 条上限”口径（实际 20 条/秒）；types 契约版本与页面结果 error/message；build.ps1 增加 JS 语法检查与 zip 敏感文件断言；step 执行记录写范围/数字/SHA 回填。
- 已知未处理项（P2/P3，不影响离线交付）：测试在无本机 Aurora 时宿主校验器静默降级（README 已说明降级行为）；页面 JS 由预览/人工验证而非自动化 DOM 测试执行；preview 脚本无浏览器时退出码 0；周历页少量 UX 打磨（成功提示自动清除、未提交输入在重绘时保留、弹层焦点陷阱、IME Esc）；过去天只读以后端“拒绝过去周”+前端禁用为主，未逐日做后端纵深校验；dist 下保留历史 1.1.0 包（已 gitignore）。

## 待用户真机验收（离线无法完成）

- 安装 dist/class-management-2.0.0.zip 后：2 张浮窗默认桌面层 + Acrylic（含回退/用户覆盖层级）；/calendar 打开班级周历，7 天卡片、添加/完成/编辑/删除/拖动、切周、计划/值日/通知编辑、刷新后数据保留；三类通知到点各一次、重启后不重复、默认全关不打扰。
