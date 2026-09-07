import os, subprocess
source = subprocess.check_output(['git','show','a7b23cff7f394e16a77d02bc727be958365b8ae9:ops/preswarm-check/lens-runner.sh'], text=True)
classifier = source[source.index("LAST_VERDICT=$(printf"):]
cases = {
 'blocker_plus_pass': '### Blockers\n- P1: unauthorized writes\nREVIEW_PASSED',
 'first_none_last_blocker': '### Blockers\nNone\n### Blockers\n- P1: unauthorized writes\nREVIEW_FAILED',
 'none_plus_fail': '### Blockers\nNone\nREVIEW_FAILED',
}
for name, output in cases.items():
 r = subprocess.run(['sh','-c',classifier],env={**os.environ,'OUTPUT':output,'CLI_RC':'0','LENS':'structure'},text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
 print(f'{name}: exit={r.returncode}\n{r.stdout}',end='')
