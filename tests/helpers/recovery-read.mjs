import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from '../../src/canvas/node_modules/typescript/lib/typescript.js';

export function createRecoveryFixture(bindings) {
    const source = readFileSync(new URL('../../src/canvas/lib/recovery-read-gate.ts', import.meta.url), 'utf8').replace(/^import .*;$/gm, '').replace(/\bexport /g, '');
    const context = vm.createContext(bindings);
    vm.runInContext(ts.transpileModule(source + '\nglobalThis.createGate = createRecoveryReadGate;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
    return context.createGate;
}
