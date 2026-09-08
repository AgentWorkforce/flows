import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

export interface CreateFlowOptions {
  name?: string;
  template?: 'agent' | 'deterministic';
  /** CLI used by future f.agent steps. It must already be authenticated. */
  cli?: string;
  /** Install project dependencies (default true). */
  install?: boolean;
}

export interface CreatedFlow {
  directory: string;
  flowPath: string;
  configPath: string;
  installed: boolean;
}

/** Scaffold a new project. Existing directories are never overwritten. */
export async function createFlow(target: string, opts: CreateFlowOptions = {}): Promise<CreatedFlow> {
  if (!target.trim()) throw new Error('Choose a new directory, for example: create-flow my-flow');
  const directory = resolve(target);
  const name = opts.name ?? basename(directory);
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
    throw new Error('Flow name must be 1–64 lowercase letters, numbers or hyphens, starting with a letter or number.');
  }
  const template = opts.template ?? 'agent';
  if (template !== 'agent' && template !== 'deterministic') throw new Error('Template must be agent or deterministic.');
  const cli = opts.cli ?? 'claude';
  if (!cli.trim() || /[\x00-\x1f\x7f]/.test(cli)) throw new Error('CLI must be a nonempty command or path.');
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  await mkdir(dirname(directory), { recursive: true });
  try {
    await mkdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Directory already exists: ${directory}. Choose a new directory; no files were changed.`);
    }
    throw error;
  }
  const flowFile = `${name}.flow.ts`;
  const agentStep = template === 'agent'
    ? `  const answer = await f.agent('greeter', { task: 'Reply with one short hello sentence. Do not use tools or modify files.' });\n  console.log(answer.summary);\n`
    : '';
  const runFlags = template === 'agent' ? ' --local-agent' : '';
  const files: Record<string, string> = {
    [flowFile]: `import { flow } from '@relayflows/surface';\n\nexport default flow(${JSON.stringify(name)}, async (f) => {\n  const greeting = await f.run('echo "Hello from Relayflows"');\n  console.log(greeting.trim());\n${agentStep}  f.done('success');\n});\n`,
    'flows.json': JSON.stringify({ cli }, null, 2) + '\n',
    'package.json': JSON.stringify({
      name, private: true, type: 'module',
      scripts: { start: `flows run ${flowFile}${runFlags} --input '{}'` },
      engines: { node: '>=22.18.0' },
      dependencies: { relayflows: version, '@relayflows/surface': version },
    }, null, 2) + '\n',
    '.gitignore': 'node_modules/\n.relayflowd/\n',
    'README.md': `# ${name}\n\nRun \`npm start\` (or \`npx flows run ${flowFile}${runFlags} --input '{}'\`).\n\n${template === 'agent' ? `Requires ${JSON.stringify(cli)} installed and authenticated. The local agent worker runs\non this machine with the CLI's existing access; it provides no workspace isolation.\n` : 'This starter needs no model credentials.\n'}\n\`flows.json\` selects the CLI for agent steps. Steps execute through the local\njournal; authored TypeScript bodies are not yet durably resumable as a whole.\n`,
  };
  for (const [file, contents] of Object.entries(files)) {
    await writeFile(join(directory, file), contents, { flag: 'wx' });
  }
  if (opts.install !== false) {
    try {
      await installDependencies(directory);
    } catch (error) {
      throw new Error(`Created ${directory}, but dependency installation failed. Run npm install there to retry.`, { cause: error });
    }
  }
  return { directory, flowPath: join(directory, flowFile), configPath: join(directory, 'flows.json'), installed: opts.install !== false };
}

function installDependencies(cwd: string): Promise<void> {
  return new Promise((resolveInstall, reject) => {
    const child = spawn('npm', ['install', '--no-audit', '--no-fund'], { cwd, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolveInstall();
      else reject(new Error(`npm install exited ${signal ?? code}`));
    });
  });
}
