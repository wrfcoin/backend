import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const assetDirs = ['static', 'templates'];
const runtimeSourceDirs = [
  'api',
  'blockchain',
  'config',
  'database',
  'graphql',
  'middleware',
  'routes',
  'server',
  'services',
  'shared',
  'src',
  // Root-level `utils/` was missing, so CommonJS modules there got no `.cjs`
  // shim and ESM importers of them were unloadable in the build — the same
  // defect class as #935's `error-response.js`, in two more places
  // (automatedRegulatoryReportingController, automated-regulatory-reporting-service
  // both import `utils/privacy-preserving-logger.js`).
  'utils',
];
// hsm-signer.ts loads this CommonJS implementation at runtime. The production
// image copies only dist/, so the module must be placed inside that boundary.
const runtimeModuleFiles = [
  'security/hsm-secure-implementation.cjs',
];
// tsconfig includes server/__tests__ in the emitted tree. The repaired auth
// suites share this CommonJS mock helper, so copy it when that test source tree
// is present. Unlike runtimeModuleFiles, it is not required in the script's
// minimal production-layout fixtures.
const emittedTestSupportFiles = [
  'server/__tests__/support/drizzle-chain-mock.cjs',
];
// This legacy demo entrypoint is not declared by package.json or any Docker
// target and depends on a monorepo-level contract analyzer that the standalone
// backend repository and runtime image do not contain. Do not misclassify it as
// a shippable runtime entrypoint merely because it is a source .js file.
const excludedRuntimeSourceFiles = new Set(['server/minimal_api_server.js']);
const legacyServerEntrypoint = `// Compatibility entrypoint for legacy testnet process commands.
// The production Dockerfile starts dist/server/enhanced_unified_api_optimized.js
// directly, but older N5 deployments have used "node dist/server.cjs".
import('./server/enhanced_unified_api_optimized.js').catch((error) => {
  console.error('[legacy server.cjs] failed to start optimized API entrypoint', error);
  process.exit(1);
});
`;

await mkdir('dist', { recursive: true });

for (const assetDir of assetDirs) {
  const destination = path.join('dist', assetDir);

  if (existsSync(assetDir)) {
    await cp(assetDir, destination, { recursive: true });
    continue;
  }

  await mkdir(destination, { recursive: true });
}

async function copyJsOnlyRuntimeSources(sourceDir) {
  if (!existsSync(sourceDir)) {
    return;
  }

  const entries = await readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);

    if (excludedRuntimeSourceFiles.has(sourcePath.split(path.sep).join('/'))) {
      continue;
    }

    if (entry.isDirectory()) {
      await copyJsOnlyRuntimeSources(sourcePath);
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith('.js')) {
      continue;
    }

    const tsPeer = sourcePath.replace(/\.js$/, '.ts');
    const tsxPeer = sourcePath.replace(/\.js$/, '.tsx');
    if (existsSync(tsPeer) || existsSync(tsxPeer)) {
      continue;
    }

    const destinationPath = path.join('dist', sourcePath);
    await mkdir(path.dirname(destinationPath), { recursive: true });
    await cp(sourcePath, destinationPath);

    if (await isCommonJsSource(sourcePath)) {
      await writeFile(
        destinationPath.replace(/\.js$/, '.cjs'),
        await rewriteCommonJsRequires(sourcePath),
      );
    }
  }
}

for (const sourcePath of excludedRuntimeSourceFiles) {
  const destinationPath = path.join('dist', sourcePath);
  await rm(destinationPath, { force: true });
  await rm(destinationPath.replace(/\.js$/, '.cjs'), { force: true });
}

for (const sourceDir of runtimeSourceDirs) {
  await copyJsOnlyRuntimeSources(sourceDir);
}

for (const sourcePath of runtimeModuleFiles) {
  if (!existsSync(sourcePath)) {
    throw new Error(`required runtime module is missing: ${sourcePath}`);
  }
  const destinationPath = path.join('dist', sourcePath);
  await mkdir(path.dirname(destinationPath), { recursive: true });
  await cp(sourcePath, destinationPath);
}

for (const sourcePath of emittedTestSupportFiles) {
  if (!existsSync(sourcePath)) {
    continue;
  }
  const destinationPath = path.join('dist', sourcePath);
  await mkdir(path.dirname(destinationPath), { recursive: true });
  await cp(sourcePath, destinationPath);
}

// documentation-routes.js loads this index and the indexed Markdown files at
// runtime. Production images contain only dist/, so source-tree existence is
// not enough: copy the complete checked-in documentation contract into the
// image boundary and refuse unsafe or missing paths while building.
const documentationIndexPath = 'server/data/documentation-index.json';
const documentationIndex = JSON.parse(
  await readFile(documentationIndexPath, 'utf8'),
);
const documentationAssets = [
  documentationIndexPath,
  ...documentationIndex.map((entry) => entry.path),
];
for (const sourcePath of documentationAssets) {
  const normalized = path.posix.normalize(sourcePath.replaceAll('\\', '/'));
  if (
    normalized.startsWith('../') ||
    path.posix.isAbsolute(normalized) ||
    (sourcePath !== documentationIndexPath && !normalized.startsWith('docs/'))
  ) {
    throw new Error(`unsafe documentation runtime path: ${sourcePath}`);
  }
  if (!existsSync(normalized)) {
    throw new Error(`required documentation runtime asset is missing: ${normalized}`);
  }
  const destinationPath = path.join('dist', normalized);
  await mkdir(path.dirname(destinationPath), { recursive: true });
  await cp(normalized, destinationPath);
}

await writeFile(path.join('dist', 'server.cjs'), legacyServerEntrypoint);

// Must run last: it rewrites emitted output, so every `.js` and `.cjs` this
// script produces has to exist first.
await repairEmittedModuleInterop('dist');

/**
 * Re-point ESM `import ... from './x.js'` at the emitted `./x.cjs` shim.
 *
 * The CommonJS half of this already existed (`rewriteCommonJsRequires`), but it
 * only runs on sources that are themselves CommonJS. An **ESM** module importing
 * a CommonJS sibling was copied verbatim, so its `.js` specifier survived into
 * `dist/` — and under the package's `"type": "module"` that specifier names an
 * ESM file whose `module.exports` provides no bindings at all:
 *
 *   SyntaxError: The requested module '../server/utils/error-response.js'
 *   does not provide an export named 'default'
 *
 * That is not a startup crash. `safeMount` catches it, logs a warn, and leaves
 * the router unmounted — so `/api/governance` answered 404 in the built
 * artifact while the source tree resolved perfectly and the service reported
 * healthy (backend#935, found by review of the production seam).
 *
 * Only rewrites when the `.cjs` sibling actually exists in `dist`, so a
 * specifier pointing at a genuine ESM module is left alone.
 */
async function repairEmittedModuleInterop(root) {
  for (const file of await collectJsFiles(root)) {
    const source = await readFile(file, 'utf8');
    const fromDir = path.dirname(file);
    // The import rewrite below only matters for ESM output, but the require
    // rewrite after it applies to EVERY emitted file: tsc emits
    // `require('./x')` into files that carry no import/export at all, and an
    // earlier revision skipped exactly those — which left
    // module-controller-routes broken while claiming to fix the class.
    let rewritten = source.replace(
      // `from './x.js'`, `import './x.js'`, and dynamic `import('./x.js')`.
      /((?:from|import)\s*\(?\s*)(['"])(\.{1,2}\/[^'"]+)\.js\2/g,
      (match, lead, quote, specifier) => {
        const shim = path.join(fromDir, `${specifier}.cjs`);
        if (!existsSync(shim)) {
          return match;
        }
        return `${lead}${quote}${specifier}.cjs${quote}`;
      },
    );

    // Relative `require('./x')` or `require('./x.js')` emitted by tsc into an
    // ESM module.
    //
    // `rewriteCommonJsRequires` already does this, but only for files copied
    // as CommonJS SOURCES. A TypeScript file compiled by tsc never goes through
    // that path, so its `require('../../utils/module_controller')` reached
    // dist/ unchanged. Under `"type": "module"` the extensionless resolution
    // lands on the ESM-classified `.js`, and the require fails with
    //   Cannot find module '../../utils/module_controller'
    // which safeMount swallows — /api/modules has been 404ing in production.
    // Same defect class as the import case above: the shim is emitted, the
    // specifier just never points at it.
    rewritten = rewritten.replace(
      /(\brequire\(\s*)(['"])(\.{1,2}\/[^'"]+)\2/g,
      (match, lead, quote, specifier) => {
        const extension = path.extname(specifier);
        if (extension && extension !== '.js') {
          return match;
        }

        const shimSpecifier =
          extension === '.js'
            ? `${specifier.slice(0, -'.js'.length)}.cjs`
            : `${specifier}.cjs`;
        const shim = path.join(fromDir, shimSpecifier);
        if (!existsSync(shim)) {
          return match;
        }
        return `${lead}${quote}${shimSpecifier}${quote}`;
      },
    );

    // TypeScript preserves hand-written `require()` calls. Because this
    // package is `"type": "module"`, emitted files containing an ESM
    // import/export have no ambient CommonJS `require`; merely repointing the
    // specifier at a valid `.cjs` shim is not enough. Install a file-local
    // createRequire binding in every emitted ESM module that actually invokes
    // require. This is deliberately build-wide rather than a route allowlist:
    // safeMount can otherwise hide the next occurrence as another healthy 404.
    rewritten = installCreateRequireInEsm(file, rewritten);

    if (rewritten !== source) {
      await writeFile(file, rewritten);
    }
  }
}

function installCreateRequireInEsm(file, source) {
  if (!/^\s*(import|export)\s/m.test(source)) {
    return source;
  }

  const syntax = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );

  let invokesRequire = false;
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require'
    ) {
      invokesRequire = true;
      return;
    }
    if (!invokesRequire) {
      ts.forEachChild(node, visit);
    }
  };
  visit(syntax);

  if (!invokesRequire || hasTopLevelRequireBinding(syntax)) {
    return source;
  }

  const binding =
    `import { createRequire as __wrfBuildCreateRequire } from 'node:module';\n` +
    `const require = __wrfBuildCreateRequire(import.meta.url);\n`;
  if (!source.startsWith('#!')) {
    return `${binding}${source}`;
  }

  const firstNewline = source.indexOf('\n');
  if (firstNewline === -1) {
    return `${source}\n${binding}`;
  }
  return `${source.slice(0, firstNewline + 1)}${binding}${source.slice(firstNewline + 1)}`;
}

function hasTopLevelRequireBinding(syntax) {
  for (const statement of syntax.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === 'require'
    ) {
      return true;
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === 'require'
        ) {
          return true;
        }
      }
    }

    if (ts.isImportDeclaration(statement) && statement.importClause) {
      const { importClause } = statement;
      if (importClause.name?.text === 'require') {
        return true;
      }
      if (
        importClause.namedBindings &&
        ts.isNamespaceImport(importClause.namedBindings) &&
        importClause.namedBindings.name.text === 'require'
      ) {
        return true;
      }
      if (
        importClause.namedBindings &&
        ts.isNamedImports(importClause.namedBindings) &&
        importClause.namedBindings.elements.some(
          (element) => element.name.text === 'require',
        )
      ) {
        return true;
      }
    }
  }

  return false;
}

async function collectJsFiles(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await collectJsFiles(full)));
    } else if (entry.isFile() && full.endsWith('.js')) {
      found.push(full);
    }
  }
  return found;
}

async function isCommonJsSource(sourcePath) {
  const source = await readFile(sourcePath, 'utf8');
  if (/^\s*(import|export)\s/m.test(source)) {
    return false;
  }
  return /\b(require\s*\(|module\.exports|exports\.)/.test(source);
}

async function rewriteCommonJsRequires(sourcePath) {
  const source = await readFile(sourcePath, 'utf8');

  return source.replace(
    /require\((['"])(\.{1,2}\/[^'"]+)\1\)/g,
    (match, quote, specifier) => {
      if (path.extname(specifier)) {
        return match;
      }

      const fromDir = path.dirname(sourcePath);

      // Case 1: `require('./x')` resolving to a sibling CommonJS file `./x.js`.
      // Re-point it at the emitted `./x.cjs` shim so the require keeps working
      // under the package's `"type": "module"` setting.
      const fileTarget = path.normalize(path.join(fromDir, `${specifier}.js`));
      if (
        existsSync(fileTarget) &&
        !existsSync(fileTarget.replace(/\.js$/, '.ts')) &&
        !existsSync(fileTarget.replace(/\.js$/, '.tsx')) &&
        isCommonJsSourceSync(fileTarget)
      ) {
        return `require(${quote}${specifier}.cjs${quote})`;
      }

      // Case 2: `require('./dir')` resolving to a directory whose `index.js`
      // is CommonJS. Node's directory resolution would otherwise pick the
      // ESM-classified `index.js` (because of `"type": "module"`), which
      // breaks. Re-point it at the emitted `./dir/index.cjs` shim.
      const indexTarget = path.normalize(
        path.join(fromDir, specifier, 'index.js'),
      );
      if (
        existsSync(indexTarget) &&
        !existsSync(indexTarget.replace(/\.js$/, '.ts')) &&
        !existsSync(indexTarget.replace(/\.js$/, '.tsx')) &&
        isCommonJsSourceSync(indexTarget)
      ) {
        const normalizedSpecifier = specifier.replace(/\/+$/, '');
        return `require(${quote}${normalizedSpecifier}/index.cjs${quote})`;
      }

      return match;
    },
  );
}

function isCommonJsSourceSync(sourcePath) {
  const source = existsSync(sourcePath) ? readFileSync(sourcePath, 'utf8') : '';
  if (/^\s*(import|export)\s/m.test(source)) {
    return false;
  }
  return /\b(require\s*\(|module\.exports|exports\.)/.test(source);
}
