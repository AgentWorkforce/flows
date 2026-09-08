"""Verify every installed candidate file and SDK resolution from the launcher."""
from pathlib import Path
import hashlib
import subprocess
import tarfile

root = Path('/tmp/ws13-gallery-review')
for package, archive in [
    ('@relayflows/sdk', '/tmp/ws13-review-artifacts/relayflows-sdk-2.0.8.tgz'),
    ('relayflows', '/tmp/ws13-review-artifacts/relayflows-2.0.8.tgz'),
    ('@relayflows/runtime-darwin-arm64', '/tmp/ws13-artifacts/relayflows-runtime-darwin-arm64-2.0.8.tgz'),
]:
    with tarfile.open(archive) as tar:
        members = [member for member in tar if member.isfile()]
        for member in members:
            installed = root / 'node_modules' / package / member.name.removeprefix('package/')
            assert installed.read_bytes() == tar.extractfile(member).read(), str(installed)
    print(f'PASS: {package}: all {len(members)} installed files match {archive}')
    print(f'SHA256={hashlib.sha256(Path(archive).read_bytes()).hexdigest()}')
resolved = subprocess.check_output(['node', '--experimental-import-meta-resolve', '--input-type=module', '-e',
    "import {pathToFileURL,fileURLToPath} from 'node:url'; console.log(fileURLToPath(import.meta.resolve('@relayflows/sdk/cli', pathToFileURL(process.cwd()+'/node_modules/relayflows/bin/flows.js'))));"], cwd=root, text=True).strip()
assert Path(resolved).resolve() == (root / 'node_modules/@relayflows/sdk/dist/cli.js').resolve(), resolved
print('PASS: launcher resolves the verified candidate SDK: ' + resolved)
