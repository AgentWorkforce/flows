import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isFlowName } from './bundle-transport.js';
import { cloudFetch, CloudFlowError, isCloudRecord, type CloudConnectionOptions } from './cloud-http.js';
import { prepareCachedFlowRuntime } from './cached-flow-runtime.js';

export interface NamedFlowSource {
  path: string;
  flowId: string;
  flowVersionId: string;
  sourceSha256: string;
  source: string;
}

/** Files win over names; paths and digest references retain their existing meaning. */
export async function resolveNamedFlow(
  value: string,
  options: CloudConnectionOptions & { cacheRoot?: string } = {},
): Promise<NamedFlowSource | undefined> {
  if (existsSync(value) || !isFlowName(value)) return undefined;
  const result = await cloudFetch(`/api/v1/flows/by-name/${encodeURIComponent(value)}`, options, { method: 'GET', detail: true });
  if (!isCloudRecord(result) || result.name !== value || result.fileType !== 'ts'
    || typeof result.source !== 'string' || Buffer.byteLength(result.source) > 256_000
    || typeof result.sourceSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(result.sourceSha256)
    || typeof result.flowId !== 'string' || !result.flowId
    || typeof result.versionId !== 'string' || !result.versionId) {
    throw new CloudFlowError('invalid_response', 'Cloud returned an invalid named .flow.ts source.');
  }
  const digest = (source: string | Buffer): string => createHash('sha256').update(source).digest('hex');
  if (digest(result.source) !== result.sourceSha256) {
    throw new CloudFlowError('invalid_response', `Source hash verification failed for flow "${value}".`);
  }
  const directory = join(options.cacheRoot ?? join(homedir(), '.agentworkforce', 'flows', 'cache'), value);
  const path = join(directory, `${result.sourceSha256}.flow.ts`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (existsSync(path)) {
    if (digest(await readFile(path)) !== result.sourceSha256) {
      throw new CloudFlowError('invalid_input', `Cached source hash verification failed: ${path}. Remove this file and retry.`);
    }
  } else {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, result.source, { mode: 0o600, flag: 'wx' });
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  }
  await prepareCachedFlowRuntime(directory);
  return { path, flowId: result.flowId, flowVersionId: result.versionId,
    sourceSha256: result.sourceSha256, source: result.source };
}
