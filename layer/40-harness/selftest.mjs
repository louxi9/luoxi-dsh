// 自检：用应用同样的方式拉起内置 dsh（缺依赖时先装依赖），等到 ready，再停掉。
// 用法：node overrides/40-luoxi-harness/selftest.mjs [appRoot] [dataDir]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDshRuntime } from './lib/dsh-runtime.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(process.argv[2] ?? path.join(here, '..', '..'));
const dataDir = path.resolve(process.argv[3] ?? path.join(appRoot, 'data'));
const runtime = createDshRuntime({ appRoot, dataDir });

const first = runtime.status();
console.log('runtime:', first.runtimeReady, '| deps:', first.depsInstalled, '| node:', first.node, '| dsh:', first.dsh);
if (!first.runtimeReady) process.exit(1);

const started = await runtime.start({ open: false });
console.log('start ->', started.phase, started.url);
let state = started;
for (let i = 0; i < 420 && (state.phase === 'starting' || state.phase === 'installing'); i += 1) {
  await new Promise(resolve => setTimeout(resolve, 1000));
  state = runtime.status();
  if (i % 15 === 0) {
    console.log(`  …${state.phase}${state.installing ? ` ${state.installStep} ${Math.round(state.installElapsedMs / 1000)}s` : ''}`);
  }
}
console.log('phase:', state.phase, '| ready:', state.ready, '| token:', state.hasToken, '| error:', state.error || '-');
if (state.phase !== 'ready') {
  console.log(state.tail.slice(-12).join('\n'));
  await runtime.stop();
  process.exit(2);
}

const stopped = await runtime.stop();
console.log('stop ->', stopped.phase, '| running:', stopped.running);
process.exit(stopped.running ? 3 : 0);
