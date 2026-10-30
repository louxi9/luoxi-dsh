# 升级内置运行时（dsh / Node / npm）

三个东西各自升级，别一起动。升完都要重跑自检和打包。

## 1. 升级 DeepSeek Harness

```bash
cd runtime/dsh
# 改 package.json 里的 "@deepseek-ai/dsh": "x.y.z"
npm install --omit=dev --registry=https://registry.npmmirror.com   # 会更新 package-lock.json
cd ../..
node scripts/collect-licenses.mjs     # 许可证清单跟着换
node overrides/40-luoxi-harness/selftest.mjs    # 能装、能起、能停
node scripts/pack-portable.mjs        # 重新出包
```

注意：

- `package-lock.json` 必须一起提交/发布，首次安装就是按它做完整性校验的。
- dsh 是 developer preview，跨版本可能改 profile 格式。升级前备份 `data/dsh-home/`。
- 新版本如果加了带原生二进制的包，先跑一次 `--ignore-scripts` 的安装（selftest 就是），确认能起再发。

## 2. 升级 Node.js

1. 从 <https://nodejs.org/dist/> 下 `node-vX.Y.Z-win-x64.zip`。
2. 只取 `node.exe` 和 `LICENSE` 覆盖 `runtime/dsh/node/`（别的不要，保持“只有 node”）。
3. 更新指纹：`node -e "..."` 算 SHA256，改 `overrides/40-luoxi-harness/lib/dsh-runtime.mjs` 里的 `NODE_SHA256`。
4. 重跑 `collect-licenses.mjs`（Node 的 LICENSE 是单独文件，不在 node_modules 里，脚本不覆盖它）。
5. 跑 selftest + 打包。

## 3. 升级 npm / pnpm（装依赖、装插件时才会用到）

```bash
# npm：首次点启动时跑一次 npm ci
cd /tmp && curl -sLO https://registry.npmmirror.com/npm/-/npm-X.Y.Z.tgz
tar -xzf npm-X.Y.Z.tgz
rm -rf runtime/dsh/npm && cp -r package runtime/dsh/npm
rm -rf runtime/dsh/npm/docs runtime/dsh/npm/man
runtime/dsh/node/node.exe runtime/dsh/npm/bin/npm-cli.js --version

# pnpm：只给 dsh plugin 用，必须是 JS 版（10.x），不要换 12.x 的原生二进制
cd /tmp && curl -sLO https://registry.npmmirror.com/pnpm/-/pnpm-10.X.Y.tgz
tar -xzf pnpm-10.X.Y.tgz
rm -rf runtime/dsh/pnpm && mkdir runtime/dsh/pnpm
tar -xzf pnpm-10.X.Y.tgz -C runtime/dsh/pnpm --strip-components=1
runtime/dsh/node/node.exe runtime/dsh/pnpm/bin/pnpm.cjs --version
```

两个都是 MIT，各自的 `LICENSE` 要留着；pnpm 换大版本时注意别选 12 的原生二进制
（那会在安装时另外下可执行文件，声明也更麻烦）。升完跑一遍
`node scripts/collect-licenses.mjs`，清单里会多出/更新这两条。

## 升级后检查清单

- [ ] `node overrides/40-luoxi-harness/selftest.mjs` 输出 `ready: true / token: true`
- [ ] `data/dsh/dsh.log` 里没有明文 `token=`
- [ ] `node scripts/collect-licenses.mjs` 段数变化了要顺手看一眼 MPL/LGPL 两处
- [ ] `THIRD_PARTY_NOTICES.md` 里的版本号（Node 24.22.2 / dsh 0.2.1-rc.5）跟着改
- [ ] `node scripts/pack-portable.mjs --dry-run` 里不该出现 `data/`、`runtime/dsh/node_modules`
