# dsh-job-badge — 后台任务提示图标

给 DSH 加一个"后台任务"提示图标：右下角一个小胶囊，**在跑时显示转圈+数量**，**有任务刚结束时变成 `✓ 1` 并跳动、同时响一声、标签页标题前面挂上 `(1)`**；点一下打开任务面板（进行中/已结束、耗时、退出详情），并清掉未读计数。

[English](README.md) | 中文

这就是 Codex 那个"后台图标挂个 1"的对应物，补上 DSH 目前完全缺失的那一环：任务在后台跑完，模型收到了完成通知，**人什么都没有**。

| 2 个在跑 + 1 个刚结束 | 点开面板 |
|---|---|
| ![图标](docs/badge-preview.png) | ![面板](docs/badge-panel.png) |

想立刻看到（不需要重启 DSH）：

```powershell
node test/preview.mjs      # 打开它打印的 http://127.0.0.1:8799/
```

上面两张图就是这么来的：预览服务端的是**真正的 `notice.js`**，只有数据是循环演示的（`?pose=unread` / `?pose=busy` 可以冻结成固定姿势）。

```
        ┌─────────────── 点击 ───────────────┐
   ◌ 2  │  后台任务            全部已读  ×  │   运行中：转圈 + 数量
   ✓ 1  │  进行中 · 2                        │   有完成：✓ + 未读数（绿色、跳动）
        │  ◌ npm run build  运行中 · 1m20s    │   都空时：整体从页面上消失
        │  ◌ research…      运行中 · 0m12s    │
        │  已结束 · 1                        │
        │  ✓ pwsh 跑测试 已完成 · 1m05s exit 0│
        │  🔔 提示音：开      刚刚完成        │
        └────────────────────────────────────┘
```

---

## 1. 它解决什么问题（以及不解决什么）

| | 之前 | 现在 |
|---|---|---|
| 后台任务在跑 | 没有任何界面提示（要展开会话头部的任务列表才知道） | 右下角 `◌ N`，一眼可见 |
| 后台任务完成 | 没有提示、没有声音、没有标记 | `✓ N` + 跳动 + 提示音 + 标题 `(N)` |
| 你在别的会话/别的窗口 | 完全不知道 | 图标跨越所有会话，全局计数 |

**只统计"后台任务"**（`ctx.jobs` 注册表：`run_in_background` 的 shell、后台 subagent）。前台命令跑完不会点亮图标——那是你正盯着的输出，不是后台任务。会话/回合结束的提示不在本插件范围内（可作为后续扩展，见第 7 节）。

判据是 `settled` 事件里的 **`awaited`**：前台 shell 工具自己 `registry.wait(id, …)` 等结果、收完再 `registry.remove(id)`，所以它的结算事件带 `awaited: true`；注册表发布这个字段的用途原文就写在文档里——"让完成播报者跳过已被等待方收走的结算"。**早先没看这个字段时，每一个工具调用结束都会"滴"一声**（前台结算 → 瞬时未读 → 页面响铃 → 紧跟着被 remove 掉），这是实测撞出来的 bug；现在两个方向都有测试钉住：`awaited: true` 不上报，`awaited: false` 或缺省照常上报。

**"在跑"计数也不会被前台调用闪到了**，但用的是另一套办法——因为**注册时**注册表根本没有前台/后台标志：shell 工具的后台路径和"前台但可提升"路径调用的是同一个 `startJob`、同一份 spec（读源码确认）。所以新任务要先活过 `graceMs`（默认 2 秒）才计入"在跑"：工具调用活不到，真后台任务活得久。例外是**报过 progress 的任务立即放行**——shell 工具从不上报 progress，所以这条捷径不会把前台调用放回来。提升定时器只在真有任务在等的时候存在，空闲宿主不会被每几百毫秒叫醒一次。

## 2. 交互设计

**图标状态**（`shell.overlay` 层里的固定胶囊，位置可配置）

| 状态 | 样子 | 何时出现 |
|---|---|---|
| 空闲 | 完全不渲染任何元素 | 没有在跑的、也没有未读 |
| 在跑 | `◌ 2`（真 spinner，不是旋转字符） | `counts.running > 0` |
| 刚结束 | `✓ 1`，绿色描边 + 一次光晕脉冲 | 未读数 > 0 |
| 两者都有 | `◌ 2 · ✓ 1` | 都成立 |

**"已读"的语义**：点一下图标 = 你看过了 → 打开面板并清掉未读计数。计数是**宿主状态**，所以两个窗口不会各说各话。

**声音**：一次结算一声两音提示（成功上行 880→1319Hz，失败/取消下行 660→440Hz），用 WebAudio 现场合成，不带音频资源；2500ms 内的连续结算**只响一次**，避免批量任务收尾时连环响。刷新页面不会为"旧闻"补响（只有 `finishedAt` 晚于本次页面加载的结算才会响）。面板底部有 `🔔 提示音：开/关` 开关，选择存在 localStorage。

**标题计数**：未读 > 0 时 `document.title` 前缀 `(N) `，清空后恢复原样——窗口在后台但可见时，任务栏/标签页标题也能提示。

**最小化时怎么办**：页面里的图标最小化时看不见，所以结算还会走两条不需要盯着窗口的路：**① 提示音**（WebAudio 现场合成，成功上行双音、失败/取消下行双音；Electron 默认允许无交互播放——实测窗口最小化时能听到）；**② 任务栏角标**（`navigator.setAppBadge(未读数)`，图标上那个数字）。

**系统通知横幅是可选项、默认关闭**（`notify: never`）。实测依据：这台机器 `HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\PushNotifications\ToastEnabled = 0`（Windows「通知」总开关关着），此时**任何应用都不会显示横幅**——包括我直接用 PowerShell 身份发的那条 toast（命令成功、屏幕无反应）。所以默认不去依赖它；在系统通知确实可用的机器上，把 `notify` 设为 `hidden`（只在窗口不可见时弹）或 `always` 即可。相关代码：`notify()` 只在**第一次真实交互后**才 `requestPermission()`，且任何失败都静默降级，不会连累图标。

**面板**：进行中一行一条（类型、状态、实时耗时每秒刷新、progress 行），已结束一行一条（状态、耗时、`exit 0` 之类 detail），最近 30 分钟、最多 40 条。Esc 或点击面板外关闭。

## 3. 实现

```
dsh-job-badge/
  index.js            宿主半边：订阅全局 job 事件、维护计数、四条约路由、注入一行 loader
  notice.js           页面半边：纯 DOM + 轮询 + SSE，画出图标与面板（无构建步骤、无 JSX）
  cordis.patch.yml    bundle patch：把插件插进 profile
  test/               tracker-test.mjs（宿主，159 条断言）、notice-render.mjs（真浏览器，50 条）
  test/verify-live.mjs 装好之后的健康检查（安装副本是否最新 + 路由是否在跑）
```

**数据流**

```
ctx.jobs.events.subscribe({owners:'all'})     ← 进程内所有 job 的生命周期（含别会话的）
        │ registered / progress / stopping / settled / removed
        ▼
   createTracker()   ← 纯逻辑：谁在跑、谁未读、什么时候丢行（全部可单测）
        ▼
   GET /job-badge/state-<载入戳>.json    快照（轮询用，也是 curl 调试用）
   GET /job-badge/stream-<载入戳>        SSE：每次变化推一帧（加速器，不是唯一通道）
   POST /job-badge/ack-<载入戳>.json     清未读
   GET /job-badge/ui-<载入戳>.js         notice.js 本体
        ▼
   注入到 index.html 的一行 <script>（标签上带三条路由地址）
        ▼
   notice.js：先 poll 一次画出首帧 → 每 2.5s 轮询保底 → SSE 到达即时更新
```

**为什么宿主半边持有状态**：`jobs` 是进程级注册表，只有宿主能看到"所有会话"的任务；页面只能看到当前会话。而"后台任务"的意义就是你没在看它——所以计数必须由宿主算，页面只负责画。

**为什么页面半边是"注入一行 script"而不是 `dsh.client`**：`dsh.client` 的客户端模块要靠**启动时构建的模块图**，往运行中的宿主里装包，`/plugins/<id>/client.js` 会 404 直到重启。注入 script 只需要页面能取到这个地址——具体到本项目，桌面壳的取数方式见第 5 节。

**为什么每条路由都带"载入戳"**：戳是 `index.js` 自己的 mtime。重装时新实例注册同一路径会抛 `webserver: duplicate undefined route`，而那个错误不只是让新实例激活失败——它会把旧实例变成加载器管不到的孤儿（还是 session-watch 踩过的坑）。带戳 = 新一代就是一批新路径；同一代重复 apply 则发现戳已挂载，什么都不做（不重复注册、不叠第二个定时器、不重复注入）。

**为什么轮询是保底而不是 SSE**：桌面壳用自定义 scheme + 转发把页面请求送到宿主（`dsh-app://app` → `forwardWebRequest` → 带 cookie 的真实 HTTP）。SSE 在这条链路上**没有实测过**，而轮询是任何中间层都破坏不了的路径。所以默认 2.5s 轮询**永远在跑**，SSE 只是让提示更即时。宁可多一次本地 JSON 读，也不要"通知晚到一分钟"。

**安全**：job 的 label 来自工具输入，也就是模型写的文本。它在页面里只经 `textContent` 落地，`notice.js` **全文没有 innerHTML**；浏览器测试里专门用 `<img src=x onerror=…>` 和 `<script>` 当 label 验证过"只显示文本、不生成元素、不执行"。

## 4. 配置

`~/.dsh/profiles/desktop/cordis.patch.yml` 或本 bundle 的 `cordis.patch.yml`：

```yaml
- id: job-badge
  name: '@local/dsh-job-badge'
  config:
    position: bottom-right   # bottom-right | bottom-left | top-right | top-left
    sound: always            # always | hidden（只在页面不可见时响）| never
    notify: never            # always | hidden（只在页面不可见时弹）| never（默认关，见下）
    volume: 0.35             # 0 .. 1
    keepMinutes: 30          # 已结束任务在列表里留多久
    maxRows: 40              # 已结束行的硬上限
    graceMs: 2000            # 新任务要先活这么久才算在跑（0 = 立刻）
    stream: true             # false = 关掉 SSE，只留轮询
```

## 5. 安装与"什么时候能看到"（重要）

```powershell
# 安装（宿主半边立刻生效；界面半边要等应用重启，原因见下）
plugin_manager install_bundle  target: file:<本仓库路径>
```

**⚠️ 桌面壳（DeepSeek Harness.exe）必须重启一次，界面才会出现。** 不是"刷新页面就行"——这是实测 + 读源码得出的：

1. 宿主在启动时把索引注入表交给 Electron 主进程：`process.send({ type:'ready', url, injections: ctx.webServer.collectIndexInjections() })`。
2. 主进程把它存下来（`injections = ready.injections`），页面每次启动通过 IPC `boot` 拿到的都是**这一份启动快照**。
3. 所以**刷新页面也只是重新应用同一份旧表**；装了新插件后，注入行不在表里，图标不会出现。
4. 而且这个生产构建的菜单里**没有**"刷新页面/重启宿主"——Electron 主进程只在 `development` 时加 `role:"reload"` 与"重启应用宿主"两项（`...development ? [...] : []`）。按 Ctrl+R / F5 没有反应，就是因为它根本没绑。

对比：浏览器版 `dsh web` 走 `frontend-static`，索引是**每个请求现渲染**（`body = await renderIndex()`），所以那条路上刷新页面就够了。桌面壳不行。

**"装一次，重启一次，之后一直有效"**：重启后宿主重新读 `index.js`（新 mtime → 新一批路由），索引注入表里就有这一行，页面加载时 `notice.js` 自动挂上。之后改代码/改配置只需重启应用。

**⚠️ 另一个实测坑：`file:` 依赖是硬链接，但"写文件"会打断它。** 安装后我改了仓库里的 `index.js`/`notice.js`，profile 里那份**没有**跟着变（`verify-live.mjs` 报 `DIFFERS`）——编辑器/工具通常是"写新文件再替换"，硬链接随之断开。**而且重复 `install_bundle` 会说 "Already up to date" 而什么都不做**（实测：pnpm 认为依赖没变）。所以改完源码要这样同步：

```powershell
# 1) 摘掉再装回来，强制重新拷贝（install_bundle 单独跑是不够的）
plugin_manager remove_bundle  target: @local/dsh-job-badge
plugin_manager install_bundle target: file:<本仓库路径>
# 2) 确认两边字节一致，并看当前哪一代路由在服务
node test/verify-live.mjs
```

`verify-live.mjs` 的第二种输出值得认识：改完源码后它会说 **PARTIAL**——因为 Node 按 URL 缓存 ES 模块，正在跑的宿主仍然在服务**它第一次 import 的那一代**（路由戳是那时算出来的）。这不是坏，是"要重启才换代码"的另一种说法。

## 6. 验证

```powershell
node test/tracker-test.mjs     # 宿主半边：159 条断言（纯逻辑 + 假 Host 的路由/订阅/注入/清理）
node test/notice-render.mjs    # 真浏览器（无头 Edge + CDP）：50 条断言
node test/verify-live.mjs      # 对着正在跑的宿主：安装副本是否最新、四条路由是否在服务
```

`notice-render.mjs` 不是"源码里有这个字符串"式的检查：它起一个本地 HTTP 服务扮演宿主（state/SSE/ack 三条路由），把真正的 `notice.js` 加载进无头 Edge，然后读**活 DOM** 断言：空闲时页面上没有元素、2 个任务时显示 `2` 且在转、推一帧"一个完成"后立刻变成绿色 `✓ 1` 且标题变 `(1) dsh`、点击后打开面板并 POST 了 ack、Esc 关闭、全部清空后元素自己移除、恶意 label 不生成元素也不执行。其中两例用的是**真 `apply()` 生成的注入行**：一例按解析方式注入，一例按桌面壳的方式（`createElement('script')` + `textContent` + `append`）注入——这样"注入行本身能不能挂上图标"也被钉住了。

实测数据（本轮真实跑过，不是推断）：

| 检查 | 结果 |
|---|---|
| `GET /job-badge/state-<戳>.json` | 200，返回真实计数 |
| 起一个后台任务 `pwsh-167`（30s） | 运行期间 `running` 里能看到它 |
| 它结束后 | `settled` 里 `status=completed`、`duration=30.5s`、`detail=exit code: 0`、`unseen=1` |
| 期间十几次前台 `pwsh` 调用 | **没有**污染未读计数（结算即被 remove） |

（重启后：标题旁边出现 `(1)`，右下角出现 `✓ 1` 胶囊；点开是上面那张面板。）

## 7. 已知边界（不当成 bug）

- **未读计数是宿主内存态**：重启应用后归零，历史任务仍在面板里（`seed()` 会把已存在的已结束任务当"历史"而不是"未读"——没人盯着的时候不存在"你错过了"）。
- **`cause: 'teardown'` 的结算不点亮图标**：那是宿主/会话正在销毁、已经没有读者了，不值得响一声。
- **前台 shell 调用不通知**（它自己 `remove` 掉了），所以你要的"提示"只对应真正的后台任务。
- **标题前缀会剥掉别人的 `(N) ` 前缀**：极小概率误伤，换来的是自愈（应用改标题后我们下一帧重新加前缀）。
- **页面隐藏时**浏览器可能把定时器降频（Chromium 对隐藏页有 intensive throttling）。SSE 到达时仍会即时处理；SSE 万一不通，最坏情况是提示音晚到。这是轮询 + SSE 双通道的原因。
- **多窗口**：计数与已读是宿主状态，两个窗口一致；但按钮的"跳动/提示音"是各自的（各自页面加载之后的新结算才响）。
- **不在范围内**：回合/会话结束的提示（可用 `api-session/status` 或 `agent/status` 加同样一条通路扩展）、原生的 Windows 通知（需要 Notification 权限，默认不做）。
- **本机验证边界**：`docs/*.png` 是**真浏览器里真正画出来的**（无头 Edge 加载真 `notice.js`，截图取自 `test/preview.mjs` 的服务），注入行也按桌面壳的方式验证过。仍然没被证明的只有一件事：**桌面壳窗口里那一刻的画面**——它要等应用重启，而重启会终止当前会话，所以这一帧只能由你在重启后自己确认（或先看 `preview.mjs`，那是同一份 `notice.js`）。
