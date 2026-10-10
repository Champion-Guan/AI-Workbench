import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { createServer as createNetServer, connect } from "node:net";
import { readFile } from "node:fs/promises";
import { fetch, ProxyAgent } from "undici";
import { assertProxyPortsAvailable } from "../src/server/proxy-service.mjs";

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => server.close(resolve));

test("production uses fetch and ProxyAgent from the same Undici implementation", async () => {
  const source = await readFile(new URL("../src/server/index.mjs", import.meta.url), "utf8");
  assert.match(source, /import \{ fetch, ProxyAgent \} from "undici"/);
});

test("HEAD and GET work through an actual HTTP CONNECT proxy", async () => {
  const target = createServer((request, response) => response.end("connected"));
  const targetPort = await listen(target);
  const proxy = createServer();
  const sockets = new Set();
  let tunnels = 0;
  proxy.on("connect", (request, client, head) => {
    tunnels++;
    const upstream = connect(targetPort, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    sockets.add(client); sockets.add(upstream);
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
  });
  const proxyPort = await listen(proxy);
  const agent = new ProxyAgent(`http://127.0.0.1:${proxyPort}`);
  try {
    for (const method of ["HEAD", "GET"]) {
      const response = await fetch(`http://127.0.0.1:${targetPort}/`, {
        method, dispatcher: agent, signal: AbortSignal.timeout(3000),
      });
      assert.equal(response.status, 200);
      assert.equal(await response.text(), method === "GET" ? "connected" : "");
    }
    assert.ok(tunnels > 0, "request must traverse proxy, not direct");
  } finally {
    await agent.destroy();
    for (const socket of sockets) socket.destroy();
    await Promise.all([close(proxy), close(target)]);
  }
});

test("occupied mixed port fails instead of accepting an old process", async () => {
  const old = createNetServer();
  const port = await listen(old);
  try {
    await assert.rejects(assertProxyPortsAvailable(port), new RegExp(`端口 ${port} 已被占用`));
    assert.equal(old.listening, true, "must not stop someone else's process");
  } finally { await close(old); }
});

test("occupied controller port fails and releases the preflight listener", async () => {
  const old = createNetServer();
  const port = await listen(old);
  try {
    await assert.rejects(assertProxyPortsAvailable(port - 1), /已被占用/);
    assert.equal(old.listening, true);
  } finally { await close(old); }
});
