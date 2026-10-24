# Step 03 — v1.3.0 系统通知与定时提醒

- Task: widget-notify-calendar
- Step: 3 / 7
- Status: done
- Depends on: step 2
- Produces: v1.3.0 清单增加 `notifications` 权限与 5 个通知配置字段；`lib/notify.js` 实现每日简报、截止提醒、周一值日提醒；离线测试证明重复 tick 不重复通知
- Phase: 核心链路
- Writes: `class-management/manifest.json`、`class-management/main.js`、`class-management/lib/notify.js`、`class-management/lib/state.js`、`dev/test-plugin.mjs`、`README.md`、`class-management/README.md`
- Size: M
- Risk: 通知去重与本地时间边界最容易出错；必须用 `main.__test.setNow` 固定时钟测试，所有提醒默认关闭，避免升级后突然打扰
- Sources: `plugin-dev-kit/docs/02-guide.md` §3/§4.1（`ctx.notify` 与 `notifications` 权限，v0.5.2）；`plugin-dev-kit/docs/01-contract.md` §10（配置字段与存储，v0.5.2）；Aurora v0.5.2 Release（<https://github.com/LinePixel2025/Aurora-releases/releases/tag/v0.5.2>，访问 2026-10-24）

## 目标

在插件运行时增加可选的系统通知：每天固定时间发今日简报；截止前提醒今天要交的事务；每周一提醒本周值日组。所有提醒默认关闭，只在用户显式开启后生效，按天/周/任务去重，插件重启后不重复发。

## 输入

- `class-management/manifest.json`：当前无 `notifications` 权限，无通知配置字段。
- `class-management/main.js`：当前 `activate` 里只有 60 秒的 `tick` 定时器；`tick` 只在跨天/跨周时推送，不处理通知；`__test` 暴露 `setNow`/`resetNow`/`tick`。
- `class-management/lib/state.js`：`readSettings(config)` 解析 `className`/`teacher`/`termStartDate`/`showCompleted`；新增通知配置应放在这里统一净化。
- `lib/time.js` 已有 `todayKey()`、`nowTimeKey()`、`normalizeTime()`、`weekdayIndex()`、`weekKeyFromOffset()`；`lib/ops.js` 的 `loadWeek(ctx, 0)` 可读取今日事务与本周值日。
- `dev/test-plugin.mjs` 的 `createContext` 当前 `notify` 是 `async () => false`；需要改成记录通知并返回 `true`。
- 契约：`notifications` 权限允许 `ctx.notify({ title, body })`；配置字段类型支持 `text/number/boolean/select/textarea`，`number` 支持 `min/max/step/default`；插件存储单值 ≤ 256 KB。

## 操作

1. 修改 `class-management/manifest.json`：
   - `"version": "1.3.0"`；
   - `permissions` 增加 `"notifications"`；
   - `config.fields` 增加以下字段（顺序放在现有字段之后）：
     - `notifyDaily`：boolean，label `每日简报`，default `false`，description `每天在提醒时间发送今日事务与本周值日摘要`。
     - `notifyTime`：text，label `提醒时间`，default `07:30`，placeholder `07:30`，description `本地时间 HH:mm；每日简报与周一值日提醒使用`。
     - `notifyDue`：boolean，label `截止提醒`，default `false`，description `今天的事务在截止前提醒`。
     - `notifyDueLead`：number，label `提前分钟`，default `10`，min `0`，max `120`，step `5`，description `截止前多少分钟提醒`。
     - `notifyDuty`：boolean，label `周一值日提醒`，default `false`，description `每周一在提醒时间发送本周值日组`。
2. 修改 `class-management/lib/state.js` 的 `readSettings`：读取上述字段并净化：
   - `notifyDaily`/`notifyDue`/`notifyDuty` 用 `=== true`；
   - `notifyTime` 用 `normalizeTime(source.notifyTime) || '07:30'`；
   - `notifyDueLead` 用 `Number.isFinite(Number(source.notifyDueLead)) ? Math.min(120, Math.max(0, Math.trunc(Number(source.notifyDueLead)))) : 10`，不要把 0 当成缺省值。
3. 新增 `class-management/lib/notify.js`：
   - 常量 `NOTIFY_KEY = 'notify.v1'`；
   - `readNotifyState(ctx)` / `writeNotifyState(ctx, state)`：读取/写入 `{ dailyDate: '', dutyWeek: '', due: { [taskId]: 'YYYY-MM-DD' } }`，对非法字段做净化；
   - `timeToMinutes(value)`：`HH:mm` 转分钟；非法返回 `null`；
   - `checkNotifications(ctx)`：
     - 读取 `readSettings(ctx.config)` 与 `todayKey()`、`nowTimeKey()`、`weekdayIndex(new Date(nowMs()))`；
     - 三项都关闭时直接返回，不读 board、不写存储；
     - `notifyDaily`：`now >= notifyTime` 且 `state.dailyDate !== today` 时，`ops.loadWeek(ctx, 0)` 读取今日数据，`ctx.notify({ title: '今日班级事务', body: '待办 X 条 / 完成 Y 条；本周值日：第N组 · 成员' })`，成功后把 `state.dailyDate = today`；
     - `notifyDuty`：`weekday === 1`、`now >= notifyTime` 且 `state.dutyWeek !== weekKeyFromOffset(0)` 时，发送 `本周值日` 通知（组名/成员/备注），成功后记录 `state.dutyWeek`；
     - `notifyDue`：遍历 `data.tasks` 中未完成、`dueTime !== ''` 且 `dueDate` 为空或等于今天的任务，若 `now >= dueTime - notifyDueLead` 且 `state.due[task.id] !== today`，收集最多 3 条；发送一条 `事务即将截止` 摘要；对涉及的 taskId 记录 `today`；
     - 每次 checked 后清理 `state.due` 中不是今天的键；只有内容变化才写 `notify.v1`；
     - `ctx.notify` 返回 false 时记 `ctx.log('warn', ...)`，不抛错；通知已尝试即记录去重状态，避免每分钟重发；
     - 所有异常在 `main` 的定时器里捕获并记日志，不打断 tick。
4. 修改 `class-management/main.js`：
   - 引入 `checkNotifications`；
   - `activate` 里启动 60 秒定时器时，每次同时执行 `tick(ctx)` 与 `checkNotifications(ctx)`（两个独立 Promise，分别 catch 并记日志）；启动后立即执行一次 `checkNotifications(ctx)`，用于补发当天的提醒；
   - `__test` 增加 `checkNotifications: async (ctx) => checkNotifications(ctx)`；
   - 不修改 `tick` 的推送逻辑，通知与浮窗刷新解耦。
5. 修改 `dev/test-plugin.mjs`：
   - `createContext` 的 `notify` 改为把 `{ title, body }` 推入 `env.notifications` 并返回 `true`；在返回对象里暴露 `notifications`；
   - `config` 默认值加入 `notifyDaily:false`、`notifyTime:'07:30'`、`notifyDue:false`、`notifyDueLead:10`、`notifyDuty:false`；
   - 增加测试：全部关闭不发；每日简报只发一次；截止提醒只发一次；周一值日只发一次；非法 `notifyTime` 回退 07:30；两次连续调用不重复；
   - 测试时钟用 `main.__test.setNow(new Date(2026, 9, 21, 7, 31, 0, 0).getTime())` 等固定时间；
   - 更新最终测试计数并在 step 6 同步 README。
6. 更新根 `README.md` 与 `class-management/README.md`：权限列表加入 `notifications`；配置项说明加入 5 个通知字段；写明“默认全关、只在 Aurora 运行时提醒、无后台常驻”。

## 验收标准

- [ ] `node plugin-dev-kit/tools/check-plugin.mjs class-management` 退出码 0，清单包含 `notifications` 权限和 5 个配置字段。
- [ ] `node dev/test-plugin.mjs` 全绿；新增测试覆盖：关闭时不发、每日一次、截止一次、周一一次、非法时间回退、重复调用不重复、明天截止的任务不在今天提醒。
- [ ] `node -e "const m=require('./class-management/manifest.json'); const keys=['notifyDaily','notifyTime','notifyDue','notifyDueLead','notifyDuty']; const ok=m.version==='1.3.0'&&m.permissions.includes('notifications')&&keys.every(k=>m.config.fields.some(f=>f.key===k)); process.exit(ok?0:1)"` 退出码 0。
- [ ] `node dev/preview.mjs` 退出码 0（本步不改变 schema/页面，视觉不应变化）。
- [ ] `node -e "const s=require('./class-management/lib/state.js'); const r=s.readSettings({notifyTime:'25:99',notifyDueLead:999,notifyDaily:true}); const z=s.readSettings({notifyDueLead:0}); process.exit(r.notifyTime==='07:30'&&r.notifyDueLead===120&&r.notifyDaily===true&&z.notifyDueLead===0?0:1)"` 退出码 0。
- [ ] `Select-String -Path README.md,class-management/README.md -Pattern 'notifications|每日简报|截止提醒|周一值日'` 至少各命中一次。
- [ ] `git diff --check` 无空白错误。

## 交接

- 通知引擎独立于 board/schema；后续 step 4/5 的页面周历不需要再改通知代码，但 `pushPanel` 目标增加后要确认通知引擎不依赖 panelEvent。
- 通知配置字段与 `notify.v1` 存储键固定为上述名称，step 6 的 README 直接使用。
- 通知仅限插件运行期；README 不得写成“系统级后台提醒”。

## 执行记录

- 实际改动（提交 `c29e651`，7 个文件，+507/-18）：
  - `class-management/lib/notify.js`（新增 208 行）：`NOTIFY_KEY='notify.v1'`、`readNotifyState`/`writeNotifyState`（净化非法字段、`__proto__` 拒收）、`timeToMinutes`、`checkNotifications`（三项全关直接返回、不读 board/不写存储；每日简报 / 周一值日 / 截止提醒；`notify.v1` 去重；每次只清理非今天键、仅内容变化才写盘；`ctx.notify` 返回 false 或抛错均只记 warn、不打断且记录“已尝试”）。
  - `class-management/manifest.json`：version 1.3.0、`permissions` 增加 `notifications`、`config.fields` 追加 5 个通知字段（默认全关 / `07:30` / 10 分钟 / 0–120）。
  - `class-management/lib/state.js`：`readSettings` 增加 5 个通知字段的读取与净化（`notifyTime` 非法回退 07:30；`notifyDueLead` 截断 0–120、0 合法）。
  - `class-management/main.js`：引入 `checkNotifications`；60 秒定时器内 `tick` 与 `checkNotifications` 各自独立 catch；激活后立即补发一次；`__test.checkNotifications` 暴露给测试。
  - `dev/test-plugin.mjs`：mock `notify` 记录通知并支持返回 false；清单断言更新（1.3.0 / notifications / 9 个配置字段）；新增「通知与定时提醒」12 条测试（全关不发不写、每日/截止/周一各一次、`notifyDueLead=0` 边界、多任务合并、非法配置回退、明天截止不提醒、notify false 记 warn、重启不重复、activate 补发不重复）。
  - `README.md` / `class-management/README.md`：权限列表加 `notifications`；新增「系统通知（可选）」小节（三类行为、5 字段默认值、`notify.v1` 去重、仅 Aurora 运行时生效/不常驻后台/不联网）；插件 README 版本 1.3.0、目录补 `lib/notify.js`；验证段测试数 71/71、宿主校验器 0.5.2。
- 子代理分片与结果（4 个并行分片，写范围互不重叠）：
  - A `lib/notify.js`：完成；自测 10/10（全关不读不写、三类通知各一次、notify false/抛错不重复、lead=0 边界）。
  - B `manifest.json` + `lib/state.js` + `main.js`：完成；check-plugin v1.3.0、宿主原版 zod 清单解析通过。
  - C `dev/test-plugin.mjs` 测试：完成；新增 12 条通知测试，最终 71/71。
  - D 两份 README：完成；通知板块与权限/字段说明补齐；主代理把分片按旧计数写的 69/69 修正为实测 71/71。
- 验证命令与结果（主代理实跑）：
  - `node plugin-dev-kit/tools/check-plugin.mjs class-management` → 退出码 0，`✓ 清单通过：…v1.3.0`；
  - `node dev/test-plugin.mjs` → **71/71** 通过（原 59 + 通知 12；含宿主原版 zod 清单解析）；
  - `node dev/preview.mjs` → 退出码 0，11 张 PNG 全部生成（schema 未变，视觉应与 v1.2.0 一致）；
  - 清单断言（1.3.0 / notifications / 5 个 key）→ 退出码 0；`readSettings` 回退/截断断言 → 退出码 0；`node --check notify.js` → 通过；
  - `Select-String -Path README.md,class-management/README.md -Pattern 'notifications|每日简报|截止提醒|周一值日'` → 两文件分别 8 / 7 处命中；
  - `git diff --check` → 无输出。
- 执行中确认的实现口径（审查/后续步骤可参考）：`ctx.notify` 抛错也记“已尝试”（当天不重试）；截止提醒摘要顺序跟随 `loadWeek`（到期日今天优先、再按时间）而非严格 `dueTime` 升序；`timeToMinutes` 与 `normalizeTime` 同口径（接受 `7:05`）。均符合计划，不构成阻塞。
- 遗留问题：真机验收（开启通知后在 Aurora 运行期收到每日简报/截止提醒/周一提醒、关闭后不打扰）需用户在真机确认；离线测试已覆盖去重与开关行为。
