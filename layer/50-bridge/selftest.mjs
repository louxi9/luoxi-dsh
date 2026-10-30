// 桥自检：不启动宿主，只验证协议与命令路由。
// 用法：node overrides/50-luoxi-bridge/selftest.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createBridge } from './lib/bridge.mjs';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luoxi-bridge-test-'));
fs.mkdirSync(path.join(dataDir, 'bridge'), { recursive: true });
fs.writeFileSync(path.join(dataDir, 'bridge', 'config.json'), JSON.stringify({ port: 0, ack: true, autoStart: false, allow: { chats: [], users: [] } }), 'utf8');

const sent = [];
const bridge = createBridge({ dataDir, log: null });
bridge.setSend({ async sendTextBatch(chatKey, texts) { sent.push({ chatKey, text: texts[0] }); } });
bridge.start();

const wait = (ms) => new Promise(r => setTimeout(r, ms));
for (let i = 0; i < 50 && !bridge.describe().listening; i += 1) await wait(50);
const status = bridge.describe();
if (!status.listening) { console.error('FAIL 桥没有监听'); process.exit(1); }
console.log('listening on', status.port);

const ws = new WebSocket(`ws://127.0.0.1:${status.port}`);
const events = [];
ws.on('message', (data) => events.push(JSON.parse(String(data))));
await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
ws.send(JSON.stringify({ type: 'hello', token: bridge.token(), protocol: 1, plugin: { name: 'fake-plugin', version: '0.0.1' } }));
await wait(200);
if (!events.find(e => e.type === 'hello.ok')) { console.error('FAIL hello 没有通过'); process.exit(2); }
console.log('hello ok');

const message = (text, chatKey = 'private:10001', senderId = '10001') => bridge.handleMessage({
  accepted: true,
  chatKey,
  entry: { text, senderId, senderName: 'tester' },
});

if (!await message('/dsh 帮我看看这个项目')) { console.error('FAIL 命令没被接管'); process.exit(3); }
await wait(150);
const forwarded = events.find(e => e.type === 'event.message');
if (!forwarded || forwarded.text !== '帮我看看这个项目') { console.error('FAIL 没有把任务转给插件', forwarded); process.exit(4); }
if (!sent.find(s => s.text.includes('处理中'))) { console.error('FAIL 没有回执'); process.exit(5); }
console.log('oneshot -> plugin:', JSON.stringify(forwarded.text));

ws.send(JSON.stringify({ type: 'action.send', id: 'a1', chatKey: 'private:10001', text: '来自 DSH 的回答' }));
await wait(150);
if (!sent.find(s => s.text === '来自 DSH 的回答')) { console.error('FAIL 插件回话没有走发送队列'); process.exit(6); }
if (!events.find(e => e.type === 'result' && e.id === 'a1' && e.ok)) { console.error('FAIL action.send 没有回 result'); process.exit(7); }
console.log('action.send ok');

await message('/dsh on');
if (bridge.describe().modes[0]?.mode !== 'sticky') { console.error('FAIL /dsh on 没进粘性模式'); process.exit(8); }
await message('那继续改一下配置');
await wait(150);
const sticky = events.filter(e => e.type === 'event.message').pop();
if (sticky?.mode !== 'sticky') { console.error('FAIL 粘性消息没转给插件'); process.exit(9); }
await message('/dsh off');
if (bridge.describe().modes.length !== 0) { console.error('FAIL /dsh off 没退出'); process.exit(10); }
console.log('sticky on/off ok');

// 审批：插件发起 → 会话 收到选项 → 用户回 1 → 决策回去
sent.length = 0;
ws.send(JSON.stringify({ type: 'approval.request', id: 'ap1', chatKey: 'private:10001', title: '写文件 a.txt', options: [{ id: 'allow', label: '允许' }, { id: 'deny', label: '拒绝' }] }));
await wait(200);
if (!sent.find(s => String(s.text).includes('1. 允许'))) { console.error('FAIL 审批没有发到 会话', sent); process.exit(13); }
await message('1');
await wait(200);
const decision = events.find(e => e.type === 'approval.decision');
if (decision?.choice !== 'allow') { console.error('FAIL 审批决定没有回给插件', decision); process.exit(14); }
if (!sent.find(s => String(s.text).includes('已选择'))) { console.error('FAIL 审批没有回执'); process.exit(15); }
console.log('approval ok');

const denied = await bridge.handleMessage({ accepted: true, chatKey: 'group:999', entry: { text: '/dsh rm -rf /', senderId: '20002' } });
if (!denied) { console.error('FAIL 群里的命令没有被吞掉'); process.exit(11); }
await wait(100);
if (events.filter(e => e.type === 'event.message').length !== 2) { console.error('FAIL 未放行的群命令被转发了'); process.exit(12); }
console.log('group denied ok');

ws.close();
bridge.stop();
fs.rmSync(dataDir, { recursive: true, force: true });
console.log('PASS');
