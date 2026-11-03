from pathlib import Path
import subprocess, tempfile, json, os, sys
SP = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="land-push-fence-")
env = os.environ.copy()
env.update({'GIT_AUTHOR_NAME':'F','GIT_AUTHOR_EMAIL':'f@example.test','GIT_COMMITTER_NAME':'F','GIT_COMMITTER_EMAIL':'f@example.test','GIT_CONFIG_GLOBAL':'/dev/null'})
def trial(variant, race=True):
    root = Path(tempfile.mkdtemp(prefix=f'fence-{variant}-', dir=SP))
    remote = root/'remote.git'; local = root/'local'; local.mkdir()
    def run(*a, cwd=local, input=None):
        return subprocess.check_output(['git', *a], cwd=cwd, env=env, input=input, text=True, stderr=subprocess.STDOUT).strip()
    run('init', '--bare', '-q', str(remote)); run('init', '-q', '-b', 'main')
    (local/'f').write_text('base\n'); run('add', '.'); run('commit', '-qm', 'base'); base = run('rev-parse', 'HEAD')
    (local/'f').write_text('pinned\n'); run('commit', '-qam', 'pinned'); pinned = run('rev-parse', 'HEAD'); tree = run('rev-parse', 'HEAD^{tree}')
    squash = run('commit-tree', tree, '-p', base, input='squash\n')
    (local/'f').write_text('newer\n'); run('commit', '-qam', 'newer'); newer = run('rev-parse', 'HEAD')
    run('remote', 'add', 'origin', str(remote))
    run('push', '-q', 'origin', f'{base}:refs/heads/main', f'{pinned}:refs/heads/land/run', f'{newer}:refs/heads/successor-source')
    if race:
        hook = remote/'hooks/pre-receive'
        # A newer submission moves the land ref after the advertisement, before the update.
        hook.write_text('#!/bin/sh\ncat > "'+str(root/'cmds.txt')+'"\nenv -u GIT_QUARANTINE_PATH -u GIT_OBJECT_DIRECTORY -u GIT_ALTERNATE_OBJECT_DIRECTORIES git --git-dir="'+str(remote)+'" update-ref refs/heads/land/run '+newer+'\n')
        hook.chmod(0o755)
    lease = f'--force-with-lease=refs/heads/land/run:{pinned}'
    if variant == 'noop':
        cmd = ['git', 'push', '--atomic', lease, 'origin', f'{squash}:refs/heads/main', f'{pinned}:refs/heads/land/run']
    else:
        cmd = ['git', 'push', '--atomic', lease, 'origin', f'{squash}:refs/heads/main', ':refs/heads/land/run']
    r = subprocess.run(cmd, cwd=local, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    main = run('--git-dir='+str(remote), 'rev-parse', 'refs/heads/main')
    land = subprocess.run(['git', '--git-dir='+str(remote), 'rev-parse', '-q', '--verify', 'refs/heads/land/run'], env=env, text=True, stdout=subprocess.PIPE).stdout.strip()
    sent = (root/'cmds.txt').read_text() if (root/'cmds.txt').exists() else ''
    return {'variant': variant, 'race': race, 'exit': r.returncode, 'mainGotSquash': main == squash,
            'landRefNow': 'newer' if land == newer else ('deleted' if not land else 'pinned'),
            'landRefInTransaction': 'refs/heads/land/run' in sent, 'out': r.stdout.strip().splitlines()[-1:] }
print(subprocess.check_output(['git', '--version'], text=True).strip())
for v in ('noop', 'delete'):
    print(json.dumps(trial(v, race=True)))
print(json.dumps(trial('delete', race=False)))
