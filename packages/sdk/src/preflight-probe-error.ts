import type { CliProbeFailureDetail } from './preflight.js';

export class CliProbeError extends Error {
  constructor(readonly detail: CliProbeFailureDetail) {
    super('CLI probe failed');
  }
}
