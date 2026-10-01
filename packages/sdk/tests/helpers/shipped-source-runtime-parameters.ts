import ts from 'typescript';

/** TypeScript's synthetic `this` parameter has no corresponding runtime argument. */
export function runtimeParameters(
  declaration: ts.SignatureDeclaration,
): readonly ts.ParameterDeclaration[] {
  return declaration.parameters.filter(parameter =>
    !ts.isIdentifier(parameter.name) || parameter.name.text !== 'this');
}
