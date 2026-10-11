// Isolated user-mode launchd validation only. Never installs a production plist,
// adopts a service, accesses real user data, or invokes an installer operation.
import path from 'node:path';
import { mkdtemp, realpath, mkdir, cp, copyFile, chmod, writeFile, rm, lstat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { constants } from 'node:fs';
import { updateManagerLaunchAgent, updateSupervisorLaunchAgent } from '../src/server/update-launchd.mjs';
import { supervisorCapability, SupervisedUpdateService } from '../src/server/update-supervisor.mjs';
import { verifyStableRuntime } from './lib/stable-runtime.mjs';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile), pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let verificationStep = 'platform';
async function status(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath), chunks = [];
    socket.setTimeout(1000, () => socket.destroy(Error('QA IPC timeout')));
    socket.on('connect', () => socket.end('{"op":"status"}\n'));
    socket.on('data', bytes => chunks.push(bytes)); socket.on('error', reject);
    socket.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { reject(Error('QA IPC invalid')); } });
  });
}
async function main() {
  if (process.argv.length !== 2 || process.platform !== 'darwin' || process.arch !== 'arm64') throw Error('QA platform invalid');
  const domain = `gui/${process.getuid()}`;
  await run('/bin/launchctl', ['print', domain], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
  const project = new URL('../', import.meta.url), runtime = fileURLToPath(new URL('output/stable-runtime/arm64/', project));
  await verifyStableRuntime(runtime, 'arm64');
  const root = await realpath(await mkdtemp('/tmp/guan-launchd-qa-'));
  const directory = path.join(root, 'manager'), privateRoot = path.join(root, 'private'), logs = path.join(root, 'logs');
  const label = 'com.guanaiworkbench.updater.qa.' + randomUUID(), target = domain + '/' + label;
  const plist = path.join(root, 'qa.plist'), socketPath = path.join(privateRoot, 'updates/u.sock');
  const supervisorLabel = 'com.guanaiworkbench.supervisor.qa.' + randomUUID(), supervisorTarget = domain + '/' + supervisorLabel;
  const supervisorPlist = path.join(root, 'supervisor-qa.plist'), supervisorSocket = path.join(privateRoot, 'updates/s.sock');
  const capabilityFile = path.join(privateRoot, 'updates/supervisor.capability');
  let bootstrapped = false, supervisorBootstrapped = false, cleaned = false, controller;
  try {
    for (const dir of [path.join(directory, 'runtime'), path.join(privateRoot, 'data'), logs]) await mkdir(dir, { recursive: true, mode: 0o700 });
    for (const relative of ['src/server', 'scripts/lib', 'scripts/run-update-manager.mjs', 'scripts/run-update-supervisor.mjs'])
      await cp(new URL(relative, project), path.join(directory, relative), { recursive: true });
    const node = path.join(directory, 'runtime/node'), entry = path.join(directory, 'scripts/run-update-manager.mjs');
    await copyFile(path.join(runtime, 'node'), node, constants.COPYFILE_FICLONE); await chmod(node, 0o700);
    await writeFile(plist, updateManagerLaunchAgent({ node, entry, directory, dataRoot: privateRoot, logs, label }), { flag: 'wx', mode: 0o600 });
    await supervisorCapability(capabilityFile, { create: true });
    await writeFile(supervisorPlist, updateSupervisorLaunchAgent({ node, entry: path.join(directory, 'scripts/run-update-supervisor.mjs'), directory, dataRoot: privateRoot, logs, label: supervisorLabel }), { flag: 'wx', mode: 0o600 });
    verificationStep = 'plist-validation';
    await run('/usr/bin/plutil', ['-lint', plist], { timeout: 5000 });
    await run('/usr/bin/plutil', ['-lint', supervisorPlist], { timeout: 5000 });
    verificationStep = 'supervisor-bootstrap';
    supervisorBootstrapped = true; await run('/bin/launchctl', ['bootstrap', domain, supervisorPlist], { timeout: 5000 });
    controller = new SupervisedUpdateService({ socketPath: supervisorSocket, capabilityFile });
    verificationStep = 'supervisor-connection'; let connected = false;
    for (let i = 0; i < 80; i++) { try { await controller.connect(); connected = true; break; } catch {} await pause(50); }
    if (!connected || await controller.call('ping', null) !== true) throw Error('QA supervisor invalid');
    const incarnation = controller.incarnation;
    // A timed-out bootstrap could still have registered the job. Retain QA
    // files unless exact-job bootout subsequently confirms safe cleanup.
    verificationStep = 'manager-bootstrap';
    bootstrapped = true; await run('/bin/launchctl', ['bootstrap', domain, plist], { timeout: 5000 });
    verificationStep = 'manager-status'; let reply;
    for (let i = 0; i < 80; i++) { try { reply = await status(socketPath); break; } catch {} await pause(50); }
    if (!reply?.ok || reply.result.installAllowed !== false || ((await lstat(socketPath)).mode & 0o777) !== 0o600) throw Error('QA status invalid');
    await run('/bin/launchctl', ['print', target], { timeout: 5000 });
    verificationStep = 'manager-bootout';
    await run('/bin/launchctl', ['bootout', target], { timeout: 5000 }); bootstrapped = false;
    for (let i = 0; i < 80; i++) {
      try { await lstat(socketPath); } catch (e) { if (e.code === 'ENOENT') { cleaned = true; break; } throw e; }
      await pause(50);
    }
    if (!cleaned) throw Error('QA graceful stop failed');
    verificationStep = 'supervisor-survived-manager';
    if (await controller.call('ping', null) !== true || controller.incarnation !== incarnation) throw Error('QA supervisor ownership reset');
    // Restart only the random QA manager. The independent supervisor session
    // and incarnation remain intact across manager lifecycle changes.
    verificationStep = 'manager-rebootstrap';
    bootstrapped = true; await run('/bin/launchctl', ['bootstrap', domain, plist], { timeout: 5000 });
    let restarted = false;
    for (let i = 0; i < 80; i++) { try { const result = await status(socketPath); if (result.ok) { restarted = true; break; } } catch {} await pause(50); }
    if (!restarted || await controller.call('ping', null) !== true || controller.incarnation !== incarnation) throw Error('QA restart failed');
    await run('/bin/launchctl', ['bootout', target], { timeout: 5000 }); bootstrapped = false;
    verificationStep = 'supervisor-bootout'; controller.disconnect();
    await run('/bin/launchctl', ['bootout', supervisorTarget], { timeout: 5000 }); supervisorBootstrapped = false;
    let supervisorCleaned = false;
    for (let i = 0; i < 80; i++) { try { await lstat(supervisorSocket); } catch (e) { if (e.code === 'ENOENT') { supervisorCleaned = true; break; } throw e; } await pause(50); }
    if (!supervisorCleaned) throw Error('QA supervisor graceful stop failed');
    console.log(JSON.stringify({ userModeLaunchd: true, daemonStatusVerified: true, installationEnabled: false,
      supervisorVerified: true, managerRestartPreservedSupervisor: true,
      gracefulBootout: true, productionChanged: false, privateDataUsed: false }));
  } finally {
    controller?.disconnect();
    if (bootstrapped) {
      // Exact newly generated QA label only. Never bootout the production label.
      await run('/bin/launchctl', ['bootout', target], { timeout: 5000 });
      await pause(300);
    }
    if (supervisorBootstrapped) { await run('/bin/launchctl', ['bootout', supervisorTarget], { timeout: 5000 }); await pause(300); }
    // The validated explicit temporary root contains only this run's QA files.
    // No user configuration, source directory, or original backup is removed.
    await rm(root, { recursive: true, force: true });
  }
}
main().catch(() => { console.error(`Isolated launchd validation failed at ${verificationStep}; production was not changed.`); process.exitCode = 1; });
