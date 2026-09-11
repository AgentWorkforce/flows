import type * as ts from "typescript/lib/tsserverlibrary";
import { DIAGNOSTICS, DIAGNOSTIC_SOURCE } from "../diagnostics";

// Mirrors assertFlowHeader in surface/src/flow.ts. SDK parity fixtures pin
// these three closed lists without importing or executing author code in tsserver.
const HEADER_KEYS = ["identity", "memory", "budget", "tools", "workspace"];
const NESTED_KEYS: Record<string, readonly string[]> = {
  memory: ["script", "agent"],
  tools: ["relayfile", "mcp", "slack"],
};

export function headerKeyDiagnostics(
  typescript: typeof ts,
  checker: ts.TypeChecker,
  file: ts.SourceFile,
): ts.Diagnostic[] {
  const diagnostics: ts.Diagnostic[] = [];

  function unwrap(node: ts.Expression): ts.Expression {
    while (typescript.isParenthesizedExpression(node)
      || typescript.isAsExpression(node)
      || typescript.isTypeAssertionExpression(node)
      || typescript.isSatisfiesExpression(node)) node = node.expression;
    return node;
  }

  function propertyName(name: ts.PropertyName): string | undefined {
    if (typescript.isIdentifier(name) || typescript.isStringLiteral(name)
      || typescript.isNumericLiteral(name)) return name.text;
    if (typescript.isComputedPropertyName(name)
      && typescript.isStringLiteral(name.expression)) return name.expression.text;
    return undefined;
  }

  function fromSurface(node: ts.Node): boolean {
    while (!typescript.isImportDeclaration(node) && node.parent) node = node.parent;
    return typescript.isImportDeclaration(node)
      && typescript.isStringLiteral(node.moduleSpecifier)
      && node.moduleSpecifier.text === "@relayflows/surface"
      && node.importClause?.isTypeOnly === false;
  }

  function isFlowCall(expression: ts.Expression): boolean {
    const target = unwrap(expression);
    if (typescript.isIdentifier(target)) {
      return checker.getSymbolAtLocation(target)?.declarations?.some((declaration) =>
        typescript.isImportSpecifier(declaration) && !declaration.isTypeOnly
        && (declaration.propertyName ?? declaration.name).text === "flow"
        && fromSurface(declaration)) === true;
    }
    if (typescript.isPropertyAccessExpression(target) && target.name.text === "flow") {
      return checker.getSymbolAtLocation(target.expression)?.declarations?.some((declaration) =>
        typescript.isNamespaceImport(declaration) && fromSurface(declaration)) === true;
    }
    return false;
  }

  function inspect(object: ts.ObjectLiteralExpression, allowed: readonly string[], at: string): void {
    for (const [index, property] of object.properties.entries()) {
      if (!property.name) continue;
      const key = propertyName(property.name);
      if (key === undefined) continue;
      // An object literal's __proto__ setter is not an own header field.
      if (key === "__proto__" && typescript.isPropertyAssignment(property)
        && !typescript.isComputedPropertyName(property.name)) continue;
      if (!allowed.includes(key)) {
        const suggestion = nearestKey(key, allowed);
        diagnostics.push({
          file,
          start: property.name.getStart(file),
          length: property.name.getWidth(file),
          category: typescript.DiagnosticCategory.Error,
          code: DIAGNOSTICS.UNKNOWN_HEADER_KEY,
          source: DIAGNOSTIC_SOURCE,
          messageText: `${at}: unknown field ${JSON.stringify(key)}.`
            + (suggestion === undefined ? "" : ` Did you mean ${JSON.stringify(suggestion)}?`),
        });
      } else if (at === "flow header" && Object.hasOwn(NESTED_KEYS, key)
        && typescript.isPropertyAssignment(property)) {
        // A later spread/computed field can replace this entire nested object.
        const replaced = object.properties.slice(index + 1).some((later) =>
          !later.name || propertyName(later.name) === undefined || propertyName(later.name) === key);
        const value = unwrap(property.initializer);
        if (!replaced && typescript.isObjectLiteralExpression(value)) {
          inspect(value, NESTED_KEYS[key]!, `${at}.${key}`);
        }
      }
    }
  }

  function visit(node: ts.Node): void {
    if (typescript.isCallExpression(node) && node.arguments.length === 3 && isFlowCall(node.expression)) {
      const header = unwrap(node.arguments[1]!);
      if (typescript.isObjectLiteralExpression(header)) inspect(header, HEADER_KEYS, "flow header");
    }
    typescript.forEachChild(node, visit);
  }
  visit(file);
  return diagnostics;
}

/** Exact Levenshtein distance, with work bounded by the short allowlisted keys. */
function nearestKey(key: string, allowed: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = 3;
  for (const candidate of allowed) {
    if (Math.abs(key.length - candidate.length) > 2) continue;
    let previous = Array.from({ length: candidate.length + 1 }, (_, index) => index);
    for (let row = 1; row <= key.length; row++) {
      const current = [row];
      for (let column = 1; column <= candidate.length; column++) {
        current[column] = Math.min(
          current[column - 1]! + 1,
          previous[column]! + 1,
          previous[column - 1]! + (key[row - 1] === candidate[column - 1] ? 0 : 1),
        );
      }
      previous = current;
    }
    const distance = previous[candidate.length]!;
    if (distance < bestDistance) { bestDistance = distance; best = candidate; }
  }
  return best;
}
