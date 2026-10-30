# 洛希桥（50 追加层）

给 DSH 侧插件用的本机 WebSocket 接口：**会话里发 `/dsh <任务>` 时交给 DSH，其他消息照旧由 宿主 处理。**
没有改出厂文件，删掉本目录或把 `composition.json` 的 `enabled` 改成 `false` 再重启即恢复原样。

## 它做什么

- `core.ingest` 包装：消息入库后先过桥；命中 `/dsh` 命令或该会话处于粘性模式 → 返回 `accepted:false`，
  宿主 的唤醒/LLM 整条链路跳过（这是“同一时刻只有一个主脑”的关键）
- `core.send` 包装：拿到真正的发送队列，插件的回话走同一条管线（限频、存档、防刷屏）
- 本机 WS 服务（默认 `127.0.0.1:3311`），token 在 `data/bridge/token`
- 状态文件 `data/bridge/state.json` 记粘性会话；配置 `data/bridge/config.json` 记端口/命令前缀/放行名单
- **自动拉起插件**：桥监听成功后 spawn `luoxi-plugin-dsh`（node + 随包 dsh），崩了退避重启（最多 5 次），随应用退出一起收
- **审批**：插件要跑危险工具时发 `approval.request`，桥在 会话里发「1. 允许 / 2. 拒绝」，用户回数字即决策，120 秒超时拒绝
- **图片**：`action.sendMedia` 走现有图片管线；入站图片放进 `event.message.images`

## 命令

| 命令 | 行为 |
|---|---|
| `/dsh <任务>` | 一次性交给插件 |
| `/dsh on` / `off` | 粘性接管 / 交回 |
| `/dsh new` / `stop` | 转发给插件 |
| `/dsh status` / `help` | 状态 / 帮助 |

放行默认只允许私聊，群里要在 `allow.chats` 里加 `group:<群号>`。
不在名单里的命令会被吞掉且不回复（避免群友借机器人跑 DSH）。

## 接口

`GET /api/luoxi/status`、`GET /api/luoxi/token`、
`POST /api/luoxi/config`（`enabled` / `ack` / `command` / `allow`）、
`POST /api/luoxi/mode`（`{chatKey, mode}`）。

协议细节见 [`docs/protocol.md`](../../docs/protocol.md)。

## 配置项

```json
{ "enabled": true, "port": 3311, "command": "/dsh", "ack": true,
  "autoStart": true, "workspace": "", "approvalTimeoutMs": 120000,
  "allow": { "chats": [], "users": [] } }
```

`workspace` 为空时用 `data/dsh-workspace`；`autoStart` 关掉就只提供桥、不拉插件。

## 自检

```bash
node overrides/50-luoxi-bridge/selftest.mjs     # 只测协议与命令路由（假发送队列）
node overrides/50-luoxi-bridge/integration.mjs  # 真内核 + 假 OneBot + 假插件，端到端
```

`integration.mjs` 会验证：`/dsh` 被 ingest 拦下、没插件时回提示、插件 hello 通过、
任务转给插件、插件 `action.send` 回到 会话（经真发送队列）。

## 边界

- 文本、审批、图片（外发）已实现；历史查询和大文件外发还没做
- 插件不在时命令会回“DSH 未连接”，不会退回给 宿主（避免两套逻辑打架）
- 桥只监听回环，token 不落日志；插件拿不到 OneBot 和 console token
