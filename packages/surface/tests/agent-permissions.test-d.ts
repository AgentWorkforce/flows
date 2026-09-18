import type { Ctx, PermissionsSpec } from '../src/index.js';

export async function agentPermissions(f: Ctx): Promise<void> {
  await f.agent('writer', {
    task: 'Write a draft.',
    permissions: { fileGlobs: ['drafts/**'], accessPreset: 'readwrite' },
  });
  await f.agent('reviewer', {
    task: 'Review drafts/post.md; do not edit it.',
    permissions: { fileGlobs: ['drafts/**'], accessPreset: 'readonly' },
  });
  const full: PermissionsSpec = {
    fileGlobs: ['src/**'], networkAllowlist: ['example.com'], accessPreset: 'readonly',
  };
  f.agent('full', { task: 'x', permissions: full });
  f.agent('partial', { task: 'x', permissions: { networkAllowlist: [] } });
  f.agent('empty', { task: 'x', permissions: {} });
  f.agent('omitted', { task: 'x' });
  // @ts-expect-error Only readonly and readwrite are supported.
  f.agent('bad', { task: 'x', permissions: { accessPreset: 'admin' } });
  // @ts-expect-error Authoring keys are camelCase.
  f.agent('bad', { task: 'x', permissions: { file_globs: [] } });
  // @ts-expect-error fileGlobs must be an array.
  f.agent('bad', { task: 'x', permissions: { fileGlobs: 'src/**' } });
  // @ts-expect-error networkAllowlist must be an array.
  f.agent('bad', { task: 'x', permissions: { networkAllowlist: 'example.com' } });
  // @ts-expect-error fileGlobs elements must be strings.
  f.agent('bad', { task: 'x', permissions: { fileGlobs: [1] } });
  // @ts-expect-error networkAllowlist elements must be strings.
  f.agent('bad', { task: 'x', permissions: { networkAllowlist: [1] } });
}
