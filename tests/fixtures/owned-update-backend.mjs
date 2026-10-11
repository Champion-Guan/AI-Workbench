// Local process-management fixture. Not a Stable package or production entry.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createUpdateStartup } from './update-startup.mjs';

const config = JSON.parse(await readFile(new URL('./fixture.json', import.meta.url)));
if (config.mode === 'exit') process.exit(71);
const startup = createUpdateStartup(), instanceId = randomUUID();
if (config.mode === 'no-ack') process.send = () => true;
const origin = `http://127.0.0.1:${process.env.PORT}`;
const server = createServer((req, res) => {
  if (startup.reject(req, res, new URL(req.url, origin).pathname)) return;
  if (req.url === '/local-app/health') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ app: 'guan-ai-workbench', pid: process.pid, instanceId,
      version: config.version, buildId: config.mode === 'bad-health' ? 'wrong' : config.buildId,
      origin, ready: true, maintenance: startup.quarantined(),
      envClean: !process.env.NODE_OPTIONS && !process.env.GITHUB_TOKEN && !process.env.HTTP_PROXY }));
  } else res.end('local QA business route');
});
process.on('SIGTERM', () => {
  if (config.mode === 'ignore-stop') return;
  server.close(() => process.exit(0)); server.closeAllConnections();
});
server.listen(Number(process.env.PORT), '127.0.0.1');
