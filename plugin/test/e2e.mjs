// 端到端：假 洛希桥 + 真 dsh acp + 插件本体。
// 用法：node luoxi-plugin-dsh/test/e2e.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const plugin = path.resolve(here, '..', 'bin', 'luoxi.mjs');
const root = path.resolve(here, '..', '..');
const dshBin = process.env.LUOXI_DSH_BIN ?? path.join(root, 'runtime', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const nodeExe = process.env.LUOXI_NODE ?? path.join(root, 'runtime', 'dsh', 'node', 'node.exe');
const token = 'test-token-123';
const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'luoxi-home-'));
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'luoxi-ws-'));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const received = [];
const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise(resolve => wss.once('listening', resolve));
const port = wss.address().port;

wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data));
    if (msg.type === 'hello') {
      if (msg.token !== token) { ws.close(4001, 'bad token'); return; }
      ws.send(JSON.stringify({ type: 'hello.ok', protocol: 1, commands: { prefix: '/dsh' }, bot: { name: 'fake-host' } }));
      setTimeout(() => ws.send(JSON.stringify({
        type: 'event.message', seq: 1,
        chat: { key: 'private:10001', type: 'private' },
        sender: { id: '10001', name: 'tester' },
        text: '只回复 ok 两个字母', mode: 'oneshot', at: Date.now(),
      })), 300);
      return;
    }
    if (msg.type === 'action.send') {
      received.push(msg);
      ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: true }));
    }
  });
});

const child = spawn(nodeExe, [
  plugin, '--bridge', `ws://127.0.0.1:${port}`, '--token', token,
  '--workspace', workspace, '--dsh', dshBin, '--node', nodeExe, '--dsh-home', dataHome,
], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
let output = '';
child.stdout.on('data', (d) => { output += d; });
child.stderr.on('data', (d) => { output += d; });

let passed = false;
for (let i = 0; i < 120; i += 1) {
  await sleep(1000);
  if (received.length) { passed = true; break; }
  if (child.exitCode !== null) break;
}

const text = received[0]?.text ?? '';
console.log('--- 插件输出 ---');
console.log(output.trim().split('\n').slice(-12).join('\n'));
console.log('--- 回给 会话 ---');
console.log(JSON.stringify(text));

child.kill();
try { wss.close(); } catch { /* 已关闭 */ }
fs.rmSync(dataHome, { recursive: true, force: true });
fs.rmSync(workspace, { recursive: true, force: true });

if (!passed) { console.error('FAIL 没收到 action.send'); process.exit(1); }
if (!/ok/i.test(text)) { console.error('FAIL 回复里没有 ok'); process.exit(2); }
console.log('PASS');
