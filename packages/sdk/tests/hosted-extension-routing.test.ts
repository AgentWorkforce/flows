import { describe, expect, it } from 'vitest';
import { github } from '@relayflows/surface';
import { extensionHandlerForHostedDispatch } from '../src/flow-extension-loader.js';
import { hostedExtensionDispatchFromVerifiedDelivery } from '../src/index.js';
import { hostedManifestRoutes } from '../src/hosted-extension-isolation.js';
import { supportsHostedSandboxFlags } from '../src/hosted-extension-sandbox.js';

describe('hosted extension routing policy', () => {
  it('accepts only Node releases that implement every sandbox flag', () => {
    expect(supportsHostedSandboxFlags('22.12.0')).toBe(false);
    expect(supportsHostedSandboxFlags('22.13.0')).toBe(true);
    expect(supportsHostedSandboxFlags('23.4.0')).toBe(false);
    expect(supportsHostedSandboxFlags('23.5.0')).toBe(true);
    expect(supportsHostedSandboxFlags('24.0.0')).toBe(true);
    expect(supportsHostedSandboxFlags('not-a-version')).toBe(false);
  });

  it('matches the SDK router for exact, absent, duplicate, and generic-overlap routes', () => {
    const body = async () => {};
    const specific = { name: 'specific', handlers: [{ trigger: github.pull_request('labeled'), body }] };
    const duplicate = { name: 'duplicate', handlers: [{ trigger: github.pull_request('labeled'), body }] };
    const generic = { name: 'generic', handlers: [{ trigger: github.pull_request(), body }] };
    const labeled = hostedExtensionDispatchFromVerifiedDelivery({
      provider: 'github', eventType: 'pull_request.labeled', deliveryId: 'delivery-1',
    });
    const edited = hostedExtensionDispatchFromVerifiedDelivery({
      provider: 'github', eventType: 'pull_request.edited', deliveryId: 'delivery-2',
    });
    expect(extensionHandlerForHostedDispatch(labeled, [specific])?.extension.name).toBe('specific');
    expect(hostedManifestRoutes(
      { triggers: [{ provider: 'github', event: 'pull_request', actions: ['labeled'] }] },
      { provider: 'github', event: 'pull_request', action: 'labeled' },
    )).toBe(true);
    expect(extensionHandlerForHostedDispatch(edited, [specific])).toBeUndefined();
    expect(hostedManifestRoutes(
      { triggers: [{ provider: 'github', event: 'pull_request', actions: ['labeled'] }] },
      { provider: 'github', event: 'pull_request', action: 'edited' },
    )).toBe(false);
    expect(() => extensionHandlerForHostedDispatch(labeled, [specific, duplicate]))
      .toThrow(expect.objectContaining({ code: 'plugin_event_ambiguous' }));
    expect(() => extensionHandlerForHostedDispatch(labeled, [specific, generic]))
      .toThrow(expect.objectContaining({ code: 'plugin_event_ambiguous' }));
    expect(() => extensionHandlerForHostedDispatch({
      provenance: 'integration-watch', provider: 'github', eventType: 'pull_request.labeled', deliveryId: 'delivery-1',
    }, [specific])).toThrow(expect.objectContaining({ code: 'plugin_event_unroutable' }));
  });
});
