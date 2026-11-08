/** The old communication runtime required a broker-managed PTY. */
export function requireCommunicationCli(cli: string | undefined): void {
  if (!cli?.trim()) throw new Error('Agent communication requires a declared CLI');
  throw new Error('Agent communication through broker/PTy was removed; native node-spawn communication is not admitted yet');
}
