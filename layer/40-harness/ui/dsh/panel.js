// DeepSeek Harness 控制页：启停 + 首次依赖安装，不代管模型凭据。
import { request } from '/panels/panel-client.js';

const $ = (id) => document.getElementById(id);
const statusEl = $('status'), factsEl = $('facts'), logEl = $('log');
const startBtn = $('start'), openBtn = $('open'), stopBtn = $('stop'), reloadBtn = $('reload');
const bridgeFacts = $('bridge-facts'), bridgeHint = $('bridge-hint');
const bridgeTokenBtn = $('bridge-token'), bridgeTokenValue = $('bridge-token-value'), bridgeRefreshBtn = $('bridge-refresh');

let disposed = false, busy = false, timer = null, state = null;

function setStatus(text, kind = 'muted') {
  statusEl.textContent = text;
  statusEl.className = kind;
}

function applyButtons() {
  if (!state) return;
  startBtn.textContent = state.depsInstalled ? '启动并打开' : '安装并启动';
  startBtn.disabled = busy || !state.runtimeReady || state.installing || state.phase === 'ready' || state.phase === 'starting';
  openBtn.disabled = busy || state.phase !== 'ready';
  stopBtn.disabled = busy || state.phase === 'stopped';
}

function fact(label, value) {
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.textContent = value || '—';
  return [dt, dd];
}

function seconds(ms) {
  return Math.max(0, Math.round(Number(ms || 0) / 1000));
}

function render(next) {
  state = next;
  const rows = [
    ['状态', next.phase === 'ready' ? '已就绪' : next.phase === 'starting' ? '启动中…' : next.phase === 'installing' ? '安装依赖中…' : next.phase === 'error' ? '出错' : '未启动'],
    ['依赖', next.depsInstalled ? '已安装' : '未安装（首次启动自动下载）'],
    ['node', next.node],
    ['dsh', next.dsh ? `v${next.dsh}` : ''],
    ['地址', next.url],
    ['目录', next.runtimeRoot],
  ];
  factsEl.replaceChildren(...rows.flatMap(([label, value]) => fact(label, value)));
  logEl.textContent = (next.tail || []).join('\n') || '（暂无日志）';
  logEl.scrollTop = logEl.scrollHeight;

  if (!next.runtimeReady) setStatus('缺少 runtime/dsh（node.exe / npm / package-lock.json），请重新解压便携包。', 'error');
  else if (next.installing) setStatus(`正在安装依赖 · ${next.installStep || '准备中'}（已用 ${seconds(next.installElapsedMs)} 秒，约 1–2 分钟）`, 'busy');
  else if (next.phase === 'ready') setStatus(next.windowOpen ? `运行中 · ${next.url}（窗口已打开）` : `运行中 · ${next.url}（窗口已关，点「打开窗口」再开）`, 'ok');
  else if (next.phase === 'starting') setStatus('正在启动 DeepSeek Harness，首次启动需要几十秒…', 'busy');
  else if (next.phase === 'error') setStatus(next.error || next.installError || 'DeepSeek Harness 启动失败。', 'error');
  else if (!next.depsInstalled) setStatus('依赖未安装。点「安装并启动」会从 npm 源下载约 835MB 依赖（1–2 分钟）。', 'muted');
  else setStatus('未启动。点「启动并打开」拉起内置的 dsh。', 'muted');
  applyButtons();
}

function renderBridge(b) {
  if (!b) {
    bridgeFacts.replaceChildren(...[['状态', '未启用']].flatMap(([k, v]) => fact(k, v)));
    bridgeHint.textContent = '桥层没有启用（overrides/50-luoxi-bridge），/dsh 命令不会转给 DSH。';
    return;
  }
  const plugin = b.plugin ? `${b.plugin.name}${b.plugin.version ? ' v' + b.plugin.version : ''}` : '未连接';
  const rows = [
    ['状态', b.listening ? '监听中' : '未监听'],
    ['插件', plugin],
    ['端口', String(b.port ?? '')],
    ['放行', b.allow?.chats?.length ? `${b.allow.chats.length} 个会话` : '仅私聊（未加群）'],
    ['接管', `${b.modes?.length ?? 0} 个会话`],
    ['自动', b.autoStart ? (b.process ? `已拉起 pid ${b.process.pid}` : '开（等待拉起）') : '关'],
    ['审批', b.approvals?.length ? `${b.approvals.length} 条待回复` : '无'],
  ];
  bridgeFacts.replaceChildren(...rows.flatMap(([k, v]) => fact(k, v)));
  bridgeHint.textContent = b.plugin
    ? '插件已连上：会话里发 /dsh <任务> 会转给它，/dsh on 进入接管模式。'
    : '插件未连接：用 luoxi-plugin-dsh 连上桥（协议见 docs/luoxi-bridge-protocol.md），或先把 token 给它。';
}

async function refreshBridge() {
  if (disposed) return;
  try { renderBridge(await request('GET', '/api/luoxi/status')); }
  catch { renderBridge(null); }
}

async function refresh() {
  if (disposed) return;
  clearTimeout(timer);
  try {
    const next = await request('GET', '/api/dsh/status');
    if (disposed) return;
    render(next);
    void refreshBridge();
    if (next.installing || next.phase === 'starting') timer = setTimeout(refresh, 1500);
  } catch (error) {
    if (!disposed) setStatus(error?.message || '读取状态失败。', 'error');
  }
}

async function act(path, body) {
  if (busy || disposed) return;
  busy = true;
  applyButtons();
  try {
    const next = await request('POST', path, body);
    if (!disposed) render(next);
  } catch (error) {
    if (!disposed) setStatus(error?.message || '操作失败。', 'error');
  } finally {
    busy = false;
    if (!disposed) {
      applyButtons();
      clearTimeout(timer);
      timer = setTimeout(refresh, 1200);
    }
  }
}

startBtn.addEventListener('click', () => void act('/api/dsh/start', { open: true }));
openBtn.addEventListener('click', () => void act('/api/dsh/open'));
stopBtn.addEventListener('click', () => void act('/api/dsh/stop'));
reloadBtn.addEventListener('click', () => void refresh());
bridgeRefreshBtn.addEventListener('click', () => void refreshBridge());
bridgeTokenBtn.addEventListener('click', async () => {
  if (!bridgeTokenValue.hidden) { bridgeTokenValue.hidden = true; bridgeTokenValue.textContent = ''; bridgeTokenBtn.textContent = '显示 token'; return; }
  try {
    const { token } = await request('GET', '/api/luoxi/token');
    bridgeTokenValue.textContent = String(token ?? '');
    bridgeTokenValue.hidden = false;
    bridgeTokenBtn.textContent = '隐藏 token';
  } catch { setStatus('读取 token 失败：桥没有启用。', 'error'); }
});

function dispose() {
  if (disposed) return;
  disposed = true;
  clearTimeout(timer);
}

window.addEventListener('pagehide', dispose);
void refresh();
void refreshBridge();
