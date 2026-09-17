import { describe, expect, it } from "vitest";
import * as triggers from "../src/triggers/index.js";
import { providerEventTypes } from "../src/triggers/index.js";

const identifier = (value: string): string => value.replaceAll(/[^A-Za-z0-9_$]/g, "_");

describe("trigger namespaces for every relayfile adapter", () => {
  it("covers every provider the adapter catalog can deliver, not only slack and github", () => {
    const providers = Object.keys(providerEventTypes);
    expect(providers.length).toBeGreaterThanOrEqual(40);
    for (const expected of ["github", "slack", "linear", "jira", "notion", "gitlab", "cloudflare", "ramp", "neon", "shortcut", "gmail", "hubspot", "azure-blob", "google-drive"]) {
      expect(providers, expected).toContain(expected);
    }
  });

  it("exports one frozen namespace per provider whose methods lower to that provider's registry events", () => {
    for (const [provider, events] of Object.entries(providerEventTypes)) {
      const namespace = (triggers as Record<string, unknown>)[identifier(provider)] as Record<string, (arg?: unknown) => { name: string; filter?: Record<string, unknown> }>;
      expect(namespace, provider).toBeDefined();
      expect(Object.isFrozen(namespace), provider).toBe(true);
      for (const event of events) {
        // Slack's `app_mention` is reachable through the `mention(channel)` shorthand only.
        if (provider === "slack" && event === "app_mention") continue;
        const method = namespace[identifier(event)];
        expect(typeof method, `${provider}.${identifier(event)}`).toBe("function");
        if (method === undefined) continue;
        const source = method();
        expect(source.name).toBe(provider);
        expect(source.filter).toMatchObject({ provider, type: event });
      }
    }
  });

  it("keeps hyphenated provider ids as valid identifiers and exact inbox names", () => {
    expect(triggers.azure_blob).toBeDefined();
    expect(triggers.google_drive).toBeDefined();
    const source = triggers.azure_blob["file_created"]!();
    expect(source).toMatchObject({ kind: "webhook", name: "azure-blob", filter: { provider: "azure-blob", type: "file.created" } });
  });

  it("gives catalog-only providers the plain filter signature", () => {
    // linear ships no mapping YAML; its events come from KNOWN_TRIGGER_CATALOG.
    const events = providerEventTypes.linear;
    expect(events.length).toBeGreaterThan(10);
    const first = events[0]!;
    const source = triggers.linear[identifier(first) as keyof typeof triggers.linear]({ team: "ENG" } as never);
    expect(source.filter).toEqual({ provider: "linear", type: first, payload: { team: "ENG" } });
  });
});
