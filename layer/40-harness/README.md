# 内置 DeepSeek Harness（0.5 追加层）

把 DeepSeek 官方的 `dsh`（DeepSeek Harness）接进 0.5 控制台，作为侧边栏一页「DeepSeek」（排在「应用日志」前）。
**没有改 0.5 的任何出厂文件**：整层由「可信启动组合」加载，删掉本目录（或把
`composition.json` 的 `enabled` 改成 `false`）再完整重启，一切恢复原样。

## 装了什么

```
runtime/dsh/
  node/node.exe        纯净的 Node.js 24.22.2（只有 node.exe + LICENSE）
  npm/                 内置 npm 10.9.7（MIT，自带 68 个依赖），只在首次装依赖时用一次
  pnpm/                内置 pnpm 10.34.9（MIT，JS 版），只在 dsh plugin 装插件时用一次
  bin/pnpm.cmd         垫片：让 dsh plugin 用随包 pnpm，而不是用户机器上碰巧装的版本
  package.json         只声明 "@deepseek-ai/dsh": "0.2.1-rc.5"
  package-lock.json    依赖树 + 完整性哈希，首次安装按它做 npm ci
  node_modules/        **首次点击启动时才生成**，随包发布时是空的
  THIRD_PARTY_*        许可证清单
```

`node.exe` 只在这个目录里被调用，不改系统环境变量；`runtime/` 在 `.gitignore` 里，不入库。
`data/dsh-home/` 是 dsh 自己的 DSH_HOME（profile、会话、设置都在里面），`data/dsh/dsh.log` 是启停日志。

## 首次启动会做什么

点「安装并启动」走 `POST /api/dsh/start`，状态机是 `installing → starting → ready`：

1. **没有依赖**（`node_modules/@deepseek-ai/dsh` 不存在）时先装依赖：
   - 检查磁盘（需要约 1.6GB 空闲）
   - `runtime/dsh/node/node.exe runtime/dsh/npm/bin/npm-cli.js ci --omit=dev --ignore-scripts`
   - 先走 `registry.npmmirror.com`，失败自动换 `registry.npmjs.org` 重试一次
   - 关闭第三方安装脚本（`--ignore-scripts`），完整性由 `package-lock.json` 的 sha512 保证
   - 实测：616 个包、约 1 分 25 秒、820MB；中途断网会重来，`npm ci` 每次先清空再装，不会留半残
2. 装完立刻启动 `dsh web --no-open --port <3080 起找空闲>`
3. 从 stdout 抓 `dsh web: http://127.0.0.1:<port>/?token=...`（裸地址 401），
   **单独开一个 Electron 窗口**加载这条带令牌地址；令牌只存在内存里，日志落盘前就打成 `token=***`
4. 之后每次点启动都是秒开；窗口关掉只是关界面，dsh 还在跑

「停止」会连安装进程一起取消（安装中也能停），并 `taskkill /T /F` 收掉 dsh 进程树。
控制台/应用退出时 `http.onDispose` 会带走 dsh 和它的窗口，不留孤儿。

## 面板

`GET /api/dsh/status` 返回 `phase`（`stopped|installing|starting|ready|error`）、
`runtimeReady`（node/npm/lock 在不在）、`depsInstalled`、`installing`、`installStep`、
`installElapsedMs`、`diskFreeBytes`、`windowOpen`、`tail` 等。面板据此显示进度、禁用按钮、
出错时给重试（再点一次启动即可）。

## 文件分工

- `lib/dsh-runtime.mjs`：状态机、依赖安装、启停、端口、日志、`NODE_SHA256` 指纹校验
- `lib/dsh-window.mjs`：Electron 窗口（`sandbox: true`、无 preload、站外链接走系统浏览器）；
  发布版默认关 devtools，排查时 `LUOXI_DSH_DEVTOOLS=1`
- `routes.mjs`：`GET /api/dsh/status`、`POST /api/dsh/start|stop|open`
- `ui/dsh/`：面板（进度、日志、重试）
- `selftest.mjs`：不带界面跑一遍「装依赖 → 启动 → ready → 停止」

## 命令行等价物

根目录 `打开DeepSeekHarness.bat` 不经过 宿主，直接前台跑 dsh（前提是依赖已装好）。
排查看 `data/dsh/dsh.log`；组合是否被识别用 `node scripts/inspect-composition.mjs`。

## 清理与卸载

- **只想回收空间**：删掉 `runtime/dsh/node_modules`（820MB）即可，下次点启动会重新装。
  `data/dsh-home` 不动，DSH 的会话和设置还在。
- **想重置 DSH**：删 `data/dsh-home`（会话、设置、登录态都在这里），下次启动重新初始化。
- **卸载 宿主**：`runtime/` 和 `data/` 都在安装目录/数据目录里，跟着删即可；
  安装包的 `deleteAppDataOnUninstall: false` 会保留 `data/`，这是有意的（避免误删聊天记录），
  需要一并清掉时手动删 `data/dsh-home` 与 `data/dsh`。

## 升级

Node / npm / dsh 各自的换法见 [`UPGRADE.md`](UPGRADE.md)；换完必须重跑
`node scripts/collect-licenses.mjs` 和 `node scripts/pack-portable.mjs`。

## 边界

- 只管启停，不代管模型凭据：DeepSeek 的 token / 工作目录都在 dsh 自己的界面里配。
  DSH 的对话会发到 DeepSeek 的服务器，面板上已写明。
- 没有把 DSH 塞进控制台面板 iframe：面板沙箱只有 `allow-scripts`，跨源页面进去会丢 origin，
  localStorage/接口全废，所以单独开窗。
- 便携包只带 `node` + `npm` + dsh 本体，**不带 dsh 依赖**（MPL/LGPL 组件由用户从 npm 拉取，
  不由我们再分发）；如果要打全量包，许可义务见仓库根 `THIRD_PARTY_NOTICES.md`。
