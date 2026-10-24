# Step 07 — 归档清理

- Task: widget-notify-calendar
- Step: 7 / 7
- Status: pending
- Depends on: step 1..6
- Produces: 本次计划文件整体移入 `step/archive/<YYYYMMDD-HHMMSS>-widget-notify-calendar/`，`step/` 顶层恢复干净
- Phase: 测试与文档
- Writes: `step/`
- Size: S
- Risk: 归档目录名与 `00-index.md` 记录不一致、或把 `step/archive/` 里的历史归档一起移动；必须先冻结一次时间戳，再写索引、再移动
- Sources: `step-planner` skill 的归档规范（本机 `C:\Users\22798\.agents\skills\step-planner\SKILL.md`，2026-10-24）；`step-runner` skill 的归档目录命名规范（本机 `C:\Users\22798\.agents\skills\step-runner\SKILL.md`）

## 目标

在 step 1–6 全部完成且验收通过后，把本次生成的 7 个 step 文件与 `00-index.md` 归档到带时间戳的目录，写一份简洁的 `REPORT.md`，让 `step/` 顶层只留下 `archive/`，便于下一次任务重新开始。

## 前置检查

- 先读 `D:\AICOP\ClassManagement\step\00-index.md`，确认“完成标准”已满足、“待确认”没有悬而未决的问题。
- 确认 step 1–6 的 `Status` 都是 `done`，且各自的验收标准都已执行并记录在“执行记录”里。
- 确认当前 git 工作区没有未提交的功能改动；若有，先让执行阶段完成提交，再归档。
- 只要有任何一步没完成、验收没过、或待确认项没解决，**停止归档**，把缺哪一步报给用户，不要移动文件。

## 操作

1. 在 PowerShell 中冻结一次时间戳并算出归档路径（后续步骤复用这两个变量，不要重新取时间）：

   ```powershell
   Set-Location 'D:\AICOP\ClassManagement'
   $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
   $dest = "step/archive/$stamp-widget-notify-calendar"
   if (Test-Path $dest) { $dest = "$dest-2" }
   Write-Output $dest
   ```

2. 修改 `step/00-index.md`：
   - “归档目录”填刚算出的 `$dest`；
   - “归档时间”填当前本地时间 `yyyy-MM-dd HH:mm`；
   - 步骤表里 step 7 的状态改为 `done`。
3. 在移动文件之前，把本文件头部的 `Status: pending` 改成 `Status: done`。文件马上会被移动，事后改不到。
4. 创建归档目录并移动本次计划文件：

   ```powershell
   Set-Location 'D:\AICOP\ClassManagement'
   New-Item -ItemType Directory -Force -Path $dest | Out-Null
   if (Test-Path 'step/00-index.md') { Move-Item -LiteralPath 'step/00-index.md' -Destination $dest -Force }
   Get-ChildItem -LiteralPath 'step' -Filter 'step-*.md' -File | ForEach-Object {
     Move-Item -LiteralPath $_.FullName -Destination $dest -Force
   }
   ```

   - 只移动 `step/` 顶层的 `step/00-index.md` 与 `step/step-*.md`；
   - 不要移动 `step/archive/` 下的任何历史目录；
   - 不要删除文件。

5. 在归档目录写 `step/archive/REPORT.md`，一行一条，至少包含：
   - 本次任务标识与完成时间；
   - step 1–6 各自的实际改动、验证命令与结果；
   - 最终测试数、check-plugin 结果、构建 zip 大小与 SHA-256；
   - 代码审查结论与遗留问题（没有就写“无”）；
   - 归档路径本身。

## 验收标准

- [ ] `Get-ChildItem 'D:\AICOP\ClassManagement\step' -Filter '*.md' -File` 无输出（顶层无残留计划文件）。
- [ ] 归档目录名匹配 `^<YYYYMMDD>-<HHMMSS>-widget-notify-calendar(-2)?$`，且 `step/00-index.md` 里的“归档目录”与实际路径完全一致。
- [ ] 归档目录内文件齐全：7 个 `step-*.md` + `00-index.md` + `REPORT.md`，共 9 个文件；原 `step-07-archive.md` 也在归档目录中。
- [ ] `step/archive/` 下此前已有的历史归档目录未被移动或删除。
- [ ] `step/00-index.md` 中“完成标准”满足，“归档时间”和“归档目录”已填写，step 7 状态为 `done`。
- [ ] 在回复中告知用户归档目录的绝对路径。

## 规则

- 归档目录名固定为 `step/archive/<YYYYMMDD-HHMMSS>-widget-notify-calendar/`；时间戳 8+6 位数字，slug 与 `00-index.md` 的“任务标识”逐字符相同。
- 已有同名目录只能追加 `-2`，绝不合并、绝不覆盖。
- 只移动，不删除；用户需要能回查完整提示词与执行记录。
- 不顺手清理用户自己的其他文件或 git 历史。

## 执行记录

（执行后填写：实际归档路径、文件数量、验证结果。）
