import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const supervisor = fileURLToPath(new URL("./proxy-supervisor.mjs", import.meta.url));
const children = new Set();
const stops = new WeakMap();
let shuttingDown = false;

export function spawnProxyProcess(binary, args, options) {
  if (shuttingDown) throw new Error("服务正在退出，不能启动新的代理");
  const child = spawn(process.execPath, [supervisor, String(process.pid), binary, ...args], options);
  children.add(child); // Track immediately, even before proxy startup completes.
  child.once("exit", () => children.delete(child));
  child.once("error", () => children.delete(child));
  return child;
}

export function stopProxyProcess(child) {
  if (stops.has(child)) return stops.get(child);
  const result = new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    child.once("exit", resolve);
    child.once("error", resolve);
    child.kill("SIGTERM");
  });
  stops.set(child, result);
  return result;
}

export async function stopAllProxyProcesses() {
  shuttingDown = true;
  await Promise.all([...children].map(stopProxyProcess));
}

process.on("exit", () => {
  for (const child of children) child.kill("SIGTERM");
});
