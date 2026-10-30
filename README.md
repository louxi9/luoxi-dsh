# 洛希 DSH 接入层（luoxi-dsh）

把 **DeepSeek Harness** 接进一个支持“v2 追加组合层”的 agent 框架：按需安装依赖、自启动、单独窗口、
面板、`/dsh` 命令桥、会话 式数字审批、插件守护。一个安装脚本装完，重启即可用。

> 本仓库不包含任何宿主业务代码，也不包含 DSH 运行时本体（node / dsh 依赖由运行时自己装）。

## 为什么是“两层 + 一个插件”

普通扩展（工具、面板、钩子的 SDK）有三件事做不到，所以分层：

1. **在唤醒前吞掉 `/dsh` 命令**——需要 `ingest` 级拦截，宿主没给扩展这个钩子
2. **开本机 WebSocket**——扩展权限模型里没有 raw socket
3. **驱动 DSH 会话**——用官方的 ACP，不需要碰 DSH 内部插件 API

| 目录 | 形态 | 做什么 |
|---|---|---|
| `layer/40-harness` | 追加组合层 | 按需装依赖、`dsh web` 自启动/停止、单独窗口、控制台面板 |
| `layer/50-bridge` | 追加组合层 | `/dsh` 命令拦截、本机 WS 桥、审批、插件守护 |
| `plugin/` | 独立进程 | 用 ACP 驱动 DSH 会话，把结果送回会话 |

宿主将来若补了“可拦截的消息钩子”和 socket 权限，两层的代码可以直接并进扩展。

## 宿主要求

- 支持 v2 追加组合：会扫描 `overrides/<目录>/composition.json`，并给路由提供 `http.route` / `http.onDispose` 与 `deps`（`appRoot`、`dataDir`、`log`）
- 可包装 `core.ingest` / `core.send` 两个组件
- Windows + Electron（单独窗口依赖 `BrowserWindow`；无窗口环境自动回退系统浏览器）
- 运行时目录 `runtime/dsh/`：`node/node.exe`、`package.json`、`package-lock.json`（建议再放 `npm/` 与 `pnpm/`）

## 安装

```bash
git clone https://github.com/luoxi9/luoxi-dsh.git
cd luoxi-dsh
node install.mjs "<宿主目录>"
```

安装目标：

```
<宿主>/overrides/40-luoxi-harness
<宿主>/overrides/50-luoxi-bridge
<宿主>/luoxi-plugin-dsh
```

已有同名目录会先备份成 `*.bak-<时间戳>`。卸载：`node install.mjs "<宿主目录>" --uninstall`。

## 命令

```
/dsh <任务>    交给 DSH
/dsh on        本会话交给 DSH
/dsh off       交回主脑
/dsh new       新会话
/dsh stop      中断
/dsh status    状态
/dsh help      帮助
```

危险工具会在会话里问「1. 允许 / 2. 拒绝」，回数字即可，120 秒不选自动拒绝。

## 协议

本机 WS 协议（握手、消息、动作、审批、图片、用量）见 [`docs/protocol.md`](docs/protocol.md)。
插件侧实现在 `plugin/`，也可以单独发布安装。

## 安全

- 桥只监听 `127.0.0.1`，token 在宿主数据目录 `bridge/token`，权限只到“往白名单会话发消息”
- 默认只允许私聊，群要显式加入白名单
- 依赖安装关闭了第三方安装脚本（`--ignore-scripts`），完整性由 lock 文件保证
- DSH 的对话会发到你填的模型账号所在的服务商，面板上已注明

## 许可

MIT，见 [LICENSE](LICENSE)。
