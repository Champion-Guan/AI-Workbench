#!/usr/bin/env node
// Local-only test core. Never contacts subscriptions or implements AI requests.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
const file = process.argv[process.argv.indexOf('-f') + 1];
const config = readFileSync(file, 'utf8');
if (config.includes('FAIL_FAKE_CORE')) process.exit(1);
const mixed = Number(config.match(/^mixed-port:\s*(\d+)/m)[1]);
const controller = Number(config.match(/^external-controller:\s*127\.0\.0\.1:(\d+)/m)[1]);
const servers = [mixed, controller].map(port => {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end('{"proxies":{},"version":"test-only"}');
  });
  server.listen(port, '127.0.0.1');
  return server;
});
process.on('SIGTERM', () => {
  for (const server of servers) { server.close(); server.closeAllConnections(); }
});
