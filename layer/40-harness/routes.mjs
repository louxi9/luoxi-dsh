// 追加到控制台的接口：内置 DeepSeek Harness（dsh）的启停、模型选择。
// 由 overrides/40-luoxi-harness/composition.json 声明，属可信启动组合，
// 不改动出厂 src/ 下任何文件；删掉本目录即恢复原样。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import yaml from 'js-yaml';
import { createDshRuntime } from './lib/dsh-runtime.mjs';

const bad = (message, status = 400) => Object.assign(new Error(message), { expose: true, status });

// dsh 内置模型目录（llm-deepseek-api-key 的默认 catalog）；provider 固定官方路由。
const MODELS = [
  { id: 'deepseek-flash', label: 'deepseek-flash（快）' },
  { id: 'deepseek-v4-pro', label: 'deepseek-v4-pro（强）' },
];
const DEFAULT_MODEL = { provider: 'deepseek-official', model: 'deepseek-flash' };
const AGENT_MODEL_ID = 'agent-default-model';

export function register(http, deps) {
  const runtime = createDshRuntime({ appRoot: deps.appRoot, dataDir: deps.dataDir, log: deps.log });

  // 模型选择写进 dsh 的 profile patch（acp 是插件用的那份），
  // 这样新建的会话用所选模型；已存在的会话不受影响。
  // ---- 插件管理：内置 bundle 直接改配置；自由包交给 dsh plugin（转发 pnpm）+ 预检回滚 ----
  const runtimeRoot = path.join(deps.appRoot, 'runtime', 'dsh');
  const dshNode = path.join(runtimeRoot, 'node', 'node.exe');
  const dshBin = path.join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  const dshHome = path.join(deps.dataDir, 'dsh-home');
  const BUNDLE_CANDIDATES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app', '@deepseek-ai/dsh-web-app'];

  const profilePkgPath = () => path.join(dshHome, 'profiles', 'acp', 'package.json');
  const readProfilePkg = () => {
    try {
      return JSON.parse(fs.readFileSync(profilePkgPath(), 'utf8'));
    } catch {
      return { name: 'dsh-profile-acp', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } };
    }
  };
  const writeProfilePkg = (pkg) => {
    fs.mkdirSync(path.dirname(profilePkgPath()), { recursive: true });
    fs.writeFileSync(profilePkgPath(), `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  };
  const getBundles = (pkg) => (Array.isArray(pkg?.dsh?.profile?.bundles) ? [...pkg.dsh.profile.bundles] : []);
  const setBundles = (pkg, list) => {
    pkg.dsh = pkg.dsh ?? {};
    pkg.dsh.profile = pkg.dsh.profile ?? {};
    pkg.dsh.profile.bundles = list;
    return pkg;
  };
  const readLocalPackage = (name) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'node_modules', ...name.split('/'), 'package.json'), 'utf8'));
    } catch { return null; }
  };

  function runDshCli(args, timeoutMs = 120000) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(dshNode, [dshBin, ...args], {
          env: { ...process.env, DSH_HOME: dshHome },
          cwd: runtimeRoot,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        resolve({ code: -1, out: '', err: String(error?.message ?? error) });
        return;
      }
      let out = '';
      let err = '';
      const cap = (text, chunk) => (text + chunk).slice(-20000);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { out = cap(out, chunk); });
      child.stderr.on('data', (chunk) => { err = cap(err, chunk); });
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* 已退出 */ }
        resolve({ code: -1, out, err: `${err}\n（超时 ${Math.round(timeoutMs / 1000)} 秒）` });
      }, timeoutMs);
      child.once('exit', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, out, err }); });
      child.once('error', (error) => { clearTimeout(timer); resolve({ code: -1, out, err: String(error?.message ?? error) }); });
    });
  }

  const patchFile = path.join(deps.dataDir, 'dsh-home', 'profiles', 'acp', 'cordis.patch.yml');

  // 界面偏好（皮肤、上次分页、启动是否自动开窗）：面板 iframe 里 localStorage 不可用，存宿主这边。
  const uiFile = path.join(deps.dataDir, 'dsh-ui.json');
  const readUi = () => {
    try { return JSON.parse(fs.readFileSync(uiFile, 'utf8')) ?? {}; } catch { return {}; }
  };
  const writeUi = (patch = {}) => {
    const next = { ...readUi(), ...patch };
    try {
      fs.mkdirSync(path.dirname(uiFile), { recursive: true });
      fs.writeFileSync(uiFile, JSON.stringify(next, null, 2), 'utf8');
    } catch { /* 写失败不影响使用 */ }
    return next;
  };

  http.route('GET', '/api/dsh/ui', () => ({ ok: true, ...readUi() }));

  http.route('POST', '/api/dsh/ui', ({ body }) => {
    const patch = {};
    if (typeof body?.skin === 'string' && ['solid', 'dim', 'glass'].includes(body.skin)) patch.skin = body.skin;
    if (typeof body?.tab === 'string') patch.tab = body.tab;
    if (typeof body?.autoOpen === 'boolean') patch.autoOpen = body.autoOpen;
    if (typeof body?.autoStartDsh === 'boolean') patch.autoStartDsh = body.autoStartDsh;
    return { ok: true, ...writeUi(patch) };
  });  const readEntries = () => {
    try {
      const list = yaml.load(fs.readFileSync(patchFile, 'utf8'));
      return Array.isArray(list) ? list : [];
    } catch { return []; }
  };
  const writeEntries = (entries) => {
    fs.mkdirSync(path.dirname(patchFile), { recursive: true });
    const header = '# 由 QQ Agent「DeepSeek」面板维护（模型设置）。手工编辑也认，格式是 dsh profile patch 数组。\n';
    fs.writeFileSync(patchFile, header + yaml.dump(entries, { lineWidth: 120 }), 'utf8');
  };
  const currentModel = () => {
    const entry = readEntries().find((item) => item?.id === AGENT_MODEL_ID);
    return { ...DEFAULT_MODEL, ...(entry?.config ?? {}) };
  };

  http.route('GET', '/api/dsh/plugins', () => {
    const pkg = readProfilePkg();
    const bundles = getBundles(pkg);
    const candidates = BUNDLE_CANDIDATES.map((name) => {
      const info = readLocalPackage(name);
      return {
        name,
        version: info?.version ?? '',
        description: info?.description ?? '',
        enabled: bundles.includes(name),
      };
    });
    return { ok: true, bundles, candidates, profile: profilePkgPath() };
  });

  http.route('POST', '/api/dsh/plugins', async ({ body }) => {
    const action = String(body?.action ?? '');
    const name = String(body?.name ?? '').trim();
    if (!name) throw bad('缺少插件包名');
    if (!/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i.test(name)) throw bad(`包名不合法：${name}`);

    const pkg = readProfilePkg();
    const before = getBundles(pkg);

    // 官方 bundle：本地已经有，只改 bundles 列表（秒装），不动 pnpm。
    if (action === 'toggle') {
      if (!BUNDLE_CANDIDATES.includes(name)) throw bad('只有内置 bundle 可用这种方式启停');
      const next = body?.enabled === false ? before.filter((item) => item !== name) : [...new Set([...before, name])];
      writeProfilePkg(setBundles(pkg, next));
      return { ok: true, bundles: next, note: '重启插件后生效' };
    }

    if (action !== 'add' && action !== 'remove') throw bad('未知操作');

    // 非官方 / 自由的包：交给 dsh 自己的 plugin 命令（转发 pnpm），装完再校验。
    const args = ['plugin', '--profile', 'acp', action === 'add' ? 'add' : 'remove', name];
    const result = await runDshCli(args, 240000);
    const out = `${result.out}\n${result.err}`.trim().slice(-4000);
    if (result.code !== 0) return { ok: false, code: result.code, output: out, error: `dsh ${action} 失败（退出码 ${result.code}）` };

    const afterPkg = readProfilePkg();
    const next = action === 'add'
      ? [...new Set([...getBundles(afterPkg), name])]
      : getBundles(afterPkg).filter((item) => item !== name);
    writeProfilePkg(setBundles(afterPkg, next));

    // 预检：dsh 能否正常组合配置；不行就回滚，别把 DSH 弄坏。
    const check = await runDshCli(['--profile', 'acp', '--dump-config'], 60000);
    if (check.code !== 0) {
      const rollbackPkg = readProfilePkg();
      writeProfilePkg(setBundles(rollbackPkg, before));
      const undo = await runDshCli(['plugin', '--profile', 'acp', action === 'add' ? 'remove' : 'add', name], 240000);
      return {
        ok: false,
        rolledBack: true,
        output: out,
        error: `预检失败，已回滚：${check.err || check.out || '（无输出）'}${undo.code === 0 ? '' : '（回滚命令也失败了，请手动检查）'}`,
      };
    }

    return { ok: true, bundles: next, output: out, note: '已通过预检，重启插件后生效' };
  });

  http.route('GET', '/api/dsh/models', () => ({ ok: true, models: MODELS, ...currentModel() }));

  http.route('POST', '/api/dsh/models', ({ body }) => {
    const model = String(body?.model ?? '').trim();
    if (!MODELS.some((item) => item.id === model)) throw bad(`不支持的模型：${model || '（空）'}`);
    const entries = readEntries().filter((item) => item?.id !== AGENT_MODEL_ID);
    entries.push({ id: AGENT_MODEL_ID, config: { provider: DEFAULT_MODEL.provider, model } });
    writeEntries(entries);
    return { ok: true, model, restartHint: '重启 DSH 插件后生效（「洛希通道」卡片里点「重启插件」）' };
  });

  http.route('GET', '/api/dsh/status', () => runtime.status());

  http.route('POST', '/api/dsh/start', ({ body }) => {
    const port = Number(body?.port);
    // 启动时是否弹窗由偏好决定（面板里可以关掉）；显式传 open 时以传入的为准。
    const autoOpen = body?.open === undefined ? readUi().autoOpen !== false : body.open !== false;
    return runtime.start({ open: autoOpen, preferredPort: Number.isInteger(port) && port > 1024 ? port : undefined });
  });

  http.route('POST', '/api/dsh/stop', () => runtime.stop());

  http.route('POST', '/api/dsh/open', async () => ({ opened: await runtime.open(), ...runtime.status() }));

  // QQA 起来时顺手把 DSH 也拉起来（面板「概览」里可开关；默认关）。
  const maybeAutoStartDsh = async () => {
    try {
      const prefs = readUi();
      if (prefs.autoStartDsh !== true) return;
      const state = runtime.status();
      if (state.running || state.installing || !state.depsInstalled) return;
      await runtime.start({ open: prefs.autoOpen !== false });
      deps.log?.info?.('[dsh] 已按偏好自动启动');
    } catch (error) {
      deps.log?.warn?.(`[dsh] 自动启动失败：${error?.message ?? error}`);
    }
  };
  setTimeout(() => void maybeAutoStartDsh(), 8000);

  // 控制台/应用退出时带走 dsh，避免留下孤儿进程。
  if (typeof http.onDispose === 'function') http.onDispose(() => runtime.shutdown());
  return undefined;
}
