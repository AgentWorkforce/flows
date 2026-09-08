"""Exercise recorder EOF/normalization and harness refusal paths without agents."""
from pathlib import Path
import json
import os
import subprocess
import sys
import tempfile

base = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='ws13-helper-check-') as directory:
    root = Path(directory)
    prefix = root / 'terminal'
    argv = [sys.executable, str(base / 'record.py'), str(prefix), directory,
            sys.executable, '-c', "import os; os.write(1, b'trailing   \\n\\xe2\\x82')"]
    result = subprocess.run(argv, text=True, capture_output=True)
    assert result.returncode == 0, result.stderr
    transcript = prefix.with_suffix('.txt').read_text()
    frames = [json.loads(line) for line in prefix.with_suffix('.cast').read_text().splitlines()]
    terminal = ''.join(frame[2] for frame in frames[1:])
    assert '\ufffd' in terminal and '\ufffd' in transcript
    assert 'trailing   \r\n' in terminal
    assert '\ntrailing\n' in transcript
    assert all(line == line.rstrip() for line in transcript.splitlines())
    print('PASS: EOF UTF-8 replacement is captured in cast and text; text trims trailing spaces; cast preserves them.')
    for name in ['cold-clone.sh', 'cold-start.sh']:
        result = subprocess.run(['bash', str(base / name)], text=True, capture_output=True)
        assert result.returncode != 0 and 'Usage:' in result.stderr, result
        print(f'PASS: {name} without registry refuses with usage: {result.stderr.strip()}')
    older = root / 'node'
    older.write_text('#!/bin/sh\nprintf "20.19.0\\n"\n')
    older.chmod(0o755)
    result = subprocess.run([sys.executable, str(base / 'followup/run-gallery.py'), directory,
                             str(root / 'older-evidence'), 'sdk-only'],
                            env={**os.environ, 'PATH': directory}, text=True, capture_output=True)
    assert result.returncode != 0 and 'found 20.19.0' in result.stderr, result
    print('PASS: older Node refuses before any gallery command: ' + result.stderr.strip())
    occupied = root / 'occupied'
    occupied.mkdir()
    capture = occupied / 'gallery-existing.txt'
    capture.write_text('original evidence')
    result = subprocess.run([sys.executable, str(base / 'followup/run-gallery.py'), directory,
                             str(occupied), 'sdk-only'], text=True, capture_output=True)
    assert result.returncode != 0 and 'will not be overwritten' in result.stderr
    assert capture.read_text() == 'original evidence'
    print('PASS: existing gallery capture preserved; overwrite refused.')
