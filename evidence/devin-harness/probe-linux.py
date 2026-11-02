"""Reproduce the pinned binary checks on a Linux x64 host (Python 3.14+)."""
import hashlib
import os
from pathlib import Path
import platform
import subprocess
import sys
import tarfile
import urllib.request

if platform.system() != "Linux" or platform.machine() != "x86_64":
    raise SystemExit("This probe requires Linux x64")
root = Path.home() / ".cache/devin-harness-20261102"
root.mkdir(parents=True, exist_ok=True)
bundle = root / "devin-linux-x64.tar.gz"
url = "https://static.devin.ai/cli/3000.11.234/devin-3000.11.234-x86_64-unknown-linux.tar.gz"
with urllib.request.urlopen(url, timeout=30) as response:
    bundle.write_bytes(response.read())
expected = "201370cddd2924294e3ca6b46fd8ece49b5763953b644a1dd823fce5490cb41a"
if hashlib.sha256(bundle.read_bytes()).hexdigest() != expected:
    raise SystemExit("Linux x64 bundle checksum mismatch")
print("Linux x64 bundle SHA-256 verified", flush=True)
with tarfile.open(bundle) as archive:
    archive.extractall(root / "cli", filter="data")
subprocess.run([sys.executable, str(Path(__file__).with_name("probe-cli.py")),
                "--cli", str(root / "cli/bin/devin")], check=True,
               env=dict(os.environ, TMPDIR=str(root)), timeout=120)
