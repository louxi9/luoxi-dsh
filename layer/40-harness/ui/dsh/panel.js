// DeepSeek Harness 控制页：启停 + 首次依赖安装，不代管模型凭据。
import { request } from '/panels/panel-client.js';

const $ = (id) => document.getElementById(id);
const statusEl = $('status'), factsEl = $('facts'), logEl = $('log');
const startBtn = $('start'), openBtn = $('open'), stopBtn = $('stop'), reloadBtn = $('reload');
const bridgeFacts = $('bridge-facts'), bridgeHint = $('bridge-hint');
const bridgeTokenBtn = $('bridge-token'), bridgeTokenValue = $('bridge-token-value'), bridgeRefreshBtn = $('bridge-refresh');
const modelSelect = $('dsh-model'), permissionSelect = $('dsh-permission'), saveBtn = $('save-model'), saveState = $('save-state');

let disposed = false, busy = false, timer = null, state = null;

function setStatus(text, kind = 'muted') {
  statusEl.textContent = text;
  statusEl.className = `status ${kind}`;
}

function applyButtons() {
  if (!state) return;
  const willOpen = $('pref-open')?.checked !== false;
  startBtn.textContent = state.depsInstalled ? (willOpen ? '启动并打开' : '启动') : '安装并启动';
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
  const mPlugin = $('m-plugin'), mAllow = $('m-allow'), mModes = $('m-modes');
  if (!b) {
    bridgeFacts.replaceChildren(...[['状态', '未启用']].flatMap(([k, v]) => fact(k, v)));
    bridgeHint.textContent = '桥层没有启用（overrides/50-luoxi-bridge），/dsh 命令不会转给 DSH。';
    if (mPlugin) mPlugin.textContent = '未启用';
    if (mAllow) mAllow.textContent = '—';
    if (mModes) mModes.textContent = '—';
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
  if (mPlugin) mPlugin.textContent = b.plugin ? '已连接' : '未连接';
  if (mAllow) mAllow.textContent = b.allow?.chats?.length ? `${b.allow.chats.length} 个会话` : '仅私聊';
  if (mModes) mModes.textContent = `${b.modes?.length ?? 0} 个会话`;
  bridgeHint.textContent = b.plugin
    ? '插件已连上：会话里发 /dsh <任务> 会转给它，/dsh on 进入接管模式。'
    : '插件未连接：用 luoxi-plugin-dsh 连上桥（协议见 docs/luoxi-bridge-protocol.md），或先把 token 给它。';
}

async function refreshConfig() {
  if (disposed) return;
  try {
    const data = await request('GET', '/api/dsh/models');
    if (modelSelect.options.length === 0) {
      for (const item of data.models ?? []) {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = item.label || item.id;
        modelSelect.append(option);
      }
    }
    modelSelect.value = data.model || 'deepseek-flash';
  } catch {
    // 接口不在白名单/宿主还没重启时，别给一个空下拉——写清楚原因。
    if (modelSelect.options.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = '读取失败：重启 QQ Agent 后生效';
      modelSelect.append(option);
    }
  }
  try {
    const bridge = await request('GET', '/api/luoxi/status');
    permissionSelect.value = bridge.permission || 'ask';
  } catch { /* 桥没启用 */ }
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
    // 状态可能被外部改变（QQA 启动时自动拉起 DSH、Dsh 自己退出），ready 之后也要慢轮询。
    const delay = (next.installing || next.phase === 'starting') ? 1500 : 5000;
    if (!document.hidden) timer = setTimeout(refresh, delay);
  } catch (error) {
    if (!disposed) setStatus(error?.message || '读取状态失败。', 'error');
    if (!document.hidden) timer = setTimeout(refresh, 8000);
  }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !disposed) void refresh();
});

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

startBtn.addEventListener('click', () => {
  const willOpen = $('pref-open')?.checked !== false;
  void act('/api/dsh/start', { open: willOpen });
});
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
saveBtn.addEventListener('click', async () => {
  if (disposed) return;
  saveBtn.disabled = true;
  saveState.textContent = '保存中…';
  try {
    const model = modelSelect.value;
    const permission = permissionSelect.value;
    await request('POST', '/api/dsh/models', { model });
    await request('POST', '/api/luoxi/config', { permission });
    // 权限/模型都在插件或新会话上生效，重启插件最省事。
    await request('POST', '/api/luoxi/plugin', { action: 'stop' });
    await request('POST', '/api/luoxi/plugin', { action: 'start' });
    saveState.textContent = `已保存并重启插件：${model} · ${permission}`;
    void refresh();
  } catch (error) {
    saveState.textContent = error?.message || '保存失败';
  } finally {
    saveBtn.disabled = false;
  }
});

// 面板跑在沙箱 iframe 里，localStorage 可能直接抛 SecurityError——
// 读写全部包起来，读失败就用默认值，绝不让它中断后面的初始化。
const store = {
  get(key, fallback) {
    try { const value = localStorage.getItem(key); return value == null ? fallback : value; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* 沙箱里禁用，忽略 */ }
  },
};

const navItems = [...document.querySelectorAll('.nav-item')];
const tabs = [...document.querySelectorAll('.tab')];
let currentTab = 'overview';
function showTab(id, persist = false) {
  currentTab = id;
  for (const item of navItems) item.classList.toggle('on', item.dataset.tab === id);
  for (const tab of tabs) tab.hidden = tab.dataset.tab !== id;
  store.set('dsh.tab', id);
  if (persist) void request('POST', '/api/dsh/ui', { tab: id }).catch(() => {});
  if (id === 'chat') { void loadSessions(); void loadWorkspace(); }
  if (id === 'plugins') void loadPlugins();
}
for (const item of navItems) item.addEventListener('click', () => showTab(item.dataset.tab, true));
showTab('overview');

const skinButtons = [...document.querySelectorAll('.skin button')];
let currentSkin = 'solid';
function applySkin(name, persist = false) {
  currentSkin = ['solid', 'dim', 'glass'].includes(name) ? name : 'solid';
  document.body.dataset.skin = currentSkin;
  for (const button of skinButtons) button.classList.toggle('on', button.dataset.skin === currentSkin);
  store.set('dsh.skin', currentSkin);
  if (persist) void request('POST', '/api/dsh/ui', { skin: currentSkin }).catch(() => {});
}
for (const button of skinButtons) button.addEventListener('click', () => applySkin(button.dataset.skin, true));
applySkin('solid');

// ---- 对话：左侧会话列表 + 右侧当前会话（每条会话一份独立存档） ----
const chatLog = $('chat-log'), chatInput = $('chat-input');
const chatSessionsEl = $('chat-sessions'), chatNewBtn = $('chat-new');
const chatWsPath = $('chat-ws-path'), chatWsToggle = $('chat-ws-toggle'), chatWsEdit = $('chat-ws-edit');
const chatWsInput = $('chat-ws-input'), chatWsApply = $('chat-ws-apply'), chatWsCancel = $('chat-ws-cancel'), chatWsHint = $('chat-ws-hint');
let chatKey = '', chatWorkspace = '', chatPolling = false, chatSeen = 0, traceSeen = 0, chatList = [];
const seenTraces = new Map(); // 合并后的工具轨迹（按 id），轮询时用来原地更新状态
const openTraces = new Set(); // 用户展开过的单条轨迹（重绘时保持）
const openGroups = new Set(); // 用户展开过的工具组

function chatBubble(kind, text) {
  const el = document.createElement('div');
  el.className = `bubble ${kind}`;
  el.textContent = text;
  chatLog.append(el);
  chatLog.scrollTop = chatLog.scrollHeight;
  return el;
}

function ago(ts) {
  const diff = Date.now() - Number(ts || 0);
  if (!Number.isFinite(diff) || diff < 0) return '';
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时`;
  return `${Math.floor(hour / 24)} 天`;
}

function renderSessionList() {
  if (!chatSessionsEl) return;
  chatSessionsEl.replaceChildren();
  for (const item of chatList) {
    const li = document.createElement('li');
    if (item.chatKey === chatKey) li.className = 'on';
    const title = document.createElement('span');
    title.className = 't';
    title.textContent = item.title || '新会话';
    const meta = document.createElement('span');
    meta.className = 'm';
    meta.textContent = ago(item.ts);
    li.append(title, meta);
    li.addEventListener('click', () => void selectSession(item.chatKey));
    chatSessionsEl.append(li);
  }
}

async function loadSessions() {
  try {
    const data = await request('GET', '/api/dsh-panel/sessions');
    chatList = Array.isArray(data?.sessions) ? data.sessions : [];
  } catch { chatList = []; }
  if (!chatKey) chatKey = chatList[0]?.chatKey || '';
  // 刚新建的会话还没有消息存档，服务端列不出来——补一条占位，
  // 否则会把当前会话重置回第一条，看起来像"点了没反应"。
  if (chatKey && !chatList.some((item) => item.chatKey === chatKey)) {
    chatList.unshift({ chatKey, title: '新会话', ts: Date.now(), count: 0 });
  }
  renderSessionList();
  if (!chatKey) await createSession();
}

async function createSession() {
  try {
    const data = await request('POST', '/api/dsh-panel/sessions', {});
    chatKey = String(data?.chatKey || '');
    chatSeen = 0;
    if (chatLog) chatLog.replaceChildren();
    chatList = [{ chatKey, title: '新会话', ts: Date.now(), count: 0 }, ...chatList.filter((item) => item.chatKey !== chatKey)];
    renderSessionList();
    chatInput?.focus();
  } catch (error) {
    chatBubble('error', error?.message || '新建会话失败');
  }
}

async function selectSession(key) {
  if (!key || key === chatKey) return;
  chatKey = key;
  renderSessionList();
  await loadChat();
}

async function loadWorkspace() {
  if (!chatWsPath) return;
  try {
    const bridge = await request('GET', '/api/luoxi/status');
    chatWorkspace = String(bridge.workspace || '');
    chatWsPath.textContent = chatWorkspace || '默认（data/dsh-workspace）';
    chatWsPath.title = chatWorkspace;
  } catch {
    chatWsPath.textContent = '（桥没有启用）';
  }
}

async function loadChat() {
  if (!chatLog || !chatKey) return;
  let rows = [];
  let traces = [];
  try {
    rows = (await request('POST', '/api/dsh-panel/history', { chatKey }))?.messages ?? [];
  } catch { /* 历史读不到就空着 */ }
  try {
    traces = (await request('POST', '/api/dsh-panel/trace', { chatKey, since: 0 }))?.events ?? [];
  } catch { /* 轨迹读不到就只显示消息 */ }
  const merged = mergeTrace(traces);
  renderFeed(rows, merged);
  chatSeen = rows.length;
  traceSeen = traces.reduce((max, t) => Math.max(max, Number(t.ts) || 0), 0);
  seenTraces.clear();
  for (const item of merged) seenTraces.set(traceId(item), item);
}

function traceId(t) { return String(t.id || t.ts); }

// 同一工具的开始/结束合并成一条：start 留开始时间，end 补状态和输出。
function mergeTrace(list) {
  const map = new Map();
  for (const item of list) {
    const id = String(item.id || item.ts);
    const prev = map.get(id);
    if (!prev) { map.set(id, { ...item, endTs: 0 }); continue; }
    prev.phase = item.phase === 'end' ? 'end' : prev.phase;
    prev.status = item.status || prev.status;
    if (item.output) prev.output = item.output;
    if (!prev.title && item.title) prev.title = item.title;
    if (!prev.input && item.input) prev.input = item.input;
    if (item.phase === 'end') prev.endTs = Number(item.ts) || 0;
  }
  return [...map.values()];
}

function traceCard(t, open = false) {
  const failed = t.status === 'failed';
  const running = t.phase === 'start' && !failed;
  const el = document.createElement('div');
  el.className = `trace ${failed ? 'failed' : running ? 'run' : 'done'}`;
  el.dataset.traceId = traceId(t);
  el.dataset.phase = t.phase || '';
  el.dataset.open = open ? '1' : '';

  const head = document.createElement('div');
  head.className = 'trace-head';
  const caret = document.createElement('span');
  caret.className = 'trace-caret';
  caret.textContent = open ? '▾' : '▸';
  const icon = document.createElement('span');
  icon.className = 'trace-icon';
  icon.textContent = failed ? '✕' : running ? '●' : '✓';
  const title = document.createElement('span');
  title.className = 'trace-title';
  title.textContent = (running ? '执行中 · ' : '') + (t.title || '工具调用');
  const meta = document.createElement('span');
  meta.className = 'trace-meta';
  if (t.endTs && t.ts) meta.textContent = `${((t.endTs - t.ts) / 1000).toFixed(1)}s`;
  head.append(caret, icon, title, meta);

  const body = document.createElement('div');
  body.className = 'trace-body';
  if (t.input) { const pre = document.createElement('pre'); pre.className = 'trace-pre'; pre.textContent = t.input; body.append(pre); }
  if (t.output) { const pre = document.createElement('pre'); pre.className = 'trace-pre'; pre.textContent = t.output; body.append(pre); }
  if (!t.input && !t.output) { const hint = document.createElement('div'); hint.className = 'trace-empty'; hint.textContent = '（这条没有更多细节）'; body.append(hint); }
  body.hidden = !open;

  head.addEventListener('click', () => {
    body.hidden = !body.hidden;
    el.dataset.open = body.hidden ? '' : '1';
    caret.textContent = body.hidden ? '▸' : '▾';
    if (body.hidden) openTraces.delete(el.dataset.traceId);
    else openTraces.add(el.dataset.traceId);
  });
  el.append(head, body);
  return el;
}

// 连续的工具调用合成一组，默认收起——否则一个任务几十条会把会话拉得很长。
function traceGroup(list) {
  const el = document.createElement('div');
  el.className = 'trace-group';
  const key = `g-${traceId(list[0])}`;
  const open = openGroups.has(key);
  let total = 0;
  for (const t of list) if (t.endTs && t.ts) total += t.endTs - t.ts;
  const head = document.createElement('div');
  head.className = 'trace-group-head';
  const caret = document.createElement('span');
  caret.className = 'trace-caret';
  caret.textContent = open ? '▾' : '▸';
  const label = document.createElement('span');
  label.className = 'trace-group-title';
  label.textContent = `执行了 ${list.length} 个工具${total ? ` · ${(total / 1000).toFixed(1)}s` : ''}`;
  head.append(caret, label);
  const body = document.createElement('div');
  body.className = 'trace-group-body';
  body.hidden = !open;
  for (const t of list) body.append(traceCard(t, openTraces.has(traceId(t))));
  head.addEventListener('click', () => {
    body.hidden = !body.hidden;
    caret.textContent = body.hidden ? '▸' : '▾';
    if (body.hidden) openGroups.delete(key);
    else openGroups.add(key);
  });
  el.append(head, body);
  return el;
}

function renderFeed(rows, traces) {
  const atBottom = chatLog.scrollTop + chatLog.clientHeight >= chatLog.scrollHeight - 30;
  const items = [
    ...rows.map((row) => ({ ts: Number(row.ts) || 0, kind: row.self ? 'pet' : 'user', text: String(row.text ?? '') })),
    ...traces.map((t) => ({ ts: Number(t.ts) || 0, kind: 'trace', trace: t })),
  ].sort((a, b) => a.ts - b.ts);

  chatLog.replaceChildren();
  let run = [];
  const flush = () => {
    if (!run.length) return;
    if (run.length === 1) chatLog.append(traceCard(run[0], openTraces.has(traceId(run[0]))));
    else chatLog.append(traceGroup(run));
    run = [];
  };
  for (const item of items) {
    if (item.kind === 'trace') { run.push(item.trace); continue; }
    flush();
    chatBubble(item.kind, item.text);
  }
  flush();
  if (atBottom) chatLog.scrollTop = chatLog.scrollHeight;
}

async function pollChat(placeholder = null) {
  if (chatPolling) return;
  chatPolling = true;
  const watching = chatKey;
  let idle = 0;
  let signature = '';
  let cleared = false;
  const clearPlaceholder = () => { if (!cleared && placeholder) { cleared = true; placeholder.remove(); } };
  try {
    while (idle < 40) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      if (chatKey !== watching) break;
      let rows = [];
      let traces = [];
      try {
        rows = (await request('POST', '/api/dsh-panel/history', { chatKey: watching }))?.messages ?? [];
      } catch { idle += 1; continue; }
      try {
        traces = (await request('POST', '/api/dsh-panel/trace', { chatKey: watching, since: 0 }))?.events ?? [];
      } catch { /* 轨迹读不到就先只看消息 */ }
      const merged = mergeTrace(traces);
      const nextSignature = `${rows.length}:${merged.map((t) => `${t.phase}${t.status}${t.endTs ? 'e' : ''}`).join('|')}`;
      if (nextSignature !== signature) {
        signature = nextSignature;
        renderFeed(rows, merged);
        if (rows.some((row) => row.self)) clearPlaceholder();
        idle = 0;
      } else {
        idle += 1;
      }
      chatSeen = rows.length;
      traceSeen = traces.reduce((max, t) => Math.max(max, Number(t.ts) || 0), 0);
      for (const item of merged) seenTraces.set(traceId(item), item);
    }
  } finally {
    chatPolling = false;
    clearPlaceholder();
  }
}


async function sendChat() {
  const text = chatInput.value.trim();
  if (!text) return;
  if (!chatKey) await createSession();
  if (!chatKey) return;
  chatInput.value = '';
  chatBubble('user', text);
  const typing = chatBubble('typing', '正在想…');
  try {
    const result = await request('POST', '/api/dsh-panel/chat', { text, chatKey });
    typing.remove();
    if (result?.handedOff) {
      // 面板/桌宠是本机窗口，不需要"已交给 DSH"这句提示——让 typing 气泡留到回复到达。
      void pollChat(typing);
    } else {
      chatBubble('pet', String(result?.reply ?? '').trim() || '（没有回复）');
    }
  } catch (error) {
    typing.remove();
    chatBubble('error', error?.message || '发送失败');
  } finally {
    chatInput.focus();
    void loadSessions();
  }
}

chatWsToggle?.addEventListener('click', () => {
  chatWsEdit.hidden = false;
  chatWsInput.value = chatWorkspace;
  chatWsInput.focus();
  chatWsInput.select();
});
chatWsCancel?.addEventListener('click', () => { chatWsEdit.hidden = true; chatWsHint.textContent = ''; });
chatWsApply?.addEventListener('click', async () => {
  const value = chatWsInput.value.trim();
  if (!value) return;
  chatWsApply.disabled = true;
  chatWsHint.textContent = '保存并重启插件…';
  try {
    await request('POST', '/api/luoxi/config', { workspace: value });
    await request('POST', '/api/luoxi/plugin', { action: 'stop' });
    await request('POST', '/api/luoxi/plugin', { action: 'start' });
    chatWsHint.textContent = '已切换，已开一个新会话';
    chatWsEdit.hidden = true;
    await loadWorkspace();
    chatKey = '';
    await loadSessions();
  } catch (error) {
    chatWsHint.textContent = error?.message || '切换失败';
  } finally {
    chatWsApply.disabled = false;
  }
});

chatNewBtn?.addEventListener('click', () => void createSession());
$('chat-send')?.addEventListener('click', () => void sendChat());
chatInput?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    void sendChat();
  }
});

// 界面偏好（皮肤 / 上次分页 / 启动弹窗）存在宿主侧——沙箱 iframe 里 localStorage 不可用。
const prefOpen = $('pref-open');
const prefAutostart = $('pref-autostart');
prefOpen?.addEventListener('change', () => {
  void request('POST', '/api/dsh/ui', { autoOpen: prefOpen.checked }).catch(() => {});
  applyButtons();
});
prefAutostart?.addEventListener('change', () => {
  void request('POST', '/api/dsh/ui', { autoStartDsh: prefAutostart.checked }).catch(() => {});
});
void (async () => {
  try {
    const ui = await request('GET', '/api/dsh/ui');
    if (ui?.skin) applySkin(ui.skin);
    if (ui?.tab && ui.tab !== currentTab) showTab(ui.tab);
    if (prefOpen) prefOpen.checked = ui?.autoOpen !== false;
    if (prefAutostart) prefAutostart.checked = ui?.autoStartDsh === true;
  } catch { /* 读不到就用默认 */ }
})();



// ---- 插件：内置 bundle 启停 + 自由安装（走 dsh plugin，带预检回滚） ----
const pluginBundlesEl = $('plugin-bundles');
const pluginNameInput = $('plugin-name');
const pluginOutputEl = $('plugin-output');
const pluginHintEl = $('plugin-hint');
let pluginBusy = false;

async function loadPlugins() {
  if (!pluginBundlesEl) return;
  try {
    const data = await request('GET', '/api/dsh/plugins');
    pluginBundlesEl.replaceChildren();
    for (const item of data.candidates ?? []) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'p-name';
      name.textContent = String(item.name).replace('@deepseek-ai/', '');
      const ver = document.createElement('span');
      ver.className = 'p-ver';
      ver.textContent = item.version ? `v${item.version}` : '';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = item.enabled ? 'on' : '';
      btn.textContent = item.enabled ? '已启用' : '启用';
      btn.addEventListener('click', () => void toggleBundle(item, !item.enabled, btn));
      li.append(name, ver, btn);
      if (item.description) {
        const desc = document.createElement('span');
        desc.className = 'p-desc';
        desc.textContent = String(item.description).slice(0, 90);
        li.append(desc);
      }
      pluginBundlesEl.append(li);
    }
    if (pluginHintEl) pluginHintEl.textContent = data.profile ? `profile：${data.profile}` : '';
  } catch (error) {
    if (pluginHintEl) pluginHintEl.textContent = error?.message || '读取插件列表失败';
  }
}

async function toggleBundle(item, enabled, btn) {
  if (pluginBusy) return;
  pluginBusy = true;
  btn.disabled = true;
  try {
    const data = await request('POST', '/api/dsh/plugins', { action: 'toggle', name: item.name, enabled });
    item.enabled = enabled;
    btn.textContent = enabled ? '已启用' : '启用';
    btn.className = enabled ? 'on' : '';
    if (pluginHintEl) pluginHintEl.textContent = data?.note || '已保存';
  } catch (error) {
    if (pluginHintEl) pluginHintEl.textContent = error?.message || '操作失败';
  } finally {
    pluginBusy = false;
    btn.disabled = false;
  }
}

async function runPluginAction(action) {
  if (pluginBusy) return;
  const name = String(pluginNameInput?.value ?? '').trim();
  if (!name) return;
  pluginBusy = true;
  if (pluginOutputEl) {
    pluginOutputEl.hidden = false;
    pluginOutputEl.textContent = action === 'add' ? `正在安装 ${name}（可能要几十秒）…` : `正在卸载 ${name}…`;
  }
  try {
    const data = await request('POST', '/api/dsh/plugins', { action, name });
    if (pluginOutputEl) {
      const head = data?.ok ? (data?.note || '完成') : (data?.error || '失败');
      pluginOutputEl.textContent = `${head}\n\n${String(data?.output || '').trim()}`.trim();
    }
    if (pluginHintEl) pluginHintEl.textContent = data?.ok ? '已完成，重启插件后生效' : '操作失败（看上面的输出）';
    await loadPlugins();
  } catch (error) {
    if (pluginOutputEl) pluginOutputEl.textContent = error?.message || '请求失败';
  } finally {
    pluginBusy = false;
  }
}

$('plugin-add')?.addEventListener('click', () => void runPluginAction('add'));
$('plugin-remove')?.addEventListener('click', () => void runPluginAction('remove'));
pluginNameInput?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') { event.preventDefault(); void runPluginAction('add'); }
});

void loadSessions();


void refresh();
void refreshBridge();
void refreshConfig();
