# luoxi-plugin-dsh

把 会话消息桥接到 **DeepSeek Harness**：宿主（agent 框架） 收到 `/dsh <任务>` 后交给它，它用 `dsh acp` 起会话、
跑任务，再把回答送回 会话。

> 名字里的 `luoxi` 是项目代号，插件本身只跟 [洛希桥协议](../../docs/luoxi-bridge-protocol.md) 说话，
> 不绑定具体机器人实现。

## 它做什么 / 不做什么

- **做**：连 宿主（agent 框架） 的本机桥（WebSocket + token）、按会话建 DSH 会话、把任务丢给 ACP、收集回答、发回 会话
- **不做**：不连 OneBot、不判断该不该回、不做限频和存档——这些永远在 宿主（agent 框架） 那边
- 所以同一时刻只有一个“主脑”：普通聊天是 宿主（agent 框架），`/dsh` 或粘性会话才轮到 DSH

## 运行要求

- Node.js 20+（便携包里是 `runtime/dsh/node/node.exe`）
- DeepSeek Harness 已安装（本仓库在 `runtime/dsh/node_modules/@deepseek-ai/dsh`）
- 宿主（agent 框架） 的「DeepSeek → 洛希通道」能看到“监听中”，并能复制 token

## 启动

```bash
node bin/luoxi.mjs \
  --bridge ws://127.0.0.1:3311 \
  --token  <在面板里复制的 token> \
  --workspace D:\work\demo \
  --dsh  <...>/runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js \
  --node <...>/runtime/dsh/node/node.exe \
  --dsh-home <...>/data/dsh-home
```

参数也支持环境变量：`LUOXI_BRIDGE_URL`、`LUOXI_BRIDGE_TOKEN`、`LUOXI_WORKSPACE`、
`LUOXI_DSH_BIN`、`LUOXI_NODE`、`LUOXI_DSH_HOME`、`LUOXI_PERMISSION`。

| 参数 | 默认 | 说明 |
|---|---|---|
| `--bridge` | `ws://127.0.0.1:3311` | 宿主（agent 框架） 桥地址 |
| `--token` | 无（必填） | 桥 token，面板「显示 token」复制 |
| `--workspace` | 当前目录 | DSH 会话的工作区（每个 会话 会话共用一个） |
| `--dsh` | 无（必填） | `dsh` 的 `lib/bin.js` 路径 |
| `--node` | 当前 node | 跑 dsh 的 node（便携包里用自带的） |
| `--dsh-home` | `~/.dsh` | DSH profile 目录；用便携包时指向 `data/dsh-home` |
| `--permission` | `ask` | `ask` 转给 会话 让用户回数字、`allow` 自动允许、`deny` 全拒 |
| `--check` | - | 只连桥做握手，成功就退出（排查用） |

## 行为

- 一个 ACP 进程，每个 会话 会话一个 DSH session（`session/new`）
- 同一会话串行；不同会话互不阻塞
- `/dsh new` → 丢掉旧 session，下条消息重新建
- `/dsh stop` → 发 `session/cancel`
- 危险工具：ACP 的 `session/request_permission` 转成 会话里的「1. 允许 / 2. 拒绝」，用户回数字后继续
- 每轮结束把 ACP 的 `usage_update`（上下文用量）报给 宿主（agent 框架），面板能看到
- 回答按一次 `action.send` 发回；超长由 宿主（agent 框架） 切分
- 断线自动重连（1s 起，指数退避到 30s）

## 随 宿主（agent 框架） 自动启动

宿主（agent 框架） 的桥在监听成功后会自己拉起这个插件（`autoStart: true`），退出时一起收掉；
手动跑只用于调试或独立部署。

## 安全

- 桥只监听 `127.0.0.1`，token 泄露面仅限“往白名单会话发消息”
- `--permission deny` 可以把 DSH 的工具调用全部拒掉（只读模式）
- 插件不读 宿主的登录态和聊天存档

## 开发

```bash
node test/e2e.mjs
```

会起一个假 洛希桥 + 真 `dsh acp`，发一句“只回复 ok 两个字母”，断言 `action.send` 回来的是 `ok`。

## 许可

MIT，见 [LICENSE](LICENSE)。
