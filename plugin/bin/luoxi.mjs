#!/usr/bin/env node
// luoxi-plugin-dsh：把 洛希桥过来的任务交给 DeepSeek Harness（ACP），再把回答送回 会话。
// 用法见 README；所有参数也支持环境变量（LUOXI_*）。
import path from 'node:path';
import { AcpClient } from '../src/acp.mjs';
import { BridgeClient } from '../src/bridge.mjs';

const args = process.argv.slice(2);
const value = (flag, fallback = '') => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const has = (flag) => args.includes(flag);

const bridgeUrl = value('--bridge', process.env.LUOXI_BRIDGE_URL ?? 'ws://127.0.0.1:3311');
const token = value('--token', process.env.LUOXI_BRIDGE_TOKEN ?? '');
const workspace = path.resolve(value('--workspace', process.env.LUOXI_WORKSPACE ?? process.cwd()));
const dshBin = value('--dsh', process.env.LUOXI_DSH_BIN ?? '');
const nodePath = value('--node', process.env.LUOXI_NODE ?? process.execPath);
const dshHome = value('--dsh-home', process.env.LUOXI_DSH_HOME ?? '');
const permission = value('--permission', process.env.LUOXI_PERMISSION ?? 'ask');
const checkOnly = has('--check');

const log = (line) => console.log(`[luoxi] ${line}`);

if (!token) {
  console.error('缺少 token：用 --token 或 LUOXI_BRIDGE_TOKEN 指定（在 宿主 的「DeepSeek → 洛希通道」里复制）。');
  process.exit(2);
}
if (!dshBin) {
  console.error('缺少 dsh 入口：用 --dsh 指向 runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js。');
  process.exit(2);
}

const sessionChat = new Map();
let bridgeRef = null;

const acp = new AcpClient({
  node: nodePath,
  bin: dshBin,
  cwd: workspace,
  permission,
  log,
  env: dshHome ? { DSH_HOME: dshHome } : {},
  onPermission: async (params) => {
    const chatKey = sessionChat.get(params?.sessionId) ?? '';
    const options = (params?.options ?? []).map(option => ({ id: String(option.optionId ?? ''), label: String(option.name ?? option.kind ?? '选项') }));
    if (!chatKey || !bridgeRef) return null;
    const title = params?.toolCall?.title ?? params?.toolCall?.kind ?? '工具调用';
    log(`等待 会话 审批：${title}`);
    const choice = await bridgeRef.requestApproval({ chatKey, title, detail: params?.toolCall?.rawInput ? JSON.stringify(params.toolCall.rawInput).slice(0, 300) : '', options });
    return choice || null;
  },
});

acp.on('session/update', (params) => {
  const update = params?.update;
  if (update?.sessionUpdate !== 'usage_update') return;
  const chatKey = sessionChat.get(params.sessionId);
  if (!chatKey || !bridgeRef) return;
  bridgeRef.reportUsage(chatKey, params.sessionId, { contextUsed: Number(update.used) || 0, contextSize: Number(update.size) || 0 });
});

const sessions = new Map();
const queues = new Map();
const buffers = new Map();

function enqueue(chatKey, task) {
  const previous = queues.get(chatKey) ?? Promise.resolve();
  const next = previous.then(task, task);
  queues.set(chatKey, next.catch(() => {}));
  return next;
}

async function sessionFor(chatKey, { fresh = false } = {}) {
  if (!fresh && sessions.has(chatKey)) return sessions.get(chatKey);
  const sessionId = await acp.newSession(workspace);
  sessions.set(chatKey, sessionId);
  sessionChat.set(sessionId, chatKey);
  log(`会话 ${chatKey} → ${sessionId}`);
  return sessionId;
}

const bridge = new BridgeClient({
  url: bridgeUrl,
  token,
  log,
  onOpen: () => { if (checkOnly) { log('连接正常，退出。'); bridge.close(); process.exit(0); } },
  onClose: () => { /* 自动重连 */ },
  onMessage: (event) => {
    const chatKey = event.chat?.key;
    if (!chatKey) return;
    const text = String(event.text ?? '').trim();
    if (!text) return;
    void enqueue(chatKey, async () => {
      buffers.set(chatKey, '');
      try {
        const sessionId = await sessionFor(chatKey);
        const stop = await acp.prompt(sessionId, text, (chunk) => buffers.set(chatKey, (buffers.get(chatKey) ?? '') + chunk));
        const answer = (buffers.get(chatKey) ?? '').trim();
        buffers.delete(chatKey);
        if (answer) await bridge.sendText(chatKey, answer);
        else await bridge.sendText(chatKey, stop === 'cancelled' ? '任务已取消。' : '（DSH 没有输出文本）');
      } catch (error) {
        log(`任务失败：${error?.message ?? error}`);
        await bridge.sendText(chatKey, `DSH 出错了：${error?.message ?? error}`).catch(() => {});
      }
    });
  },
  onCommand: (event) => {
    const chatKey = event.chat?.key;
    if (!chatKey) return;
    if (event.command === 'new') {
      sessions.delete(chatKey);
      log(`会话 ${chatKey} 已重置`);
    } else if (event.command === 'stop') {
      const sessionId = sessions.get(chatKey);
      if (sessionId) acp.cancel(sessionId);
      log(`会话 ${chatKey} 已请求中断`);
    }
  },
});

bridgeRef = bridge;
log(`工作区 ${workspace}`);
bridge.connect().catch((error) => {
  console.error(`[luoxi] 连接 宿主 失败：${error?.message ?? error}`);
  process.exit(1);
});

const shutdown = () => { bridge.close(); acp.stop(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
