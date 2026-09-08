"""Black-box checks over temporary repositories; no cloud checkout required."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parent
ZERO = '00000000-0000-0000-0000-000000000000'


class RestackChecks(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def write(self, path, content):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)

    def git(self, *args):
        subprocess.run(['git', *args], cwd=self.root, check=True,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def check(self, script, code, text):
        result = subprocess.run(['sh', str(SCRIPTS / (script + '.sh'))],
                                cwd=self.root, text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        self.assertEqual(result.returncode, code, result.stdout)
        self.assertIn(text, result.stdout)

    def journal(self, whens=(1, 2)):
        entries = [dict(idx=i, tag=f'{i:04}_change', when=w)
                   for i, w in enumerate(whens)]
        self.write('packages/web/drizzle/meta/_journal.json',
                   json.dumps(dict(entries=entries)))
        for entry in entries:
            self.write(f'packages/web/drizzle/{entry["tag"]}.sql', '-- migration\n')
        return entries

    def snapshot(self, index, ident, previous, tables):
        self.write(f'packages/web/drizzle/meta/{index:04}_snapshot.json',
                   json.dumps(dict(id=ident, prevId=previous, tables=tables)))

    def test_git_error_fails(self):
        self.check('no-conflict-markers', 1, 'git grep exit 128')

    def test_clean_tracked_file_ignores_untracked_markers(self):
        self.git('init', '-q')
        self.write('source.txt', 'clean\n')
        self.git('add', 'source.txt')
        self.write('scratch.txt', '<<<<<<< scratch\n')
        self.check('no-conflict-markers', 0, 'PASSED')

    def test_lockfile_conflicts_fail(self):
        self.git('init', '-q')
        self.write('package-lock.json', '<<<<<<< HEAD\n')
        self.git('add', 'package-lock.json')
        self.check('no-conflict-markers', 1, 'package-lock.json:1:')

    def test_missing_entries_fails(self):
        self.write('packages/web/drizzle/meta/_journal.json', '{}')
        self.check('migration-journal', 1, 'entries must be a list')

    def test_empty_journal_passes(self):
        self.journal(())
        self.check('migration-journal', 0, 'PASSED (0 entries')

    def test_broken_snapshot_chain_fails(self):
        self.journal()
        self.snapshot(0, 'a', ZERO, {'users': {}})
        self.snapshot(1, 'b', 'wrong', {'users': {}})
        self.check('migration-journal', 1, 'prevId does not match predecessor a')

    def test_table_loss_requires_semantic_verification(self):
        self.journal()
        self.snapshot(0, 'a', ZERO, {'users': {}, 'old': {}})
        self.snapshot(1, 'b', 'a', {'users': {}})
        self.check('migration-journal', 1, 'intentional drop or stale snapshot')

    def test_valid_lineage_passes(self):
        self.journal()
        self.snapshot(0, 'a', ZERO, {'users': {}})
        self.snapshot(1, 'b', 'a', {'users': {}, 'new': {}})
        self.check('migration-journal', 0, 'PASSED')

    def test_equal_or_out_of_order_timestamps_fail(self):
        for whens in [(1, 1), (2, 1, 3)]:
            with self.subTest(whens=whens):
                self.journal(whens)
                self.check('migration-journal', 1, 'strictly increasing')

    def test_missing_sql_fails(self):
        self.journal()
        (self.root / 'packages/web/drizzle/0001_change.sql').unlink()
        self.check('migration-journal', 1, 'no .sql file')

    def test_orphan_sql_fails(self):
        self.journal()
        self.write('packages/web/drizzle/orphan.sql', '-- orphan\n')
        self.check('migration-journal', 1, 'no journal entry')

    def test_bindings_inapplicable_skips(self):
        self.check('worker-bindings', 0, 'SKIPPED')

    def test_bindings_missing_config_fails(self):
        self.write('scripts/verify-fast-path-bindings.mjs', 'process.exit(0)')
        self.check('worker-bindings', 1, 'missing packages/web/wrangler.production.toml')

    def test_bindings_missing_script_fails(self):
        self.write('packages/web/wrangler.production.toml', '')
        self.check('worker-bindings', 1, 'missing scripts/verify-fast-path-bindings.mjs')

    def test_bindings_propagates_checker_failure(self):
        self.write('packages/web/wrangler.production.toml', '')
        self.write('scripts/verify-fast-path-bindings.mjs', 'process.exit(1)')
        self.check('worker-bindings', 1, 'FAILED')

    def test_bindings_passes_config_argument(self):
        self.write('packages/web/wrangler.production.toml', '')
        self.write('scripts/verify-fast-path-bindings.mjs',
                   'process.exit(process.argv.slice(2).join(" ") === '
                   '"--wrangler-config packages/web/wrangler.production.toml" ? 0 : 1)')
        self.check('worker-bindings', 0, 'PASSED')


if __name__ == '__main__':
    unittest.main(verbosity=2)
