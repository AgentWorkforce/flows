import { writeFileSync } from 'node:fs';
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid }));
process.exit(1);
