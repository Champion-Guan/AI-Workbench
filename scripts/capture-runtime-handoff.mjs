import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { captureRuntimeHandoff } from './lib/runtime-handoff.mjs';
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function inspect(port) {
  if (process.platform !== 'darwin') throw new Error('Legacy handoff process inspection is currently macOS-only');
  const pids = [...new Set(run('lsof', ['-t', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN']).split(/\s+/).map(Number))];
  if (pids.length !== 1 || !Number.isInteger(pids[0])) throw new Error('Service listener ambiguous');
  const pid = pids[0], cwdLine = run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']).split('\n').find(line => line.startsWith('n'));
  const command = run('ps', ['-p', String(pid), '-o', 'command=']);
  const cwd = cwdLine?.slice(1);
  const serverEntryVerified = /(?:^|\/)node\s+(?:\.\/)?server\.mjs\s*$/.test(command);
  const children = run('pgrep', ['-P', String(pid)]).split(/\s+/).map(Number);
  const candidates = [];
  for (const supervisorPid of children) {
    if (!Number.isInteger(supervisorPid)) continue;
    const childCommand = run('ps', ['-p', String(supervisorPid), '-o', 'command=']);
    if (!childCommand.includes('/src/server/proxy-supervisor.mjs ' + pid + ' ')) continue;
    const config = childCommand.match(/\s-f\s+(\S+)(?:\s|$)/)?.[1];
    const directory = childCommand.match(/\s-d\s+(\S+)(?:\s|$)/)?.[1];
    if (!config || !directory || path.dirname(config) !== directory || path.basename(config) !== 'config.yaml' || !/^guan-image-relay-[A-Za-z0-9]+$/.test(path.basename(directory))) continue;
    if (await realpath(path.dirname(directory)) !== await realpath(tmpdir())) continue;
    if (await realpath(directory) !== directory && await realpath(directory) !== path.join(await realpath(tmpdir()), path.basename(directory))) continue;
    candidates.push({ supervisorPid, configFile: config });
  }
  if (candidates.length !== 1) throw new Error('Active owned proxy config not proven');
  return { pid, cwd, serverEntryVerified, ...candidates[0] };
}
try {
  const args = process.argv.slice(2);
  const output = args.length === 2 && args[0] === '--output' ? args[1] : undefined;
  if (args.length && !output) throw new Error('Use no arguments for read-only check, or --output /absolute/private/file.json');
  const result = await captureRuntimeHandoff({ projectRoot, inspect, output,
    fetchStatus: async origin => {
      const reply = await fetch(origin + '/local-proxy/status', { signal: AbortSignal.timeout(3000), redirect: 'error' });
      if (!reply.ok) throw new Error('Legacy status unavailable');
      return await reply.json();
    } });
  console.log(JSON.stringify(result, null, 2));
} catch {
  console.error('Private runtime handoff not captured: identity/state could not be proven or destination is unsafe. Current service and original data were not changed.');
  process.exitCode = 1;
}
