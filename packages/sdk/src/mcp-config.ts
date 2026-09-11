import type { McpServerConfig } from './spec.js';

/** Called on parsed project JSON before any process or connection is opened. */
export function parseMcpConfig(value: unknown): Record<string, McpServerConfig> {
  if (!record(value)) throw new Error('mcp must be a server map');
  const result: Record<string, McpServerConfig> = Object.create(null);
  for (const [name, config] of Object.entries(value)) {
    const invalid = (): never => { throw new Error(`mcp.${name} has an invalid server configuration`); };
    if (!name.trim() || !record(config)) invalid();
    const entry = config as Record<string, unknown>;
    const stdio = Object.hasOwn(entry, 'command');
    if (stdio === Object.hasOwn(entry, 'url')) invalid();
    const allowed = stdio ? ['command', 'args', 'env'] : ['url', 'headers'];
    if (Object.keys(entry).some(key => !allowed.includes(key))) invalid();
    if (stdio) {
      if (!nonempty(entry.command)) invalid();
      if (entry.args !== undefined && (!Array.isArray(entry.args)
        || !entry.args.every(arg => typeof arg === 'string' && !arg.includes('\0')))) invalid();
      if (entry.env !== undefined && (!Array.isArray(entry.env)
        || !entry.env.every(key => typeof key === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
        || new Set(entry.env).size !== entry.env.length)) invalid();
    } else {
      if (!nonempty(entry.url)) invalid();
      let url: URL;
      try { url = new URL(entry.url as string); } catch { invalid(); }
      if (!['http:', 'https:'].includes(url!.protocol) || url!.username || url!.password || url!.hash) invalid();
      if (entry.headers !== undefined) {
        if (!record(entry.headers) || !Object.values(entry.headers).every(v => typeof v === 'string')) invalid();
        try { new Headers(entry.headers as Record<string, string>); } catch { invalid(); }
      }
    }
    result[name] = entry as McpServerConfig;
  }
  return result;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('\0');
}
