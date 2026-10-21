import ts from 'typescript';
import path from 'node:path';

// A conservative local data-flow guard, not a whole-program proof. Resolve
// lexical bindings so header aliases/destructuring are followed without
// conflating a different local variable with the same name.
export function callerHeaderFlows(inputs: Map<string, string>): string[] {
  const options = { noResolve: true, noLib: true, allowJs: true, target: ts.ScriptTarget.Latest };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (filename, languageVersion) => inputs.has(filename)
    ? ts.createSourceFile(filename, inputs.get(filename)!, languageVersion, true) : undefined;
  host.fileExists = filename => inputs.has(filename);
  const program = ts.createProgram([...inputs.keys()], options, host);
  const checker = program.getTypeChecker();
  const symbol = (n: ts.Node) => checker.getSymbolAtLocation(n);
  const violations: string[] = [];
  const sinkNames = new Set(['fetchCore4Json', 'forwardCore4Headers', 'fetch']);
  const safeNames = new Set(['core4ReaderHeaders', 'core4PublicReadHeaders', 'core4TraceHeaders', 'core4ContributorHeaders', 'core4OperatorHeaders']);
  for (const source of program.getSourceFiles()) {
    const tainted = new Set<ts.Symbol>();
    const sinks = new Set<ts.Symbol>();
    const safe = new Set<ts.Symbol>();
    const requestAliases = new Set<ts.Symbol>();
    const returns = new Set<ts.Symbol>();
    const nodes: ts.Node[] = [];
    const visit = (n: ts.Node) => { nodes.push(n); ts.forEachChild(n, visit); }; visit(source);
    const mark = (set: Set<ts.Symbol>, n: ts.Node): boolean => {
      const s = symbol(n); if (!s || set.has(s)) return false; set.add(s); return true;
    };
    const bind = (name: ts.BindingName, set: Set<ts.Symbol>): boolean => {
      if (ts.isIdentifier(name)) return mark(set, name);
      let changed = false;
      for (const element of name.elements) if (ts.isBindingElement(element)) changed = bind(element.name, set) || changed;
      return changed;
    };
    const nameOf = (n: ts.Node) => ts.isIdentifier(n) || ts.isStringLiteral(n) ? n.text : '';
    const isSink = (n: ts.Expression): boolean =>
      (ts.isIdentifier(n) && (sinkNames.has(n.text) || sinks.has(symbol(n)!))) ||
      (ts.isPropertyAccessExpression(n) && sinkNames.has(n.name.text)) ||
      (ts.isElementAccessExpression(n) && sinkNames.has(nameOf(n.argumentExpression)));
    const canonicalSafeModule = (text: string) => /^server\/utils\/core4-(?:reader-credential|contributor-credential|admin-policy)(?:\.c?js)?$/.test(
      path.posix.normalize(path.posix.join(path.posix.dirname(source.fileName), text)));
    const trustedRequire = (n: ts.Node) => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'require' &&
      n.arguments.length === 1 && ts.isStringLiteral(n.arguments[0]) && canonicalSafeModule(n.arguments[0].text);
    const bindRequestParts = (name: ts.BindingName): boolean => {
      if (ts.isIdentifier(name)) return mark(requestAliases, name);
      let changed = false;
      if (ts.isObjectBindingPattern(name)) for (const entry of name.elements) {
        if (nameOf(entry.propertyName ?? entry.name) === 'headers') changed = bind(entry.name, tainted) || changed;
        if (entry.dotDotDotToken) changed = bind(entry.name, requestAliases) || changed;
      }
      return changed;
    };
    for (const node of nodes) {
      // Express handlers take the request first; also recognize an explicit
      // Request annotation elsewhere. Do not mistake later outbound-client
      // options parameters for caller requests merely because they have headers.
      if (ts.isParameter(node) && ((node.parent as ts.SignatureDeclaration).parameters[0] === node ||
        (node.type && /^(?:Express\.)?Request(?:<|$)/.test(node.type.getText(source))))) bindRequestParts(node.name);
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === 'node-fetch' && node.importClause?.name) mark(sinks, node.importClause.name);
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && canonicalSafeModule(node.moduleSpecifier.text)) {
        const bindings = node.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) for (const entry of bindings.elements) {
          if (safeNames.has((entry.propertyName ?? entry.name).text)) mark(safe, entry.name);
        }
      }
      if (ts.isVariableDeclaration(node) && node.initializer && trustedRequire(node.initializer) && ts.isObjectBindingPattern(node.name)) {
        for (const entry of node.name.elements) if (safeNames.has(nameOf(entry.propertyName ?? entry.name))) mark(safe, entry.name);
      }
      if (ts.isBindingElement(node) && sinkNames.has(nameOf(node.propertyName ?? node.name))) mark(sinks, node.name);
      if (ts.isImportSpecifier(node) && sinkNames.has((node.propertyName ?? node.name).text)) mark(sinks, node.name);
    }
    // Wrappers are safe only if EVERY return calls a verified policy helper.
    // No function-name exception: changing a wrapper to return raw headers
    // automatically removes this proof and fails the repository guard.
    for (const node of nodes) if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      const expressions: ts.Expression[] = [];
      const collect = (n: ts.Node) => {
        if (n !== node.body && ts.isFunctionLike(n)) return;
        if (ts.isReturnStatement(n) && n.expression) expressions.push(n.expression);
        ts.forEachChild(n, collect);
      };
      collect(node.body);
      if (expressions.length && expressions.every(n => ts.isCallExpression(n) && safe.has(symbol(n.expression)!))) mark(safe, node.name);
    }
    const isRequest = (n: ts.Expression): boolean => ts.isIdentifier(n) &&
      (['req', 'request'].includes(n.text) || requestAliases.has(symbol(n)!));
    const dirty = (n: ts.Node): boolean => {
      if (ts.isIdentifier(n)) return tainted.has(symbol(n)!);
      if (ts.isShorthandPropertyAssignment(n)) return tainted.has(checker.getShorthandAssignmentValueSymbol(n)!);
      if (ts.isPropertyAccessExpression(n) && n.name.text === 'headers' && isRequest(n.expression)) return true;
      if (ts.isElementAccessExpression(n) && nameOf(n.argumentExpression) === 'headers' && isRequest(n.expression)) return true;
      if (ts.isCallExpression(n)) {
        if (safe.has(symbol(n.expression)!)) return false;
        const callee = n.expression;
        if (ts.isPropertyAccessExpression(callee) && ['get', 'header'].includes(callee.name.text) && isRequest(callee.expression)) return true;
        if (ts.isElementAccessExpression(callee) && ['get', 'header'].includes(nameOf(callee.argumentExpression)) && isRequest(callee.expression)) return true;
        return returns.has(symbol(n.expression)!) || n.arguments.some(dirty);
      }
      if (ts.isFunctionLike(n)) return false;
      if (ts.isPropertyAssignment(n)) return dirty(n.initializer);
      let result = false;
      ts.forEachChild(n, child => { if (dirty(child)) result = true; });
      return result;
    };
    let changed = true;
    while (changed) {
      changed = false;
      for (const n of nodes) {
        if (ts.isVariableDeclaration(n) && n.initializer) {
          if (dirty(n.initializer)) changed = bind(n.name, tainted) || changed;
          if (isRequest(n.initializer)) changed = bindRequestParts(n.name) || changed;
          if (isSink(n.initializer)) changed = bind(n.name, sinks) || changed;
          if (safe.has(symbol(n.initializer)!)) changed = bind(n.name, safe) || changed;
        }
        if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          if (dirty(n.right)) changed = mark(tainted, n.left) || changed;
          if (isSink(n.right)) changed = mark(sinks, n.left) || changed;
        }
        if (ts.isReturnStatement(n) && n.expression && dirty(n.expression)) {
          let owner = n.parent;
          while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
          if (owner && ts.isFunctionDeclaration(owner) && owner.name) changed = mark(returns, owner.name) || changed;
          if (owner && (ts.isArrowFunction(owner) || ts.isFunctionExpression(owner)) && ts.isVariableDeclaration(owner.parent)) changed = bind(owner.parent.name, returns) || changed;
        }
        if (ts.isArrowFunction(n) && !ts.isBlock(n.body) && dirty(n.body) && ts.isVariableDeclaration(n.parent)) changed = bind(n.parent.name, returns) || changed;
      }
    }
    for (const n of nodes) if (ts.isCallExpression(n) && isSink(n.expression) && n.arguments.some(dirty)) {
      const line = source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1;
      violations.push(`${source.fileName}:${line}: caller headers reach ${n.expression.getText(source)}`);
    }
  }
  return violations;
}
