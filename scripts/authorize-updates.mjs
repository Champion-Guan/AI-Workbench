import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimePaths } from '../src/server/runtime-paths.mjs';
import { MacKeychainVault } from '../src/server/keychain-vault.mjs';
import { UpdateAuth } from '../src/server/update-auth.mjs';
import { validRepository } from '../src/server/stable-version.mjs';

async function hiddenToken() {
  const input = process.stdin;
  if (!input.isTTY) throw Error('terminal_required');
  process.stdout.write('GitHub 只读 Token（隐藏输入，不保存到浏览器）：');
  const wasRaw = input.isRaw; input.setRawMode(true); input.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const done = error => { input.off('data', onData); input.setRawMode(Boolean(wasRaw)); input.pause(); process.stdout.write('\n'); error ? reject(Error(error)) : resolve(value); };
    const onData = chunk => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\u0003') return done('authorization_cancelled');
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
        if (value.length > 255) return done('invalid_authorization');
      }
    };
    input.on('data', onData);
  });
}
try {
  const repository = process.argv[2];
  if (process.platform !== 'darwin' || process.argv.length !== 3 || !validRepository(repository)) throw Error('invalid_usage');
  const root = fileURLToPath(new URL('../', import.meta.url)), paths = runtimePaths({ projectRoot: root });
  const auth = new UpdateAuth({ directory: paths.updates, vault: new MacKeychainVault({ executable: path.join(paths.runtime, 'guan-keychain') }) });
  const token = await hiddenToken();
  console.log(JSON.stringify(await auth.authorize(repository, token)));
} catch {
  console.error('更新授权未保存。请在 macOS 终端运行 node scripts/authorize-updates.mjs OWNER/REPOSITORY，并检查原生 Keychain 辅助程序；原配置保留。');
  process.exitCode = 1;
}
