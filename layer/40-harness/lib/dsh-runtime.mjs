// 内置 DeepSeek Harness（dsh）运行时的启停、依赖按需安装与状态。
// 只读写 runtime/dsh 下的 node.exe / npm / @deepseek-ai/dsh，不改动出厂 src/ 下任何文件。
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { closeDshWindow, isDshWindowOpen, openDshWindow } from './dsh-window.mjs';

const DEFAULT_PORT = 3080;
const PORT_TRIES = 12;
const READY_TIMEOUT_MS = 240000;
const STOP_TIMEOUT_MS = 8000;
const MAX_LINES = 400;
const REGISTRIES = ['https://registry.npmmirror.com', 'https://registry.npmjs.org'];
const MIN_FREE_BYTES = 1.6 * 1024 ** 3;
// 随包 node.exe（v24.22.2 win-x64）的指纹；升级 node 时这里要一起改。
const NODE_SHA256 = '1c331340fa6cac5e4294725959070a143fa0507195a78ad77eed7943f719aac9';

const exposed = (message, status = 400) => Object.assign(new Error(message), { expose: true, status });

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function exists(file) {
  try { return fs.existsSync(file); } catch { return false; }
}

function freePort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function pickPort(preferred) {
  const start = Number.isInteger(preferred) && preferred > 1024 && preferred < 65000 ? preferred : DEFAULT_PORT;
  for (let port = start; port < start + PORT_TRIES; port += 1) if (await freePort(port)) return port;
  throw exposed(`${start} 起连续端口都被占用，无法启动 DeepSeek Harness。`, 409);
}

function friendlyInstallError(error) {
  const text = String(error?.message ?? error ?? '');
  if (/ENOSPC|no space left/i.test(text)) return '磁盘空间不足，安装依赖需要约 1.6GB 空闲。';
  if (/EAI_AGAIN|ETIMEDOUT|ECONNRESET|ENOTFOUND|network|ECONNREFUSED/i.test(text)) return '网络中断，未能从 npm 源下载依赖。请检查网络或代理后重试。';
  if (/E404|404 Not Found/i.test(text)) return 'npm 源上找不到指定版本的 @deepseek-ai/dsh，请检查 runtime/dsh/package.json。';
  return text || '安装依赖失败。';
}

export function createDshRuntime({ appRoot, dataDir, log = null } = {}) {
  const runtimeRoot = path.join(appRoot, 'runtime', 'dsh');
  const nodeExe = process.platform === 'win32'
    ? path.join(runtimeRoot, 'node', 'node.exe')
    : path.join(runtimeRoot, 'node', 'bin', 'node');
  const npmCli = path.join(runtimeRoot, 'npm', 'bin', 'npm-cli.js');
  const binJs = path.join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  const pkgFile = path.join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
  const lockFile = path.join(runtimeRoot, 'package-lock.json');
  const homeDir = path.join(dataDir, 'dsh-home');
  const stateDir = path.join(dataDir, 'dsh');
  const logFile = path.join(stateDir, 'dsh.log');

  let child = null;
  let port = null;
  let url = '';
  let authUrl = '';
  let ready = false;
  let starting = false;
  let installing = false;
  let installStep = '';
  let installStartedAt = 0;
  let installError = '';
  let installChild = null;
  let installTimer = null;
  let error = '';
  let startedAt = 0;
  let stopping = null;
  let expectedExit = false;
  let nodeVersion = '';
  const lines = [];

  const running = () => Boolean(child && child.exitCode === null && !child.killed);
  const runtimePresent = () => exists(nodeExe) && exists(npmCli) && exists(path.join(runtimeRoot, 'package.json')) && exists(lockFile);
  const depsPresent = () => exists(binJs) && exists(pkgFile);
  const dshVersion = () => readJson(pkgFile)?.version ?? '';

  function push(text) {
    const raw = String(text);
    // dsh web 启动后只打印一次带登录令牌的地址：`dsh web: http://127.0.0.1:3080/?token=...`
    // 裸地址会 401，所以真正要打开的是这一条。
    const plain = raw.replace(/\x1b\[[0-9;]*m/g, '');
    const found = plain.match(/(https?:\/\/[^\s"']*[?&]token=[A-Za-z0-9_\-.]+)/);
    if (found?.[1]) authUrl = found[1];
    // 令牌等于本机 DSH 的登录凭据，落盘/展示一律打码，只有进程内记得原文。
    const text2 = raw.replace(/token=[A-Za-z0-9_.-]+/g, 'token=***');
    for (const line of text2.replace(/\r/g, '').split('\n')) {
      if (!line.trim()) continue;
      lines.push(line);
      if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
    }
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.appendFileSync(logFile, text2.endsWith('\n') ? text2 : `${text2}\n`, 'utf8');
    } catch { /* 日志写盘失败不影响启停 */ }
  }

  let nodeHashChecked = false;
  function verifyNodeBinary() {
    if (nodeHashChecked || !exists(nodeExe)) return;
    nodeHashChecked = true;
    try {
      const actual = crypto.createHash('sha256').update(fs.readFileSync(nodeExe)).digest('hex');
      if (NODE_SHA256 && actual !== NODE_SHA256) {
        push('[luoxi] 警告：node.exe 的 SHA256 与随包记录不一致（被替换或自行升级过），继续使用。');
      }
    } catch { /* 读不到就算了，启动失败会有更明确的错误 */ }
  }

  function readNodeVersion() {
    if (nodeVersion || !exists(nodeExe)) return nodeVersion;
    try {
      nodeVersion = String(execFileSync(nodeExe, ['-v'], { encoding: 'utf8', timeout: 8000, windowsHide: true })).trim();
    } catch { nodeVersion = ''; }
    return nodeVersion;
  }

  function diskFree() {
    try {
      const stat = fs.statfsSync(runtimeRoot);
      return Number(stat.bavail) * Number(stat.bsize);
    } catch { return null; }
  }

  function status() {
    const alive = running();
    return {
      installed: depsPresent(),
      runtimeReady: runtimePresent(),
      depsInstalled: depsPresent(),
      phase: installing ? 'installing' : !alive ? (error ? 'error' : 'stopped') : ready ? 'ready' : starting ? 'starting' : 'error',
      running: alive,
      ready: alive && ready,
      installing,
      installStep,
      installElapsedMs: installing && installStartedAt ? Date.now() - installStartedAt : 0,
      installError,
      diskFreeBytes: diskFree(),
      port: alive ? port : null,
      url: alive ? url : '',
      hasToken: Boolean(authUrl),
      windowOpen: isDshWindowOpen(),
      pid: alive ? child.pid : null,
      startedAt: alive ? startedAt : 0,
      error,
      node: readNodeVersion(),
      dsh: dshVersion(),
      runtimeRoot,
      home: homeDir,
      logFile,
      tail: lines.slice(-160),
    };
  }

  async function waitReady(target, deadline) {
    // 必须等到带令牌的地址打印出来：裸地址是 401，先开窗口只会看到
    // "authentication required"。HTTP 探测只用来判断端口是否已经起来，
    // 万一将来 dsh 改了打印格式，端口起来 20 秒后也不再干等。
    let listeningSince = 0;
    while (Date.now() < deadline) {
      if (!running()) throw exposed(`DeepSeek Harness 启动后立即退出：${lines.slice(-3).join(' / ') || '无输出'}`, 502);
      if (authUrl) return;
      if (!listeningSince) {
        try {
          const response = await fetch(`${target}/`, { signal: AbortSignal.timeout(4000) });
          if (response.status < 500) listeningSince = Date.now();
        } catch { /* 端口还没监听，继续等 */ }
      } else if (Date.now() - listeningSince > 20000) return;
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    throw exposed('DeepSeek Harness 启动超时（4 分钟），请查看日志。', 504);
  }

  function openBrowser(target) {
    if (!target) return false;
    try {
      const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      const args = process.platform === 'win32' ? ['/c', 'start', '', target] : [target];
      const opener = spawn(command, args, { windowsHide: true, detached: true, stdio: 'ignore' });
      opener.on('error', () => {});
      opener.unref();
      return true;
    } catch { return false; }
  }

  // 优先开宿主自己的窗口；headless（纯 node 控制台）没有 BrowserWindow，
  // 这时才回退到系统默认浏览器。
  async function present(target) {
    if (!target) return false;
    try {
      if (await openDshWindow(target, { appRoot })) return true;
    } catch { /* 窗口失败就走浏览器 */ }
    return openBrowser(target);
  }

  /** 用内置 npm 跑一次 npm ci。失败会 reject，调用方决定是否换源重试。 */
  function runNpm(registry, timeoutMs) {
    return new Promise((resolve, reject) => {
      const args = [
        npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund',
        '--progress=false', '--loglevel=warn', '--registry', registry,
      ];
      const npm = spawn(nodeExe, args, {
        cwd: runtimeRoot,
        env: { ...process.env, npm_config_registry: registry, NO_COLOR: '1', FORCE_COLOR: '0' },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      installChild = npm;
      npm.stdout?.setEncoding('utf8');
      npm.stderr?.setEncoding('utf8');
      npm.stdout?.on('data', chunk => push(`[install] ${String(chunk).trimEnd()}`));
      npm.stderr?.on('data', chunk => push(`[install] ${String(chunk).trimEnd()}`));
      installTimer = setTimeout(() => {
        try { npm.kill(); } catch { /* 交给 taskkill */ }
        reject(new Error('安装超时（15 分钟）。'));
      }, timeoutMs);
      npm.once('error', (err) => {
        clearTimeout(installTimer);
        installChild = null;
        reject(new Error(`无法启动内置 npm：${err?.message ?? err}`));
      });
      npm.once('exit', (code) => {
        clearTimeout(installTimer);
        installChild = null;
        if (code === 0) resolve();
        else reject(new Error(`npm ci 退出码 ${code}（源：${registry}）。`));
      });
    });
  }

  async function installDeps() {
    if (installing) return;
    installing = true;
    installStartedAt = Date.now();
    installError = '';
    error = '';
    try {
      const free = diskFree();
      if (free !== null && free < MIN_FREE_BYTES) {
        throw new Error(`磁盘空间不足：需要约 1.6GB，当前剩余 ${Math.round(free / 1048576)}MB。`);
      }
      let lastError = null;
      for (const [index, registry] of REGISTRIES.entries()) {
        installStep = index === 0 ? '正在下载并安装依赖（npmmirror）' : '换官方源重试';
        push(`[luoxi] 开始安装依赖：${registry}`);
        try {
          await runNpm(registry, 15 * 60 * 1000);
          lastError = null;
          break;
        } catch (err) {
          lastError = err;
          push(`[luoxi] 依赖安装失败（${registry}）：${err.message}`);
        }
      }
      if (lastError) throw lastError;
      installStep = '校验安装结果';
      if (!depsPresent()) throw new Error('安装结束但找不到 @deepseek-ai/dsh，请重试。');
      push('[luoxi] 依赖安装完成');
      log?.info?.('[dsh] 依赖安装完成');
    } catch (err) {
      installError = friendlyInstallError(err);
      error = installError;
      push(`[luoxi] 安装失败：${installError}`);
      installing = false;
      installStep = '';
      throw err;
    }
    installing = false;
    installStep = '';
  }

  function spawnDsh({ open = true, preferredPort = DEFAULT_PORT } = {}) {
    error = ''; ready = false; expectedExit = false; authUrl = '';
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    return pickPort(preferredPort).then((picked) => {
      port = picked;
      url = `http://127.0.0.1:${port}`;
      push(`[luoxi] ${new Date().toISOString()} 启动 dsh web :${port}`);
      verifyNodeBinary();
      // 让 dsh 的插件命令用到随包 pnpm 10，而不是用户机器上碰巧装的版本。
      const shimDir = path.join(runtimeRoot, 'bin');
      const env = {
        ...process.env,
        DSH_HOME: homeDir,
        NO_COLOR: '1',
        FORCE_COLOR: '0',
        ...(exists(shimDir) ? { PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ''}` } : {}),
      };
      delete env.ELECTRON_RUN_AS_NODE;
      const spawned = spawn(nodeExe, [binJs, 'web', '--no-open', '--port', String(port)], {
        cwd: homeDir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      child = spawned;
      starting = true;
      startedAt = Date.now();
      spawned.stdout?.setEncoding('utf8');
      spawned.stderr?.setEncoding('utf8');
      spawned.stdout?.on('data', push);
      spawned.stderr?.on('data', push);
      spawned.once('error', (err) => {
        error = `无法启动内置 node：${err?.message ?? err}`;
        starting = false;
        push(`[luoxi] ${error}`);
      });
      spawned.once('exit', (code, signal) => {
        push(expectedExit ? '[luoxi] dsh 已停止' : `[luoxi] dsh 退出 code=${code ?? ''} signal=${signal ?? ''}`);
        ready = false; starting = false;
        if (child === spawned) child = null;
        if (!expectedExit && code) error = `DeepSeek Harness 已退出（code ${code}）。`;
      });
      const deadline = startedAt + READY_TIMEOUT_MS;
      void (async () => {
        try {
          await waitReady(url, deadline);
          if (child !== spawned || !running()) return;
          ready = true; starting = false; error = '';
          log?.info?.(`[dsh] DeepSeek Harness 已就绪 ${url}`);
          push(`[luoxi] 已就绪 ${url}`);
          if (open) await present(authUrl || url);
        } catch (err) {
          if (child !== spawned) return;
          error = err?.message ?? String(err);
          starting = false;
          push(`[luoxi] 启动失败：${error}`);
          await stop().catch(() => {});
        }
      })();
      return status();
    });
  }

  // 启动是异步的：面板一次请求只有 15 秒，首次拉起 dsh（或首次装依赖）要更久，
  // 所以立刻返回 installing/starting，由面板轮询 status 等 ready。
  async function start({ open = true, preferredPort = DEFAULT_PORT } = {}) {
    if (running()) {
      if (ready && open) await present(authUrl || url);
      return status();
    }
    if (starting || installing) return status();
    if (!runtimePresent()) throw exposed('缺少 runtime/dsh（node.exe / npm 或 package-lock.json 未就位），请重新解压便携包。', 409);
    if (!depsPresent()) {
      void (async () => {
        try {
          await installDeps();
          await spawnDsh({ open, preferredPort });
        } catch { /* 错误已写进 installError/error，面板轮询可见 */ }
      })();
      return status();
    }
    return spawnDsh({ open, preferredPort });
  }

  function killInstall() {
    const npm = installChild;
    if (!npm?.pid) return;
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/PID', String(npm.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else npm.kill('SIGTERM');
    } catch { /* 已退出 */ }
    installChild = null;
    if (installTimer) clearTimeout(installTimer);
  }

  function terminateTree() {
    return new Promise((resolve) => {
      const pid = child?.pid;
      if (!pid) return resolve();
      if (process.platform !== 'win32') {
        try { child.kill('SIGTERM'); } catch { /* 已退出 */ }
        setTimeout(resolve, 1200);
        return;
      }
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('exit', resolve);
      killer.once('error', resolve);
      setTimeout(resolve, STOP_TIMEOUT_MS);
    });
  }

  async function stop() {
    if (installing) {
      killInstall();
      installing = false;
      installStep = '';
      installError = '已取消安装。';
      return status();
    }
    if (!child) { ready = false; starting = false; return status(); }
    if (stopping) return stopping;
    stopping = (async () => {
      push('[luoxi] 停止 dsh');
      expectedExit = true;
      closeDshWindow();
      await terminateTree();
      ready = false;
      starting = false;
      child = null;
      return status();
    })().finally(() => { stopping = null; });
    return stopping;
  }

  return {
    status, start, stop,
    open: () => (ready ? present(authUrl || url) : Promise.resolve(false)),
    shutdown: async () => { closeDshWindow(); await stop().catch(() => {}); },
  };
}
