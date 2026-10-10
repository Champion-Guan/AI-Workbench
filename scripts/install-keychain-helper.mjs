import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { runtimePaths } from '../src/server/runtime-paths.mjs';
import { installNativeKeychainBuild } from './lib/native-keychain-build.mjs';
if (process.argv.length !== 2) throw Error('No arbitrary native installation options accepted');
const root = fileURLToPath(new URL('../', import.meta.url));
console.log(JSON.stringify(await installNativeKeychainBuild(root, path.join(root, existsSync(path.join(root, 'bin/KEYCHAIN-BUILD.json')) ? 'bin' : 'output/native'), runtimePaths({ projectRoot: root }))));
