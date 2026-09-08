"""Capture a real terminal session as asciicast v2 plus a text transcript.
Usage: python3 record.py OUTPUT_PREFIX CWD COMMAND [ARG ...]
"""
import codecs
import json
import os
import pty
import select
import shlex
import signal
import sys
import time
from pathlib import Path

prefix, cwd, *argv = sys.argv[1:]
started = time.monotonic()
header = {'version': 2, 'width': 120, 'height': 30, 'timestamp': int(time.time()),
          'title': 'Relayflows local development', 'command': shlex.join(argv),
          'env': {'TERM': 'xterm-256color'}}
with open(prefix + '.cast', 'w') as cast, open(prefix + '.txt', 'w') as transcript:
    cast.write(json.dumps(header) + '\n')
    transcript.write(f'$ cd {shlex.quote(cwd)}\n$ {shlex.join(argv)}\n')
    transcript.flush()
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(cwd)
        os.execvpe(argv[0], argv, os.environ)
    decoder = codecs.getincrementaldecoder('utf-8')('replace')
    timed_out = False
    while True:
        if time.monotonic() - started > 180:
            timed_out = True
            os.killpg(pid, signal.SIGTERM)
        ready, _, _ = select.select([fd], [], [], 1)
        if ready:
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            text = decoder.decode(data)
            cast.write(json.dumps([round(time.monotonic() - started, 6), 'o', text]) + '\n')
            cast.flush()
            transcript.write(text.replace('\r\n', '\n'))
            transcript.flush()
        if timed_out:
            time.sleep(0.2)
            try:
                os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            break
    tail = decoder.decode(b'', final=True)
    if tail:
        cast.write(json.dumps([round(time.monotonic() - started, 6), 'o', tail]) + '\n')
        transcript.write(tail.replace('\r\n', '\n'))
    os.close(fd)
    _, status = os.waitpid(pid, 0)
    code = os.waitstatus_to_exitcode(status)
    elapsed = time.monotonic() - started
    ending = f'\nEXIT_CODE={code}\nELAPSED_SECONDS={elapsed:.3f}\nTIMED_OUT={timed_out}\n'
    transcript.write(ending)
    cast.write(json.dumps([round(elapsed, 6), 'o', ending.replace('\n', '\r\n')]) + '\n')
    print(ending)
# Normalize only the readable transcript; the cast retains terminal bytes.
path = Path(prefix + '.txt')
path.write_text('\n'.join(line.rstrip() for line in path.read_text().splitlines()) + '\n')
sys.exit(code if code >= 0 else 128 - code)
