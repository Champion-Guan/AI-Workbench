import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from '../../src/canvas/node_modules/typescript/lib/typescript.js';

export function createPersistenceFixture() {
  const source = readFileSync(new URL('../../src/canvas/lib/persistence-checkpoint.ts', import.meta.url), 'utf8').replace(/export /g, '');
  const context = vm.createContext({});
  vm.runInContext(ts.transpileModule(source + '\nglobalThis.fixture = { PersistenceCheckpoint, createPersistenceCheckpoint, flushStorageCheckpoints, subscribePersistenceCheckpoints };', {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  return context.fixture;
}
