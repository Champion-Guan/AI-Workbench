import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from '../../src/canvas/node_modules/typescript/lib/typescript.js';

export function createActivityFixture() {
  const source = readFileSync(new URL('../../src/canvas/lib/update-activity.ts', import.meta.url), 'utf8').replace(/export /g, '');
  const group = readFileSync(new URL('../../src/canvas/lib/settle-activity-group.ts', import.meta.url), 'utf8').replace(/export /g, '');
  const barrier = readFileSync(new URL('../../src/canvas/lib/page-drain-barrier.ts', import.meta.url), 'utf8').replace(/^import .*;$/gm, '').replace(/export /g, '');
  const handoff = readFileSync(new URL('../../src/canvas/lib/deferred-task-handoff.ts', import.meta.url), 'utf8').replace(/^import .*;$/gm, '').replace(/export /g, '');
  const context = vm.createContext({ AbortController });
  vm.runInContext(ts.transpileModule(source + '\n' + group + '\n' + barrier + '\n' + handoff + '\nglobalThis.activityRegistry = frontendActivity; globalThis.observe = observeActivity; globalThis.barrier = new PageDrainBarrier(frontendActivity); globalThis.handoffs = new DeferredTaskHandoff(globalThis.barrier);', {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  return { registry: context.activityRegistry, observeActivity: context.observe, settleActivityGroup: context.settleActivityGroup,
    barrier: context.barrier, workbenchTaskHandoff: context.handoffs,
    runWorkbenchTask: (command, operation) => command ? context.handoffs.execute(command, operation) : context.barrier.runTask('workbench', operation),
    runTaskActivity: (domain, operation, parent) => context.barrier.runTask(domain, operation, parent) };
}
