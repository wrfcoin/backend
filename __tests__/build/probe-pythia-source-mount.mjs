// Cold source-mode boot seam: no Jest registry or moduleNameMapper, and no
// generated dist middleware. Execute the actual safeMount function and its
// Pythia call from the release entrypoint, using tsx's source require loader.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import express from 'express';
import request from 'supertest';

const entrypoint = path.resolve('server/enhanced_unified_api_optimized.ts');
const source = ts.createSourceFile(entrypoint, readFileSync(entrypoint, 'utf8'), ts.ScriptTarget.Latest, true);
let mountFunction;
let mountCall;
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'safeMount') mountFunction = node.getText(source);
  if (ts.isCallExpression(node) && node.expression.getText(source) === 'safeMount'
      && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === '/api/pythia') {
    mountCall = `${node.getText(source)};`;
  }
  ts.forEachChild(node, visit);
}
visit(source);
if (!mountFunction || !mountCall) throw new Error('Release Pythia safeMount seam is missing');

const code = ts.transpileModule(`${mountFunction}\n${mountCall}`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const app = express();
const audit = [];
const warnings = [];
new Function('require', 'app', 'safeMountAudit', 'safeMountOptionalAllowlist', 'appLogger', code)(
  createRequire(entrypoint), app, audit, new Set(), { warn: (...args) => warnings.push(args) },
);
app.use((_req, res) => res.status(404).json({ error: 'unmounted_family' }));

let response = await request(app).get('/api/pythia/predictions?horizon=invalid');
const firstStatus = response.status;
const firstBody = response.body;
let allowedRequests = firstStatus === 400 ? 1 : 0;
if (audit[0]?.mounted) {
  for (let i = 1; i < 100; i++) {
    response = await request(app).get('/api/pythia/predictions?horizon=invalid');
    if (response.status === 400 && response.body.error === 'invalid_horizon') allowedRequests++;
  }
  response = await request(app).get('/api/pythia/predictions?horizon=invalid');
}
process.stdout.write(`__PROBE__${JSON.stringify({ audit, warnings, firstStatus, firstBody,
  allowedRequests, finalStatus: response.status, finalBody: response.body })}\n`);
// The real shared limiter initializes its Redis connection at import. The
// probe pins that URL to a closed loopback port and exits after its answer.
process.exit(0);
