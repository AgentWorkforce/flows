import os, subprocess, tempfile
from pathlib import Path
with tempfile.TemporaryDirectory() as directory:
    marker=Path(directory)/'marker'; newer=Path(directory)/'newer'
    marker.touch(); newer.touch()
    os.utime(marker,ns=(1700000000100000000,1700000000100000000))
    os.utime(newer,ns=(1700000000900000000,1700000000900000000))
    script='''trace=$4
stat() { printf "stat\\n" >> "$trace"; command stat "$@"; }
source "$1"
if [ "$3" -nt "$2" ]; then plain=NEWER; else plain=NOT_NEWER; fi
if [ ! "$3" -nt "$2" ]; then negated=STALE; else negated=FRESH; fi
calls=$(wc -l < "$trace")
printf 'PLAIN=%s NEGATED=%s STAT_CALLS=%d\\n' "$plain" "$negated" "$calls"
builtin [ "$plain" = NOT_NEWER ] && builtin [ "$negated" = STALE ] && builtin [ "$calls" -eq 4 ]
'''
    result=subprocess.run(['bash','-c',script,'probe',str(Path('ops/runtime-evidence/swarm-threads-0909-coarse.bash').resolve()),str(marker),str(newer),str(Path(directory)/'calls')],text=True,capture_output=True)
    print(result.stdout+result.stderr,end='')
    print('EXIT_CODE='+str(result.returncode))
    raise SystemExit(result.returncode)
