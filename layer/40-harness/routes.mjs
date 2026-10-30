// 追加到控制台的接口：内置 DeepSeek Harness（dsh）的启停。
// 由 overrides/40-luoxi-harness/composition.json 声明，属可信启动组合，
// 不改动出厂 src/ 下任何文件；删掉本目录即恢复原样。
import { createDshRuntime } from './lib/dsh-runtime.mjs';

export function register(http, deps) {
  const runtime = createDshRuntime({ appRoot: deps.appRoot, dataDir: deps.dataDir, log: deps.log });

  http.route('GET', '/api/dsh/status', () => runtime.status());

  http.route('POST', '/api/dsh/start', ({ body }) => {
    const port = Number(body?.port);
    return runtime.start({ open: body?.open !== false, preferredPort: Number.isInteger(port) && port > 1024 ? port : undefined });
  });

  http.route('POST', '/api/dsh/stop', () => runtime.stop());

  http.route('POST', '/api/dsh/open', async () => ({ opened: await runtime.open(), ...runtime.status() }));

  // 控制台/应用退出时带走 dsh，避免留下孤儿进程。
  if (typeof http.onDispose === 'function') http.onDispose(() => runtime.shutdown());
  return undefined;
}
