// Publication redactions only: preserve task text, tool calls and results.
// This is metadata minimization, not a general credential scanner.
export function sanitizeTranscript(text: string): string {
  function scrubText(value: string): string {
    return value
      .replace(/\/(?:Users|home)\/[^\s/"\\]+/g, "/home/REDACTED")
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "redacted@example.invalid")
      .replace(/((?:Author|Committer):\s*)[^\n<]+(?=\s*<)/g, "$1REDACTED ")
      .replace(/([d\-l][rwxstST\-]{9}[@+]?\s+\d+\s+)\S+\s+\S+(\s+\d+\s)/g, "$1REDACTED REDACTED$2");
  }
  function scrub(value: unknown): unknown {
    if (typeof value === "string") return scrubText(value);
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (record.type === "system" && record.subtype === "init") {
        return { type: "system", subtype: "init", model: record.model, redacted: "host metadata" };
      }
      return Object.fromEntries(Object.entries(record)
        .filter(([key]) => !["session_id", "uuid", "cwd", "mcp_servers", "plugins", "permissionMode"].includes(key))
        .map(([key, item]) => [key, scrub(item)]));
    }
    return value;
  }
  return text.split("\n").map((line) => {
    try { return JSON.stringify(scrub(JSON.parse(line))); } catch { return scrubText(line); }
  }).join("\n");
}
