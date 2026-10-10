import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { scanDirectory, scanHistory, scanStaged, scanWorkingTree } from './lib/secret-scan.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
try {
  const args = process.argv.slice(2);
  let result;
  if (!args.length || (args.length === 1 && args[0] === '--working-tree')) result = await scanWorkingTree(root);
  else if (args.length === 1 && args[0] === '--staged') result = scanStaged(root);
  else if (args.length === 1 && args[0] === '--history') result = scanHistory(root);
  else if (args.length === 2 && args[0] === '--directory' && path.isAbsolute(args[1])) result = { findings: await scanDirectory(args[1]) };
  else throw new Error('Invalid scan arguments');
  if (args[0] === '--history') {
    const reviews = JSON.parse(await readFile(path.join(root, 'config/security/secret-scan-reviewed.json'), 'utf8'));
    const reviewed = [], remaining = [];
    for (const finding of result.findings) {
      const review = reviews.find(item => item.object === finding.object && item.file === finding.file && item.line === finding.line && item.rule === finding.rule);
      if (review) reviewed.push({ ...finding, reason: review.reason }); else remaining.push(finding);
    }
    result = { ...result, findings: remaining, reviewed };
  }
  console.log(JSON.stringify({ ...result, ok: result.findings.length === 0 }, null, 2));
  if (result.findings.length) process.exitCode = 1;
} catch {
  // Never echo parser, Git stderr or file contents into hooks/CI logs.
  console.error('Secret scan could not complete safely; commit/release is blocked.');
  process.exitCode = 2;
}
