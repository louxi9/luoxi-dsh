// 用 Electron 给 DSH 单开一个应用窗口（不是浏览器标签）。
// 控制台跑在 Electron 主进程里时可直接 import('electron')；headless（纯 node）
// 下拿不到 BrowserWindow，调用方回退到系统默认浏览器。
import path from 'node:path';

let win = null;
let electronModule; // undefined = 未探测；false = 不是 Electron 主进程

async function electron() {
  if (electronModule !== undefined) return electronModule;
  try {
    const mod = await import('electron');
    electronModule = mod?.BrowserWindow && mod?.app ? mod : false;
  } catch { electronModule = false; }
  return electronModule;
}

export function isDshWindowOpen() {
  try { return Boolean(win && !win.isDestroyed()); } catch { return false; }
}

export function closeDshWindow() {
  try { if (win && !win.isDestroyed()) win.destroy(); } catch { /* 关闭失败交给进程退出 */ }
  win = null;
}

export async function openDshWindow(url, { appRoot = '', title = 'DeepSeek Harness' } = {}) {
  const electronApi = await electron();
  if (!electronApi || !url) return false;
  const { BrowserWindow, shell, app } = electronApi;
  if (!app?.isReady?.()) return false;

  if (isDshWindowOpen()) {
    try {
      if (win.isMinimized?.()) win.restore();
      if (url && win.webContents?.getURL?.() !== url) void win.loadURL(url).catch(() => {});
      win.show?.();
      win.focus?.();
      return true;
    } catch { win = null; }
  }

  let origin = '';
  try { origin = new URL(url).origin; } catch { return false; }
  const icon = appRoot ? path.join(appRoot, 'assets', 'icon.png') : undefined;

  const created = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    title,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#151517',
    ...(icon ? { icon } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // 发布版默认关掉 devtools；排查时用 LUOXI_DSH_DEVTOOLS=1 打开。
      devTools: process.env.LUOXI_DSH_DEVTOOLS === '1',
    },
  });
  win = created;

  // 站内跳转留在窗口里，站外（文档、表单等）交给系统浏览器。
  const openExternal = (target) => { try { void shell?.openExternal?.(target); } catch { /* 尽力而为 */ } };
  created.webContents.setWindowOpenHandler(({ url: target }) => {
    try { if (new URL(target).origin !== origin) openExternal(target); } catch { /* 忽略非法 URL */ }
    return { action: 'deny' };
  });
  created.webContents.on('will-navigate', (event, target) => {
    try { if (new URL(target).origin !== origin) { event.preventDefault(); openExternal(target); } }
    catch { /* 非法 URL 直接放行给页面处理 */ }
  });
  created.once('ready-to-show', () => { if (!created.isDestroyed()) created.show(); });
  created.once('closed', () => { if (win === created) win = null; });

  try { await created.loadURL(url); } catch { /* did-fail-load 由页面自行重试 */ }
  return true;
}
