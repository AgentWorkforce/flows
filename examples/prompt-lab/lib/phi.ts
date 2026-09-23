// A deterministic floor under Patient QA: things an invented chart may never
// carry, whatever a model thinks of it. Not a de-identification tool.
const RULES: [RegExp, string][] = [
  [/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/, "a calendar date"],
  [/\b(19|20)\d{2}-\d{2}-\d{2}\b/, "an ISO date"],
  [/\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/, "a phone number"],
  [/\bMRN\b|\b\d{7,}\b/i, "a record number"],
  [/\b\d+\s+[A-Z][a-z]+\s+(Street|St|Avenue|Ave|Road|Rd|Lane|Ln|Drive|Dr)\b/, "a street address"],
];

export function identifiers(text: string): string[] {
  return RULES.filter(([re]) => re.test(text)).map(([, what]) => `contains ${what}`);
}
