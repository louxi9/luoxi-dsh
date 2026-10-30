#!/usr/bin/env node
// 把洛希 DSH 装进一个宿主（支持 v2 追加组合的 agent 框架）目录。
// 用法：node install.mjs [宿主目录]           默认当前目录
//       node install.mjs [宿主目录] --uninstall
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const uninstall = args.includes('--uninstall');
const hostRoot = path.resolve(args.find(arg => !arg.startsWith('--')) ?? process.cwd());

function fail(message) {
  console.error(`× ${message}`);
  process.exit(1);
}

const targets = [
  { from: 'layer/40-harness', to: 'overrides/40-luoxi-harness', label: '运行时层：按需安装、自启动、窗口、面板' },
  { from: 'layer/50-bridge', to: 'overrides/50-luoxi-bridge', label: '接口层：/dsh 命令、本机桥、审批、插件守护' },
  { from: 'plugin', to: 'luoxi-plugin-dsh', label: 'DSH 侧插件' },
];

if (uninstall) {
  for (const item of targets) {
    const target = path.join(hostRoot, item.to);
    if (!fs.existsSync(target)) { console.log(`- 不存在，跳过：${item.to}`); continue; }
    fs.rmSync(target, { recursive: true, force: true });
    console.log(`- 已删除：${item.to}`);
  }
  console.log('\n卸载完成，重启宿主生效。数据目录（dsh-home、bridge）保留，要清手动删。');
  process.exit(0);
}

if (!fs.existsSync(path.join(hostRoot, 'src')) && !fs.existsSync(path.join(hostRoot, 'package.json'))) {
  fail(`这不像宿主目录：${hostRoot}\n  用法：node install.mjs <宿主目录>`);
}

const runtime = path.join(hostRoot, 'runtime', 'dsh');
for (const file of ['node/node.exe', 'package.json', 'package-lock.json']) {
  if (!fs.existsSync(path.join(runtime, file))) {
    console.warn(`! 缺少 runtime/dsh/${file}：面板会提示自启动，但装不了依赖。`);
  }
}

for (const item of targets) {
  const source = path.join(here, item.from);
  const target = path.join(hostRoot, item.to);
  if (!fs.existsSync(source)) { console.warn(`! 跳过缺失的源：${item.from}`); continue; }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) {
    const backup = `${target}.bak-${Date.now()}`;
    fs.renameSync(target, backup);
    console.log(`- 已备份同名目录：${path.relative(hostRoot, backup)}`);
  }
  fs.cpSync(source, target, { recursive: true, filter: (src) => !src.includes(`${path.sep}node_modules`) });
  console.log(`- 已安装：${item.to}（${item.label}）`);
}

console.log('\n重启宿主后：');
console.log('  1. 打开「DeepSeek」页点「安装并启动」（首次装依赖约 1–2 分钟）');
console.log('  2. 「洛希通道」卡片看到 监听中 / 插件已连接');
console.log('  3. 在会话里发 /dsh 你好');
console.log('\n卸载：node install.mjs <宿主目录> --uninstall');
