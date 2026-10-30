# 洛希桥协议 v1

宿主（agent 框架） 在本机开一个 WebSocket，给 DSH 侧的 `luoxi-plugin-dsh` 提供“收发 会话消息”的最小接口。
**谁接消息、谁回消息永远由 宿主（agent 框架） 决定**，插件只是被 `/dsh` 唤起时的执行端。

- 地址：`ws://127.0.0.1:<port>`，默认端口 `3311`，只监听回环
- 认证：连接后第一帧必须是 `hello`，带 `data/bridge/token` 里的 token
- 编码：UTF-8 JSON 文本帧，一帧一条消息
- 版本：`protocol: 1`，只增不改；不兼容就拒绝连接

## 握手

```json
// 插件 → 宿主（agent 框架）
{ "type": "hello", "token": "<token>", "protocol": 1,
  "plugin": { "name": "luoxi-plugin-dsh", "version": "0.1.0" } }

// 宿主（agent 框架） → 插件
{ "type": "hello.ok", "protocol": 1, "commands": { "prefix": "/dsh" },
  "bot": { "name": "luoxi-host" } }
```

失败会先回 `{"type":"error","code":"auth|protocol","message":"..."}` 再关连接。
10 秒内没有 `hello` 直接断开；新连接会顶掉旧连接（旧连接收到 4000）。

## 事件（宿主（agent 框架） → 插件）

```json
{ "type": "event.message", "seq": 12,
  "chat":   { "key": "private:10001", "type": "private" },
  "sender": { "id": "10001", "name": "小明" },
  "text": "帮我把这个项目跑一下测试",
  "mode": "oneshot",          // oneshot | sticky
  "at": 1793368340000 }

{ "type": "event.command", "seq": 13,
  "chat": { "key": "private:10001" },
  "command": "new" }          // new | stop
```

`event.message` 只在两种情况下发：以 `/dsh` 开头的命令，或该会话处于粘性模式（`/dsh on`）。
其余消息根本不会到达插件——宿主（agent 框架） 自己处理。

## 动作（插件 → 宿主（agent 框架））

```json
{ "type": "action.send", "id": "a1", "chatKey": "private:10001", "text": "跑完了，3 个用例失败" }
{ "type": "result", "id": "a1", "ok": true }
```

- 发送走 宿主（agent 框架） 的发送队列：限频、存档、防刷屏都照旧
- 只能发到放行名单里的会话（默认只有私聊；群要显式加白）
- 文本会被按宿主的硬上限切分

```json
{ "type": "usage.report", "chatKey": "private:10001", "sessionId": "s-1",
  "inputTokens": 1234, "outputTokens": 456,
  "contextUsed": 6314, "contextSize": 1000000 }
```

上下文用量来自 ACP 的 `usage_update`；插件拿不到精确计费 token 时，这两个字段是 0。

## 审批（危险工具）

```json
// 插件 → 宿主（agent 框架）
{ "type": "approval.request", "id": "ap1", "chatKey": "private:10001",
  "title": "写文件 a.txt", "detail": "…", "options": [
    { "id": "allow", "label": "允许" }, { "id": "deny", "label": "拒绝" } ] }

// 宿主（agent 框架） → 插件
{ "type": "approval.decision", "id": "ap1", "choice": "allow", "label": "允许", "by": "10001" }
```

宿主（agent 框架） 把选项渲染成「1. 允许 / 2. 拒绝」，用户回数字即可；120 秒不选自动拒绝。

## 图片

`action.sendMedia` 支持 `dataUrl` / `base64` / `url`，宿主（agent 框架） 用现有图片管线发出。
入站图片会放在 `event.message.images`，但当前 DSH 的 ACP 声明 `image:false`，插件不会把图片塞进 prompt。

## 未实现

- `action.history` / `action.members`
- 文件（非图片）外发

收到未实现的类型会回 `{"type":"result","id":...,"ok":false,"error":"不支持的消息：..."}`，不会断连。

## 命令

| 命令 | 行为 |
|---|---|
| `/dsh <任务>` | 一次性转给插件，答完回 宿主（agent 框架） |
| `/dsh on` / `off` | 本会话粘性接管 / 交回 |
| `/dsh new` / `stop` | 转发 `event.command` |
| `/dsh status` | 回当前模式和插件连接状态 |
| `/dsh help` | 命令表 |

放行规则：`data/bridge/config.json` 的 `allow.chats`（空=只允许私聊）、`allow.users`（空=不限制用户）。
不在名单里的命令**会被吞掉且不回复**，避免被群里的人拿去驱动 DSH。

## 安全边界

- 只绑定 `127.0.0.1`，token 每次安装随机生成，权限仅限“给白名单会话发消息”
- 插件拿不到 OneBot、拿不到 console token、读不到聊天存档
- 插件崩溃/断线不影响 宿主（agent 框架） 正常聊天；命令会回“DSH 未连接”
- 所有错误只回错误帧，不抛异常给内核

## 配置

`data/bridge/config.json`：

```json
{ "enabled": true, "port": 3311, "command": "/dsh", "ack": true,
  "allow": { "chats": ["group:123456"], "users": [] } }
```

面板「DeepSeek → 洛希通道」可以看到监听状态、插件连接、放行数量和 token。
