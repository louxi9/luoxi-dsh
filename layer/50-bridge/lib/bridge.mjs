// 洛希桥：本机 WebSocket 服务，给 DSH 侧插件提供「收发 会话消息」的最小接口。
// 设计原则：会话 连接、唤醒、发送队列永远在宿主；插件只是被命令唤起时的执行端。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { HELP_TEXT, parseCommand } from './commands.mjs';
import { holder } from './holder.mjs';

const PROTOCOL = 1;
const MAX_RECENT = 40;
const AUTH_TIMEOUT_MS = 10000;
const MAX_RESTARTS = 5;
const PERMISSIONS = new Set(['ask', 'allow', 'deny']);

const DEFAULTS = Object.freeze({
  enabled: true,
  port: 3311,
  command: '/dsh',
  ack: true,
  autoStart: true,
  workspace: '',
  approvalTimeoutMs: 120000,
  // privateDefault: 'dsh' —— 私聊不用打 /dsh，直接说就交给 DSH；'brain' 则回到老行为。
  privateDefault: 'dsh',
  // 插件的 --permission：ask 转 QQ 审批 / allow 自动允许 / deny 全拒。
  permission: 'ask',
  allow: { chats: [], users: [] },
});

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function mask(token) {
  const value = String(token ?? '');
  return value.length <= 8 ? '****' : `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function exists(file) {
  try { return fs.existsSync(file); } catch { return false; }
}

export function createBridge({ dataDir, appRoot = '', log = null }) {
  const root = path.join(dataDir, 'bridge');
  const configFile = path.join(root, 'config.json');
  const tokenFile = path.join(root, 'token');
  const stateFile = path.join(root, 'state.json');

  const config = { ...DEFAULTS, ...(readJson(configFile) ?? {}) };
  config.allow = { ...DEFAULTS.allow, ...(config.allow ?? {}) };
  const state = readJson(stateFile) ?? { modes: {} };
  if (!state.modes || typeof state.modes !== 'object') state.modes = {};

  fs.mkdirSync(root, { recursive: true });
  if (!fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, crypto.randomBytes(24).toString('hex'), 'utf8');
  const token = String(fs.readFileSync(tokenFile, 'utf8')).trim();

  let send = null;
  let wss = null;
  let plugin = null;
  let pluginProc = null;
  let pluginRestarts = 0;
  let pluginLastExit = null;
  let restartTimer = null;
  let stopping = false;
  let listening = false;
  let boundPort = null;
  let lastError = '';
  let seq = 0;
  const recent = [];
  const usage = { inputTokens: 0, outputTokens: 0, calls: 0, contextUsed: 0, contextSize: 0 };
  const approvals = new Map();
  let heartbeat = null;

  const modes = new Map(Object.entries(state.modes));

  function remember(entry) {
    recent.push({ at: Date.now(), ...entry });
    if (recent.length > MAX_RECENT) recent.splice(0, recent.length - MAX_RECENT);
  }

  function saveState() {
    try { writeJson(stateFile, { modes: Object.fromEntries(modes) }); } catch { /* 状态写不进去不影响运行 */ }
  }

  function saveConfig() {
    try { writeJson(configFile, config); } catch { /* 同上 */ }
  }

  const pluginConnected = () => Boolean(plugin && plugin.ws?.readyState === 1);
  // 桌宠窗口的会话（30-desktop-extras 的聊天窗，本机窗口，天然可信）。
  const PET_CHAT_KEY = 'private:999999999999999';
  // 会话放行：私聊一律允许；群聊要配了「用户白名单」才放开——
  // chats 为空时表示所有群都放开，但群里的每个发言人都必须过 users 白名单。
  const chatAllowed = (chatKey) => {
    const key = String(chatKey);
    if (key.startsWith('private:')) return true;
    if (!(config.allow.users ?? []).length) return false;
    const chats = (config.allow.chats ?? []).map(String);
    return chats.length ? chats.includes(key) : true;
  };
  function senderAllowed(chatKey, senderId) {
    const key = String(chatKey);
    if (key === PET_CHAT_KEY) return true; // 桌宠窗口没有 QQ 号，不走用户白名单
    // 本机面板发出的消息（senderId 固定 self）：QQ 号不会是 self，不存在伪造面。
    if (String(senderId) === 'self') return true;
    if (!chatAllowed(key)) return false;
    const users = (config.allow.users ?? []).map(String);
    return users.length ? users.includes(String(senderId)) : true;
  }

  async function reply(chatKey, text) {
    if (!send?.sendTextBatch) return false;
    try {
      await send.sendTextBatch(chatKey, [String(text)], { source: 'luoxi-bridge' });
      return true;
    } catch (error) {
      log?.warn?.(`[luoxi-bridge] 回复失败：${error?.message ?? error}`);
      return false;
    }
  }

  function emit(type, payload) {
    if (!pluginConnected()) return false;
    try {
      plugin.ws.send(JSON.stringify({ type, seq: ++seq, ...payload }));
      return true;
    } catch { return false; }
  }

  function describe() {
    return {
      enabled: config.enabled !== false,
      listening,
      port: boundPort ?? config.port,
      protocol: PROTOCOL,
      command: config.command,
      token: mask(token),
      plugin: plugin ? { name: plugin.name, version: plugin.version, since: plugin.since } : null,
      autoStart: config.autoStart !== false,
      process: pluginProc ? { pid: pluginProc.pid, restarts: pluginRestarts, since: pluginProc.startedAt } : null,
      lastExit: pluginLastExit,
      modes: [...modes.entries()].map(([chatKey, mode]) => ({ chatKey, mode })),
      approvals: [...approvals.values()].map(a => ({ chatKey: a.chatKey, title: a.title, expiresAt: a.expiresAt })),
      allow: { chats: [...(config.allow.chats ?? [])], users: [...(config.allow.users ?? [])] },
      privateDefault: config.privateDefault === 'brain' ? 'brain' : 'dsh',
      workspace: config.workspace || '',
      permission: config.permission,
      usage: { ...usage },
      recent: recent.slice(-10),
      error: lastError,
    };
  }

  // ---- 插件进程（随桥启动，崩了自动拉起）----
  function pluginPaths() {
    const nodeExe = path.join(appRoot, 'runtime', 'dsh', 'node', 'node.exe');
    const dshBin = path.join(appRoot, 'runtime', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    const bin = path.join(appRoot, 'luoxi-plugin-dsh', 'bin', 'luoxi.mjs');
    return { nodeExe, dshBin, bin, home: path.join(dataDir, 'dsh-home'), workspace: config.workspace || path.join(dataDir, 'dsh-workspace') };
  }

  function startPlugin() {
    if (stopping || pluginProc || config.autoStart === false || !appRoot) return false;
    const { nodeExe, dshBin, bin, home, workspace } = pluginPaths();
    if (!exists(nodeExe) || !exists(dshBin) || !exists(bin)) return false;
    try { fs.mkdirSync(workspace, { recursive: true }); } catch { /* 目录失败会在插件侧报错 */ }
    const shim = path.join(appRoot, 'runtime', 'dsh', 'bin');
    // token 走环境变量而不是命令行：--token 会出现在进程列表里，本机任何程序都看得到。
    const args = [
      bin, '--bridge', `ws://127.0.0.1:${boundPort ?? config.port}`,
      '--workspace', workspace, '--dsh', dshBin, '--node', nodeExe, '--dsh-home', home,
      '--permission', PERMISSIONS.has(config.permission) ? config.permission : 'ask',
    ];
    const child = spawn(nodeExe, args, {
      cwd: path.join(appRoot),
      env: { ...process.env, DSH_HOME: home, LUOXI_BRIDGE_TOKEN: token, ...(exists(shim) ? { PATH: `${shim}${path.delimiter}${process.env.PATH ?? ''}` } : {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    pluginProc = child;
    child.startedAt = Date.now();
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', chunk => remember({ kind: 'plugin-log', line: String(chunk).trim().slice(0, 200) }));
    child.stderr?.on('data', chunk => remember({ kind: 'plugin-log', line: String(chunk).trim().slice(0, 200) }));
    child.once('exit', (code) => {
      pluginLastExit = { code, at: Date.now() };
      pluginProc = null;
      if (stopping || config.autoStart === false) return;
      if (pluginRestarts >= MAX_RESTARTS) { log?.warn?.(`[luoxi-bridge] 插件反复退出（${code}），不再自动拉起`); return; }
      pluginRestarts += 1;
      const delay = Math.min(3000 * pluginRestarts, 30000);
      restartTimer = setTimeout(startPlugin, delay);
      restartTimer.unref?.();
    });
    log?.info?.('[luoxi-bridge] 已启动 luoxi-plugin-dsh');
    return true;
  }

  function stopPlugin() {
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = null;
    const child = pluginProc;
    pluginProc = null;
    if (!child?.pid) return;
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else child.kill('SIGTERM');
    } catch { /* 已退出 */ }
  }

  // ---- 审批 ----
  function decideApproval(id, choice, by = '') {
    const found = [...approvals.values()].find(a => a.id === id);
    if (!found) return false;
    clearTimeout(found.timer);
    approvals.delete(found.chatKey);
    const option = found.options.find(o => o.id === choice) ?? null;
    if (found.ws?.readyState === 1) {
      try { found.ws.send(JSON.stringify({ type: 'approval.decision', id, choice: option?.id ?? null, label: option?.label ?? '', by })); } catch { /* 插件已断 */ }
    }
    remember({ kind: 'approval', chatKey: found.chatKey, title: found.title, choice: option?.label ?? '拒绝', by });
    if (found.chatKey && by) void reply(found.chatKey, option ? `已选择：${option.label}` : '已拒绝。');
    return true;
  }

  function requestApproval(ws, msg) {
    const chatKey = String(msg.chatKey ?? '');
    if (!chatAllowed(chatKey)) {
      ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: false, error: 'chat not allowed' }));
      return;
    }
    if (approvals.has(chatKey)) decideApproval(approvals.get(chatKey).id, null, 'replaced');
    const options = (Array.isArray(msg.options) ? msg.options : []).slice(0, 9)
      .map((option, index) => ({ id: String(option?.id ?? index + 1), label: String(option?.label ?? option?.id ?? `选项 ${index + 1}`) }));
    const id = String(msg.id || crypto.randomUUID());
    const timeoutMs = Math.max(10000, Number(config.approvalTimeoutMs) || 120000);
    const lines = [`DSH 需要确认：${String(msg.title ?? '工具调用').slice(0, 120)}`];
    if (msg.detail) lines.push(String(msg.detail).slice(0, 400));
    options.forEach((option, index) => lines.push(`${index + 1}. ${option.label}`));
    lines.push(`回复数字选择，${Math.round(timeoutMs / 1000)} 秒不选将自动拒绝。`);
    const timer = setTimeout(() => decideApproval(id, null, 'timeout'), timeoutMs);
    timer.unref?.();
    approvals.set(chatKey, { id, chatKey, title: String(msg.title ?? ''), options, timer, ws, expiresAt: Date.now() + timeoutMs });
    void reply(chatKey, lines.join('\n'));
    remember({ kind: 'approval-request', chatKey, title: String(msg.title ?? ''), options: options.length });
    if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: true }));
  }

  // ---- 消息路由 ----
  async function handleMessage(result, options = {}) {
    const chatKey = result.chatKey;
    const entry = result.entry ?? {};
    const text = String(entry.text ?? '');
    const trimmed = text.trim();

    const pending = approvals.get(chatKey);
    if (pending && /^\d+$/.test(trimmed)) {
      const index = Number(trimmed) - 1;
      if (index >= 0 && index < pending.options.length) {
        decideApproval(pending.id, pending.options[index].id, String(entry.senderId ?? ''));
        return true;
      }
    }

    const cmd = parseCommand(text, config.command);
    const sticky = modes.get(chatKey) === 'sticky';
    const brain = modes.get(chatKey) === 'brain'; // 发过 /dsh off，显式交回主脑
    // 私聊默认直接交给 DSH（配置 privateDefault:'dsh'），/dsh off 可关掉；
    // 桌宠窗口由窗口里的「主脑/DSH」开关决定，走 options.force 强制转发。
    const isPet = chatKey === PET_CHAT_KEY;
    // 白名单为空时私聊不自动接管：否则任何好友发来的私聊都会被 DSH 接走。
    const privateDefault = config.privateDefault === 'dsh' && (config.allow.users ?? []).length > 0
      && String(chatKey).startsWith('private:') && !isPet && !sticky && !brain;
    const forced = options.force === true;
    if (!cmd && !sticky && !forced && !privateDefault) return false;
    if (!senderAllowed(chatKey, entry.senderId)) return Boolean(cmd);

    const images = (entry.media ?? []).filter(m => m.kind === 'image' && (m.url || m.file)).map(m => ({ url: m.url ?? '', file: m.file ?? '' }));

    if (!cmd) {
      if (!pluginConnected()) { await reply(chatKey, 'DSH 还没连上：先在「DeepSeek」页启动并装好插件。'); return true; }
      emit('event.message', {
        chat: { key: chatKey, type: chatKey.startsWith('group:') ? 'group' : 'private' },
        sender: { id: String(entry.senderId ?? ''), name: String(entry.senderName ?? '') },
        text, images, mode: 'sticky', at: Date.now(),
        ...(options.fresh === true ? { fresh: true } : {}),
        ...(options.sessionId ? { sessionId: String(options.sessionId) } : {}),
      });
      remember({ chatKey, kind: 'prompt', mode: 'sticky', chars: text.length, images: images.length });
      return true;
    }

    switch (cmd.kind) {
      case 'help':
        await reply(chatKey, HELP_TEXT);
        return true;
      case 'status': {
        const lines = [`模式：${sticky ? 'DSH 接管中' : brain ? '主脑（已用 /dsh off 交回）' : privateDefault ? '主脑（私聊默认走 DSH，发 /dsh off 可交回）' : '主脑'}`];
        lines.push(pluginConnected() ? `插件：${plugin.name ?? 'luoxi-plugin-dsh'} 已连接` : '插件：未连接');
        if (approvals.has(chatKey)) lines.push('有一条审批等你回复数字。');
        await reply(chatKey, lines.join('\n'));
        return true;
      }
      case 'on':
        modes.set(chatKey, 'sticky'); saveState();
        await reply(chatKey, '好，本会话交给 DSH。发 /dsh off 交回来。');
        remember({ chatKey, kind: 'mode', mode: 'sticky' });
        return true;
      case 'off':
        modes.set(chatKey, 'brain'); saveState();
        await reply(chatKey, '已交回主脑。发 /dsh on 或 /dsh <任务> 再交回来。');
        remember({ chatKey, kind: 'mode', mode: 'off' });
        return true;
      case 'new':
      case 'stop': {
        if (!pluginConnected()) { await reply(chatKey, 'DSH 未连接，命令没有执行。'); return true; }
        emit('event.command', { chat: { key: chatKey }, command: cmd.kind });
        await reply(chatKey, cmd.kind === 'new' ? '已通知 DSH 开新会话。' : '已通知 DSH 中断当前任务。');
        remember({ chatKey, kind: 'command', command: cmd.kind });
        return true;
      }
      case 'prompt':
      default: {
        if (!pluginConnected()) { await reply(chatKey, 'DSH 未连接：先在「DeepSeek」页点启动。'); return true; }
        emit('event.message', {
          chat: { key: chatKey, type: chatKey.startsWith('group:') ? 'group' : 'private' },
          sender: { id: String(entry.senderId ?? ''), name: String(entry.senderName ?? '') },
          text: cmd.text ?? text, images, mode: 'oneshot', at: Date.now(),
          ...(options.fresh === true ? { fresh: true } : {}),
          ...(options.sessionId ? { sessionId: String(options.sessionId) } : {}),
        });
        if (config.ack !== false) await reply(chatKey, '已交给 DSH，处理中…');
        remember({ chatKey, kind: 'prompt', mode: 'oneshot', chars: (cmd.text ?? text).length, images: images.length });
        return true;
      }
    }
  }

  function attach(ws) {
    let alive = true;
    let authed = false;
    const authTimer = setTimeout(() => { if (!authed) { try { ws.close(4001, 'auth timeout'); } catch { /* 已关闭 */ } } }, AUTH_TIMEOUT_MS);
    ws.on('pong', () => { alive = true; });
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return; }
      if (!authed) {
        if (msg?.type !== 'hello') { try { ws.close(4001, 'hello required'); } catch { /* 已关闭 */ } return; }
        const given = String(msg.token ?? '');
        const same = given.length === token.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token));
        if (!same) { try { ws.send(JSON.stringify({ type: 'error', code: 'auth', message: 'token 不对' })); ws.close(4001, 'bad token'); } catch { /* 已关闭 */ } return; }
        if (msg.protocol !== PROTOCOL) {
          try { ws.send(JSON.stringify({ type: 'error', code: 'protocol', message: `只支持协议 ${PROTOCOL}` })); ws.close(4002, 'protocol'); } catch { /* 已关闭 */ }
          return;
        }
        authed = true;
        clearTimeout(authTimer);
        if (plugin && plugin.ws !== ws) { try { plugin.ws.close(4000, 'replaced'); } catch { /* 已关闭 */ } }
        plugin = { ws, name: String(msg.plugin?.name ?? 'luoxi-plugin-dsh'), version: String(msg.plugin?.version ?? ''), since: Date.now() };
        lastError = '';
        remember({ kind: 'hello', plugin: plugin.name, version: plugin.version });
        ws.send(JSON.stringify({ type: 'hello.ok', protocol: PROTOCOL, commands: { prefix: config.command }, bot: { name: 'luoxi-host' } }));
        log?.info?.(`[luoxi-bridge] 插件已连接：${plugin.name}@${plugin.version}`);
        return;
      }
      if (msg?.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }
      if (msg?.type === 'action.send') {
        const chatKey = String(msg.chatKey ?? '');
        if (!chatAllowed(chatKey)) { ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: false, error: 'chat not allowed' })); return; }
        void reply(chatKey, String(msg.text ?? '')).then((ok) => {
          try { ws.send(JSON.stringify({ type: 'result', id: msg.id, ok, ...(ok ? {} : { error: 'send failed' }) })); } catch { /* 已关闭 */ }
          remember({ kind: 'send', chatKey, chars: String(msg.text ?? '').length, ok });
        });
        return;
      }
      if (msg?.type === 'action.sendMedia') {
        const chatKey = String(msg.chatKey ?? '');
        if (!chatAllowed(chatKey)) { ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: false, error: 'chat not allowed' })); return; }
        const payload = msg.dataUrl ? { dataUrl: String(msg.dataUrl) } : msg.base64 ? { base64: String(msg.base64) } : msg.url ? { url: String(msg.url) } : null;
        if (!payload || !send?.sendImage) { ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: false, error: '图片内容缺失或发送不可用' })); return; }
        void Promise.resolve(send.sendImage(chatKey, payload, { source: 'luoxi-bridge' }))
          .then(() => ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: true })))
          .catch((error) => { try { ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: false, error: String(error?.message ?? error) })); } catch { /* 已关闭 */ } });
        remember({ kind: 'media', chatKey });
        return;
      }
      if (msg?.type === 'approval.request') { requestApproval(ws, msg); return; }
      if (msg?.type === 'tool.report') {
        // 单向通知：转给宿主侧（30 层）存轨迹，供桌宠/面板显示。
        try { holder.toolSink?.(msg); } catch { /* 消费方失败不影响插件 */ }
        return;
      }
      if (msg?.type === 'usage.report') {
        usage.inputTokens += Number(msg.inputTokens) || 0;
        usage.outputTokens += Number(msg.outputTokens) || 0;
        usage.contextUsed = Number(msg.contextUsed) || usage.contextUsed;
        usage.contextSize = Number(msg.contextSize) || usage.contextSize;
        usage.calls += 1;
        remember({ kind: 'usage', chatKey: msg.chatKey, used: usage.contextUsed, size: usage.contextSize });
        return;
      }
      ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: false, error: `不支持的消息：${msg?.type ?? 'unknown'}` }));
    });
    ws.on('close', () => { clearTimeout(authTimer); if (plugin?.ws === ws) { plugin = null; log?.info?.('[luoxi-bridge] 插件已断开'); } });
    ws.on('error', () => { /* 关闭事件会处理 */ });
    const idle = setInterval(() => {
      if (ws.readyState !== 1) { clearInterval(idle); return; }
      if (!alive) { try { ws.terminate(); } catch { /* 已关闭 */ } clearInterval(idle); return; }
      alive = false;
      try { ws.ping(); } catch { /* 已关闭 */ }
    }, 30000);
    ws.on('close', () => clearInterval(idle));
  }

  function start() {
    if (wss || config.enabled === false) return;
    try {
      wss = new WebSocketServer({ host: '127.0.0.1', port: Number.isInteger(config.port) ? config.port : 3311 });
    } catch (error) {
      lastError = error?.message ?? String(error);
      log?.warn?.(`[luoxi-bridge] 无法监听：${lastError}`);
      return;
    }
    wss.on('listening', () => {
      listening = true;
      lastError = '';
      boundPort = wss.address?.().port ?? config.port;
      log?.info?.(`[luoxi-bridge] 监听 127.0.0.1:${boundPort}`);
      startPlugin();
    });
    wss.on('connection', attach);
    wss.on('error', (error) => { listening = false; lastError = error?.message ?? String(error); log?.warn?.(`[luoxi-bridge] 错误：${lastError}`); });
    heartbeat = setInterval(() => { /* 心跳在连接级别处理 */ }, 30000);
    heartbeat.unref?.();
  }

  function stop() {
    stopping = true;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    for (const approval of approvals.values()) clearTimeout(approval.timer);
    approvals.clear();
    stopPlugin();
    try { plugin?.ws?.close(4000, 'shutdown'); } catch { /* 已关闭 */ }
    plugin = null;
    try { wss?.close(); } catch { /* 已关闭 */ }
    wss = null;
    listening = false;
    boundPort = null;
  }

  return {
    start, stop, describe,
    handleMessage,
    setSend(instance) { send = instance; },
    startPlugin, stopPlugin,
    updateConfig(patch = {}) {
      if (patch.enabled !== undefined) config.enabled = Boolean(patch.enabled);
      if (patch.ack !== undefined) config.ack = Boolean(patch.ack);
      if (patch.autoStart !== undefined) config.autoStart = Boolean(patch.autoStart);
      if (patch.command !== undefined && String(patch.command).startsWith('/')) config.command = String(patch.command);
      if (patch.workspace !== undefined) config.workspace = String(patch.workspace);
      if (patch.allow) config.allow = { chats: [...(patch.allow.chats ?? config.allow.chats ?? [])].map(String), users: [...(patch.allow.users ?? config.allow.users ?? [])].map(String) };
      if (patch.privateDefault !== undefined) config.privateDefault = patch.privateDefault === 'brain' ? 'brain' : 'dsh';
      if (patch.permission !== undefined && PERMISSIONS.has(String(patch.permission))) config.permission = String(patch.permission);
      saveConfig();
      return describe();
    },
    setMode(chatKey, mode) {
      if (mode === 'sticky') modes.set(String(chatKey), 'sticky'); else modes.delete(String(chatKey));
      saveState();
      return describe();
    },
    decideApproval,
    token() { return token; },
    _debug: { emit, config, approvals },
  };
}
