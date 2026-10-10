// A separate watchdog survives abrupt service termination (including SIGKILL)
// long enough to stop its own Mihomo child. Never kill by port or process name.
import { spawn } from "node:child_process";

// Pass the original owner explicitly: it may die before this watchdog starts.
const [owner, binary, ...args] = process.argv.slice(2);
const parentPid = Number(owner);
const child = spawn(binary, args, { stdio: "inherit" });
let stopping = false;
let forceTimer;
const stop = () => {
  if (stopping) return;
  stopping = true;
  child.kill("SIGTERM");
  forceTimer = setTimeout(() => child.kill("SIGKILL"), 1500);
};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, stop);
process.on("exit", () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
const watchdog = setInterval(() => {
  try { process.kill(parentPid, 0); } catch (error) {
    if (error.code === "ESRCH") stop();
  }
}, 250);
child.once("error", () => {
  console.error("无法启动 Mihomo 子进程");
  clearInterval(watchdog);
  clearTimeout(forceTimer);
  process.exitCode = 1;
});
child.once("exit", (code) => {
  clearInterval(watchdog);
  clearTimeout(forceTimer);
  process.exitCode = stopping ? 0 : code ?? 1;
});
