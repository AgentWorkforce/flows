/** Compatibility preflight for the retired `transport: broker` surface. */
export function checkBrokerEnvironment(_cwd = process.cwd()): never {
  throw new Error(
    'transport: broker was removed. Use transport: relay for one-shot fleet execution; retained local sessions remain fail-closed.',
  );
}
