import { SupervisedUpdateService } from '../../src/server/update-supervisor.mjs';
process.once('message', async config => {
  const service = new SupervisedUpdateService(config.connection);
  try {
    const report = await service.start(config.pointer);
    if (config.activate) await service.activate(config.pointer);
    process.send({ ok: true, pid: report.pid });
  } catch { process.send({ ok: false }); }
});
// Deliberately keep controller alive until the parent simulates manager exit.
