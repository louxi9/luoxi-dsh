// 洛希桥客户端：连 127.0.0.1 上的 宿主，收 event.*，发 action.*。
import { WebSocket } from 'ws';

const PROTOCOL = 1;
const ACTION_TIMEOUT_MS = 30000;

export class BridgeClient {
  constructor({ url, token, name = 'luoxi-plugin-dsh', version = '0.1.0', log = () => {}, onMessage, onCommand, onOpen, onClose } = {}) {
    this.url = url;
    this.token = token;
    this.name = name;
    this.version = version;
    this.log = log;
    this.onMessage = onMessage ?? (() => {});
    this.onCommand = onCommand ?? (() => {});
    this.onOpen = onOpen ?? (() => {});
    this.onClose = onClose ?? (() => {});
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
    this.closed = false;
    this.retry = 1000;
    this.approvalSeq = 0;
    this.approvals = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      ws.once('open', () => {
        ws.send(JSON.stringify({ type: 'hello', token: this.token, protocol: PROTOCOL, plugin: { name: this.name, version: this.version } }));
      });
      ws.on('message', (data) => {
        let message;
        try { message = JSON.parse(String(data)); } catch { return; }
        if (message.type === 'hello.ok') {
          this.retry = 1000;
          settled = true;
          this.log(`[bridge] 已连上 ${this.url}（${message.bot?.name ?? 'luoxi-host'}）`);
          this.onOpen(message);
          resolve(message);
          return;
        }
        if (message.type === 'error') {
          this.log(`[bridge] 服务端拒绝：${message.code} ${message.message}`);
          fail(new Error(`${message.code}: ${message.message}`));
          return;
        }
        if (message.type === 'result' && this.pending.has(message.id)) {
          const { resolve: done, timer } = this.pending.get(message.id);
          this.pending.delete(message.id);
          clearTimeout(timer);
          done(message);
          return;
        }
        if (message.type === 'approval.decision' && this.approvals.has(message.id)) {
          const done = this.approvals.get(message.id);
          this.approvals.delete(message.id);
          done(message.choice ?? null);
          return;
        }
        if (message.type === 'event.message') { this.onMessage(message); return; }
        if (message.type === 'event.command') { this.onCommand(message); return; }
      });
      ws.once('error', (error) => { this.log(`[bridge] 连接错误：${error?.message ?? error}`); fail(error); });
      ws.once('close', (code) => {
        this.ws = null;
        for (const { reject: rejectAction, timer } of this.pending.values()) { clearTimeout(timer); rejectAction(new Error('连接已断开')); }
        this.pending.clear();
        if (!settled) fail(new Error(`连接关闭 code=${code}`));
        this.onClose(code);
        if (!this.closed) this.#scheduleReconnect();
      });
    });
  }

  #scheduleReconnect() {
    const delay = this.retry;
    this.retry = Math.min(this.retry * 2, 30000);
    this.log(`[bridge] ${Math.round(delay / 1000)}s 后重连`);
    setTimeout(() => { if (!this.closed) this.connect().catch(() => {}); }, delay).unref?.();
  }

  action(payload) {
    if (!this.ws || this.ws.readyState !== 1) return Promise.reject(new Error('桥未连接'));
    const id = `a${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('动作超时')); }, ACTION_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ ...payload, id }));
    });
  }

  requestApproval({ chatKey, title, detail, options, timeoutMs = 120000 }) {
    if (!this.ws || this.ws.readyState !== 1) return Promise.resolve(null);
    const id = `ap${++this.approvalSeq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.approvals.delete(id); resolve(null); }, timeoutMs);
      this.approvals.set(id, (choice) => { clearTimeout(timer); resolve(choice); });
      this.ws.send(JSON.stringify({ type: 'approval.request', id, chatKey, title, detail, options }));
    });
  }

  sendText(chatKey, text) {
    return this.action({ type: 'action.send', chatKey, text });
  }

  reportUsage(chatKey, sessionId, { inputTokens = 0, outputTokens = 0, contextUsed = 0, contextSize = 0 } = {}) {
    return this.action({ type: 'usage.report', chatKey, sessionId, inputTokens, outputTokens, contextUsed, contextSize }).catch(() => {});
  }

  close() {
    this.closed = true;
    try { this.ws?.close(); } catch { /* 已关闭 */ }
    this.ws = null;
  }
}
