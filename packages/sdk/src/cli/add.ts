import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CliIo } from '../cli.js';
import { findPluginProject, probePlugin, readPlugin } from '../plugin-loader.js';
import { PluginError, pluginPackageName } from '../plugin-manifest.js';

export async function addPlugin(name: string, io: CliIo, options: {
  cwd?: string;
  install?: (packageName: string, root: string) => void;
} = {}): Promise<0 | 2> {
  try {
    const packageName = pluginPackageName(name);
    const root = findPluginProject(options.cwd ?? process.cwd());
    if (!root) throw new PluginError('plugin_manifest_invalid', 'flows add requires a project with flows.json.');
    const configPath = join(root, 'flows.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    if (!config || Array.isArray(config) || typeof config !== 'object' || (config.plugins !== undefined && (!Array.isArray(config.plugins) || !config.plugins.every((p: unknown) => typeof p === 'string')))) throw new PluginError('plugin_manifest_invalid', 'Invalid flows.json plugins list.');
    const tsPath = join(root, 'tsconfig.json');
    const tsconfig = existsSync(tsPath) ? { config: JSON.parse(readFileSync(tsPath, 'utf8')) } : { config: {} };
    if (!tsconfig.config || typeof tsconfig.config !== 'object' || Array.isArray(tsconfig.config) || (tsconfig.config.include !== undefined && (!Array.isArray(tsconfig.config.include) || !tsconfig.config.include.every((p: unknown) => typeof p === 'string')))) throw new PluginError('plugin_manifest_invalid', 'Invalid tsconfig.json include list.');
    try {
      (options.install ?? ((pkg, cwd) => { execFileSync('npm', ['install', '--save', pkg], { cwd, encoding: 'utf8', stdio: 'pipe' }); }))(packageName, root);
    } catch (error) {
      const message = String((error as { stderr?: unknown }).stderr ?? error);
      throw new PluginError(/E404|404 Not Found/.test(message) ? 'plugin_unknown' : 'plugin_install_failed', `Could not install ${packageName}.`);
    }
    const plugin = readPlugin(join(root, 'node_modules', packageName), packageName);
    await probePlugin(plugin);
    if (!existsSync(join(plugin.directory, 'src/index.js'))) throw new PluginError('plugin_manifest_invalid', 'Plugin requires src/index.js.');
    const declaration = `node_modules/${packageName}/flows-plugin.d.ts`;
    if (existsSync(join(root, declaration))) {
      tsconfig.config.include = [...new Set([...(tsconfig.config.include ?? ['**/*']), declaration])];
      writeFileSync(tsPath, `${JSON.stringify(tsconfig.config, null, 2)}\n`);
    }
    config.plugins = [...new Set([...(config.plugins ?? []), packageName])];
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    io.stdout(`Added ${packageName}`);
    return 0;
  } catch (error) {
    const refusal = error instanceof PluginError ? error : new PluginError('plugin_manifest_invalid', (error as Error).message);
    io.stderr(`REFUSED [${refusal.code}] ${refusal.message}`);
    return 2;
  }
}
