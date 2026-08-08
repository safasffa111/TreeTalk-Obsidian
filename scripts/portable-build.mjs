import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
let ts;
try {
  ts = require('typescript');
} catch {
  const globalTypeScript = '/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript/lib/typescript.js';
  if (!fs.existsSync(globalTypeScript)) throw new Error('TypeScript is unavailable');
  ts = (await import(pathToFileURL(globalTypeScript).href)).default;
}

const root = process.cwd();
const srcRoot = path.join(root, 'src');
const output = path.join(root, 'main.js');

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

function normalize(parts) {
  const outputParts = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') outputParts.pop(); else outputParts.push(part);
  }
  return outputParts.join('/');
}

function resolveRelative(parentId, request, moduleMap) {
  const parentParts = parentId.split('/');
  parentParts.pop();
  const base = normalize(parentParts.concat(request.split('/')));
  const candidates = request.endsWith('.js') ? [base] : [base + '.js', base + '/index.js', base];
  return candidates.find((candidate) => moduleMap.has(candidate));
}

function transitiveModules(moduleMap, entryId) {
  const result = new Set();
  const visit = (id) => {
    if (result.has(id)) return;
    const code = moduleMap.get(id);
    if (code === undefined) throw new Error(`Missing worker module: ${id}`);
    result.add(id);
    for (const match of code.matchAll(/require\((['"])(\.\.?\/[^'"]+)\1\)/gu)) {
      const resolved = resolveRelative(id, match[2], moduleMap);
      if (resolved !== undefined) visit(resolved);
    }
  };
  visit(entryId);
  return [...result].sort();
}

function moduleBody(moduleMap, ids) {
  return ids.map((id) => `${JSON.stringify(id)}: function(module, exports, require) {\n${moduleMap.get(id)}\n\n}`).join(',\n');
}

function runtimeLoader(body, entryId, exportEntry) {
  return `"use strict";\n(function() {\n  const __externalRequire = typeof require === 'function' ? require : undefined;\n  const __modules = {\n${body}\n  };\n  const __cache = Object.create(null);\n  function __normalize(parts) {\n    const output = [];\n    for (const part of parts) {\n      if (!part || part === '.') continue;\n      if (part === '..') output.pop(); else output.push(part);\n    }\n    return output.join('/');\n  }\n  function __resolve(parentId, request) {\n    const parentParts = parentId.split('/');\n    parentParts.pop();\n    const base = __normalize(parentParts.concat(request.split('/')));\n    const candidates = request.endsWith('.js') ? [base] : [base + '.js', base + '/index.js', base];\n    for (const candidate of candidates) if (__modules[candidate]) return candidate;\n    throw new Error('TreeTalk bundle module not found: ' + request + ' from ' + parentId);\n  }\n  function __load(id) {\n    if (__cache[id]) return __cache[id].exports;\n    const factory = __modules[id];\n    if (!factory) throw new Error('TreeTalk bundle module not found: ' + id);\n    const module = { exports: {} };\n    __cache[id] = module;\n    const localRequire = (request) => request.startsWith('.')\n      ? __load(__resolve(id, request))\n      : (__externalRequire ? __externalRequire(request) : (() => { throw new Error('External module unavailable in TreeTalk worker: ' + request); })());\n    factory(module, module.exports, localRequire);\n    return module.exports;\n  }\n  ${exportEntry ? `module.exports = __load(${JSON.stringify(entryId)});` : `__load(${JSON.stringify(entryId)});`}\n})();\n`;
}

const files = walk(srcRoot).filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts')).sort();
const moduleMap = new Map();
for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  const result = ts.transpileModule(source, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      esModuleInterop: false,
      importHelpers: false,
      sourceMap: false,
      removeComments: false,
      useDefineForClassFields: true,
      verbatimModuleSyntax: false
    }
  });
  const errors = (result.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) {
    const host = { getCanonicalFileName: (name) => name, getCurrentDirectory: () => root, getNewLine: () => '\n' };
    throw new Error(ts.formatDiagnostics(errors, host));
  }
  const id = path.relative(srcRoot, file).replaceAll(path.sep, '/').replace(/\.ts$/u, '.js');
  moduleMap.set(id, result.outputText.trimEnd());
}

const workerEntry = 'relationship-graph/worker-entry.js';
const workerIds = transitiveModules(moduleMap, workerEntry);
const workerBundle = runtimeLoader(moduleBody(moduleMap, workerIds), workerEntry, false);
moduleMap.set('relationship-graph/worker-source.js', `"use strict";\nObject.defineProperty(exports, "__esModule", { value: true });\nexports.embeddedRelationshipGraphWorkerSource = ${JSON.stringify(workerBundle)};`);

const allIds = [...moduleMap.keys()].sort();
const mainBundle = `"use strict";\n// TreeTalk portable production bundle generated from TypeScript source.\n${runtimeLoader(moduleBody(moduleMap, allIds), 'main.js', true)}`;
fs.writeFileSync(output, mainBundle);
console.log(`portable bundle: ${allIds.length} modules -> ${output}`);
console.log(`embedded worker: ${workerIds.length} modules -> relationship-graph/worker-entry.js`);
