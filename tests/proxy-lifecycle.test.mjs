import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { once } from "node:events";

const moduleUrl = new URL("../src/server/proxy-process.mjs", import.meta.url).href;
const fake = 'const net=require("node:net"); const s=net.createServer(); s.listen(0,"127.0.0.1",()=>console.log(JSON.stringify({pid:process.pid,port:s.address().port})));';
const portOpen = (port) => new Promise((resolve) => {
  const socket = connect(port, "127.0.0.1");
  socket.once("connect", () => { socket.destroy(); resolve(true); });
  socket.once("error", () => { socket.destroy(); resolve(false); });
});

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP", "SIGKILL", "SIGTERM-resistant"]) {
  test(`proxy child releases its port after owner ${signal}`, { timeout: 10000 }, async () => {
    const code = `import {spawnProxyProcess,stopAllProxyProcesses} from ${JSON.stringify(moduleUrl)};
      spawnProxyProcess(process.execPath,["-e",${JSON.stringify((signal === "SIGTERM-resistant" ? 'process.on("SIGTERM",()=>{});' : '') + fake)}],{stdio:["ignore","inherit","inherit"]});
      for(const s of ["SIGTERM","SIGINT","SIGHUP"])process.on(s,async()=>{await stopAllProxyProcesses();process.exit(0)});`;
    const owner = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
    const ended = once(owner, "exit");
    let info;
    try {
      let output = "";
      for await (const chunk of owner.stdout) {
        output += chunk;
        if (output.includes("\n")) { info = JSON.parse(output.split("\n")[0]); break; }
      }
      assert.ok(info?.port);
      assert.equal(await portOpen(info.port), true);
      owner.kill(signal === "SIGTERM-resistant" ? "SIGTERM" : signal);
      await ended;
      for (let attempt = 0; attempt < 50 && await portOpen(info.port); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(await portOpen(info.port), false, "managed proxy must not remain listening");
    } finally {
      if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
      if (info?.pid && await portOpen(info.port)) { try { process.kill(info.pid, "SIGKILL"); } catch {} }
    }
  });
}
