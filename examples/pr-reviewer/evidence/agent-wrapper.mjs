#!/usr/bin/env node
import { receiveWrapperRequest } from '<checkout>/testdata/preflight/wrapper-session.mjs';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
if (process.argv[2] === 'auth') process.exit(0);
const request = await receiveWrapperRequest();
if (request) {
  if (!existsSync('.workforce/pr.diff')) { console.error('no diff materialized'); process.exit(3); }
  mkdirSync('.workforce', { recursive: true });
  writeFileSync('.workforce/review.md', '## Review\nLooks fine.\n\n## Addressed comments\n- none\nREADY\n');
  writeFileSync('a.js', 'export const a = 2; // reviewed\n'); // a "mechanical" edit
  console.log('review-written'); process.exit(0);
}
