// 最小 ACP 客户端：ndjson JSON-RPC，驱动 `dsh --profile acp`。
// 只实现桥需要的：initialize / session.new / session.prompt / session.cancel，
// 外加把 request_permission 按配置自动决定。
import { spawn } from 'node:child_process';

const REQUEST_TIMEOUT_MS = 15 * 60 * 1000;

export class AcpClient {
  constructor({ node = process.execPath, bin, env = {}, cwd = process.cwd(), permission = 'ask', onPermission = null, log = () => {} } = {}) {
    this.node = node;
    this.bin = bin;
    this.env = env;
    this.cwd = cwd;
    this.permission = permission;
    this.onPermission = onPermission;
    this.log = log;
    this.child = null;
    this.seq = 0;
    this.pending = new Map();
    this.buffer = '';
    this.handlers = new Map();
    this.ready = null;
  }

  start() {
    if (this.child) return this.ready;
    this.child = spawn(this.node, [this.bin, '--profile', 'acp'], {
      cwd: this.cwd,
      env: { ...process.env, ...this.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.#feed(chunk));
    this.child.stderr.on('data', (chunk) => this.log(`[dsh] ${String(chunk).trimEnd()}`));
    this.child.once('exit', (code) => {
      this.log(`[dsh] acp 退出 code=${code}`);
      for (const { reject } of this.pending.values()) reject(new Error('DSH ACP 进程已退出'));
      this.pending.clear();
      this.child = null;
      this.ready = null;
    });
    this.ready = this.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
      .then((info) => { this.log(`[dsh] ${info?.agentInfo?.name ?? 'acp'} 已就绪`); return info; });
    return this.ready;
  }

  #feed(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { this.log(`[dsh] 无法解析：${line.slice(0, 120)}`); continue; }
      this.#dispatch(message);
    }
  }

  #dispatch(message) {
    if (message.id !== undefined && message.method) {
      void this.#serve(message);
      return;
    }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const { resolve, reject, timer } = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(timer);
      if (message.error) reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      else resolve(message.result);
      return;
    }
    if (message.method) {
      for (const handler of this.handlers.get(message.method) ?? []) handler(message.params);
    }
  }

  async #serve(request) {
    if (request.method === 'session/request_permission') {
      const options = request.params?.options ?? [];
      let optionId = null;
      try {
        if (this.onPermission && this.permission === 'ask') optionId = await this.onPermission(request.params);
        else if (this.permission !== 'deny') optionId = options.find(option => /allow/i.test(String(option.kind ?? '')))?.optionId ?? null;
      } catch (error) {
        this.log(`[dsh] 权限决策失败：${error?.message ?? error}`);
      }
      const outcome = optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' };
      this.log(`[dsh] 权限请求：${request.params?.toolCall?.title ?? '工具调用'} → ${optionId ? '允许' : '拒绝'}`);
      this.#write({ jsonrpc: '2.0', id: request.id, result: { outcome } });
      return;
    }
    this.#write({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `unsupported: ${request.method}` } });
  }

  #write(payload) {
    if (!this.child?.stdin?.writable) return;
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (!this.child) throw new Error('ACP 还没启动');
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.#write({ jsonrpc: '2.0', id, method, params });
    });
  }

  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(handler);
  }

  async newSession(cwd = this.cwd) {
    await this.start();
    const result = await this.request('session/new', { cwd, mcpServers: [] });
    return result.sessionId;
  }

  async prompt(sessionId, text, onText = () => {}) {
    await this.start();
    const off = (params) => {
      const update = params?.update;
      if (params?.sessionId !== sessionId || !update) return;
      if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') onText(update.content.text);
    };
    this.on('session/update', off);
    try {
      const result = await this.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
      return result?.stopReason ?? 'end_turn';
    } finally {
      const list = this.handlers.get('session/update') ?? [];
      const index = list.indexOf(off);
      if (index >= 0) list.splice(index, 1);
    }
  }

  cancel(sessionId) {
    this.#write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
  }

  stop() {
    try { this.child?.kill(); } catch { /* 已退出 */ }
    this.child = null;
    this.ready = null;
  }
}
