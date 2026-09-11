import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import init from '../dist/index.js';

export function languageService(fileName, initialText = readFileSync(fileName, 'utf8')) {
  let text = initialText;
  let version = 0;
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    types: [],
  };
  const host = {
    getScriptFileNames: () => [fileName],
    getScriptVersion: (path) => path === fileName ? String(version) : '0',
    getScriptSnapshot: (path) => {
      const source = path === fileName ? text : ts.sys.readFile(path);
      return source === undefined ? undefined : ts.ScriptSnapshot.fromString(source);
    },
    getCurrentDirectory: () => dirname(fileName),
    getCompilationSettings: () => options,
    getDefaultLibFileName: ts.getDefaultLibFilePath,
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };
  const original = ts.createLanguageService(host);
  const service = init({ typescript: ts }).create({ languageService: original });
  return {
    original,
    service,
    diagnostics: () => service.getSemanticDiagnostics(fileName).filter((d) => d.source === 'relayflows'),
    update: (next) => { text = next; version++; },
    dispose: () => service.dispose(),
  };
}
