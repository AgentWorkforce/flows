import type * as ts from "typescript/lib/tsserverlibrary";
import { headerKeyDiagnostics } from "./rules/header-keys";

function init(modules: { typescript: typeof ts }): ts.server.PluginModule {
  const typescript = modules.typescript;
  return {
    create(info) {
      const service = info.languageService;
      const proxy = Object.create(null) as ts.LanguageService;
      for (const key of Object.keys(service) as Array<keyof ts.LanguageService>) {
        const method = service[key];
        // Preserve the underlying service's receiver for every delegated method.
        Object.defineProperty(proxy, key, {
          value: typeof method === "function" ? method.bind(service) : method,
          writable: true,
          enumerable: true,
        });
      }
      proxy.getSemanticDiagnostics = (fileName) => {
        const prior = service.getSemanticDiagnostics(fileName);
        const program = service.getProgram();
        const file = program?.getSourceFile(fileName);
        if (!program || !file || file.isDeclarationFile) return prior;
        return [...prior, ...headerKeyDiagnostics(typescript, program.getTypeChecker(), file)];
      };
      return proxy;
    },
  };
}

export = init;
