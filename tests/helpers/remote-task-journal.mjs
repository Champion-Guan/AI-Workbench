import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import ts from '../../src/canvas/node_modules/typescript/lib/typescript.js';

export function journalFixture(registry, { rows = new Map(), maximum = 4096, storage, domain = 'canvas', namespace = 'video' } = {}) {
  let nextId = 1;
  const memory = storage || { get length() { return rows.size; }, key: index => [...rows.keys()][index] ?? null,
    getItem: key => rows.get(key) ?? null, setItem: (key, value) => rows.set(key, value), removeItem: key => rows.delete(key) };
  const source = readFileSync(new URL('../../src/canvas/lib/remote-task-journal.ts', import.meta.url), 'utf8').replace(/^import .*;$/gm, '').replace(/export /g, '');
  const context = vm.createContext({ frontendActivity: registry, window: { localStorage: memory }, crypto: { getRandomValues() { throw Error('use explicit fixture random'); } }, memory,
    random: () => (nextId++).toString(16).padStart(64, '0'), maximum, domain, namespace });
  vm.runInContext(ts.transpileModule(source + '\nglobalThis.journal = new RemoteTaskJournal(frontendActivity, () => memory, random, maximum, domain, namespace);', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return { journal: context.journal, rows, storage: memory };
}
