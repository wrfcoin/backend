import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root = path.resolve(__dirname, '..');
const excluded = new Set(['.git', 'node_modules', 'dist', 'coverage', '__tests__', '__mocks__']);
import { callerHeaderFlows } from './helpers/core4-header-flow-guard';

function files(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (excluded.has(entry.name)) return [];
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) return files(filename);
    return /\.(?:js|ts)$/.test(entry.name) ? [filename] : [];
  });
}

describe('core4 caller credential guard (#1321)', () => {
  it('rejects caller header flows at every core4 forwarding site (no allowlist)', () => {
    const sources = new Map(files(root).map(filename => [path.relative(root, filename), readFileSync(filename, 'utf8')]));
    expect(callerHeaderFlows(sources)).toEqual([]);
  });

  it('requires every RPC handler to declare an explicit credential policy', () => {
    const filename = path.join(root, 'server/routes/rpc-routes.js');
    const source = ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
    const handlers = new Map<string, string>();
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'rpcMethods' && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
        for (const property of node.initializer.properties) {
          if (ts.isPropertyAssignment(property) && ts.isStringLiteral(property.name)) handlers.set(property.name.text, property.initializer.getText(source));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    const policyFile = path.join(root, 'server/routes/rpc-method-policy.js');
    expect(existsSync(policyFile)).toBe(true);
    const { RPC_METHOD_POLICY } = require(policyFile);
    expect([...handlers.keys()].sort()).toEqual(Object.keys(RPC_METHOD_POLICY).sort());
    for (const [method, handler] of handlers) {
      expect(['reader', 'owner-reader', 'permissionless', 'local']).toContain(RPC_METHOD_POLICY[method]);
      if (handler.includes('/addresses/')) expect(RPC_METHOD_POLICY[method]).toBe('owner-reader');
    }
    expect(handlers.size).toBeGreaterThan(0);
  });
});
