// 桥的管理接口：面板读状态、复制 token、改放行名单。
import { createBridge } from './lib/bridge.mjs';
import { holder } from './lib/holder.mjs';

const bad = (message, status = 400) => Object.assign(new Error(message), { expose: true, status });

export function register(http, deps) {
  if (!deps?.dataDir) throw bad('缺少数据目录');
  const bridge = createBridge({ dataDir: deps.dataDir, appRoot: deps.appRoot, log: deps.log });
  holder.bridge = bridge;
  if (holder.send) bridge.setSend(holder.send);
  bridge.start();

  http.route('GET', '/api/luoxi/status', () => bridge.describe());
  http.route('GET', '/api/luoxi/token', () => ({ token: bridge.token() }));
  http.route('POST', '/api/luoxi/config', ({ body }) => bridge.updateConfig(body ?? {}));
  http.route('POST', '/api/luoxi/plugin', ({ body }) => {
    if (body?.action === 'stop') { bridge.stopPlugin(); return { ok: true, ...bridge.describe() }; }
    bridge.startPlugin();
    return { ok: true, ...bridge.describe() };
  });
  http.route('POST', '/api/luoxi/mode', ({ body }) => {
    const chatKey = String(body?.chatKey ?? '');
    if (!chatKey) throw bad('缺少 chatKey');
    return bridge.setMode(chatKey, body?.mode === 'sticky' ? 'sticky' : 'off');
  });

  if (typeof http.onDispose === 'function') http.onDispose(() => { bridge.stop(); holder.bridge = null; });
  return undefined;
}
