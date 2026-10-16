import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename } from 'node:path';

const execute = promisify(execFile);
/** Install full skill directories (including references) using the canonical package. */
export async function installBrokerSkills(skills: string[], cli: string, cwd: string, signal: AbortSignal): Promise<void> {
  if (!skills.length) return;
  const identity = basename(cli).replace(/\.exe$/i, '');
  const harness = ({ claude: 'claude-code', codex: 'codex', gemini: 'gemini-cli',
    'cursor-agent': 'cursor', opencode: 'opencode' } as Record<string, string>)[identity];
  if (!harness) throw new Error(`Skill installation is unsupported for broker CLI ${identity}`);
  await execute('npx', ['--yes', 'skills', 'add', 'https://github.com/AgentWorkforce/skills',
    '--skill', ...skills, '--agent', harness, '--yes', '--copy'],
  { cwd, signal, timeout: 120_000, maxBuffer: 1024 * 1024 });
}
