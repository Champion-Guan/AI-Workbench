import { SupervisedUpdateService } from '../../src/server/update-supervisor.mjs';
process.once('message', async config => {
  const service = new SupervisedUpdateService(config.connection);
  try {
    const report = await service.start(config.pointer);
    if (config.activate) await service.activate(config.pointer);
    process.send({ ok: true, pid: report.pid });
  } catch (error) { process.send({ ok: false, code: /^service_[a-z_]{1,60}$/.test(error?.message || '') ? error.message : 'QA_service_failed' }); }
});
// Deliberately keep controller alive until the parent simulates manager exit.
