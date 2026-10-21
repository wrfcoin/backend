// Cold source-mode boot seam for /api/keys: run the release entrypoint's actual safeMountOptionalAllowlist and
// safeMount function with no ENCRYPTION_KEY, and report what the audit records.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import express from 'express';

const entrypoint = path.resolve('server/enhanced_unified_api_optimized.ts');
const source = ts.createSourceFile(entrypoint, readFileSync(entrypoint, 'utf8'), ts.ScriptTarget.Latest, true);
let allowlist;
let mountFunction;
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'safeMount') mountFunction = node.getText(source);
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'safeMountOptionalAllowlist') {
    allowlist = `const safeMountOptionalAllowlist = ${node.initializer.getText(source)};`;
  }
  ts.forEachChild(node, visit);
}
visit(source);
if (!mountFunction || !allowlist) throw new Error('Release safeMount seam is missing');

delete process.env.ENCRYPTION_KEY;
const code = ts.transpileModule(`${allowlist}\n${mountFunction}\nsafeMount('/api/keys', './routes/key-manager-routes');\nsafeMount('/api/pythia', './routes/pythia-routes');\nreturn [...safeMountOptionalAllowlist];`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, allowReturnOutsideFunction: true },
}).outputText;
const app = express();
const audit = [];
const warnings = [];
const optional = new Function('require', 'app', 'safeMountAudit', 'appLogger', code)(
  createRequire(entrypoint), app, audit, { warn: (...args) => warnings.push(args) },
);
process.stdout.write(`__PROBE__${JSON.stringify({ optional, audit, warnings: warnings.length })}\n`);
process.exit(0);
