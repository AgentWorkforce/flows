import type { ClassifyOptions, ClassifyResult } from '@relayflows/surface';
import { classifyOptions, JEV_MODEL } from './classify-contract.js';
import type { CompletionReason } from './protocol.js';

export class JevError extends Error {
  constructor(readonly diagnostic: string, readonly completionReason: CompletionReason = 'worker_error') {
    super(`f.classify: ${diagnostic}`);
  }
}

/** Errors deliberately contain no provider body, request text, or credential. */
export async function askJev(
  raw: ClassifyOptions, environment: NodeJS.ProcessEnv = process.env, signal?: AbortSignal,
): Promise<ClassifyResult> {
  const options = classifyOptions(raw);
  signal?.throwIfAborted();
  try {
    const key = environment['TYPESAFE_API_KEY'];
    if (!key?.trim()) throw new JevError('typesafe_api_key_missing');
    const deadline = AbortSignal.timeout(options.timeoutMs);
    const combined = signal === undefined ? deadline : AbortSignal.any([deadline, signal]);
    try {
      const response = await globalThis.fetch('https://api.typesafe.ai/v1/systemone', {
        method: 'POST', redirect: 'manual', signal: combined,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: JEV_MODEL, state: options.state, questions: {
          classification: { type: 'choice', instructions: options.question, criteria: options.options },
        } }),
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw new JevError(`jev_http_${response.status}`);
      }
      const body = await boundedBody(response);
      const answer = body?.answers?.classification;
      if (answer?.type !== 'choice' || typeof answer.choice !== 'string'
        || !Object.hasOwn(options.options, answer.choice) || typeof answer.confidence !== 'number'
        || !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1) {
        throw new JevError('jev_invalid_answer', 'verification_failed');
      }
      if (answer.confidence < options.minConfidence) throw new JevError('jev_low_confidence', 'verification_failed');
      return { choice: answer.choice, confidence: answer.confidence, completionReason: 'success' };
    } catch (error) {
      // Losing the worker lease is never permission to complete with fallback.
      signal?.throwIfAborted();
      if (deadline.aborted) throw new JevError('jev_timeout', 'timeout');
      if (error instanceof JevError) throw error;
      throw new JevError('jev_network_error');
    }
  } catch (error) {
    if (!(error instanceof JevError) || options.fallback === undefined) throw error;
    return { choice: options.fallback, confidence: 0, completionReason: 'success', fallbackReason: error.diagnostic };
  }
}

async function boundedBody(response: Response): Promise<{ answers?: { classification?: { type?: unknown; choice?: unknown; confidence?: unknown } } }> {
  const reader = response.body?.getReader();
  if (!reader) throw new JevError('jev_invalid_answer', 'verification_failed');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16_384) {
        void reader.cancel().catch(() => undefined);
        throw new JevError('jev_response_too_large', 'verification_failed');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new JevError('jev_invalid_json', 'verification_failed'); }
}
