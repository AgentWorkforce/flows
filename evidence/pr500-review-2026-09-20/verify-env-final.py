import json,sqlite3
from pathlib import Path
root=Path('/tmp/flows-pr500-review-live')
with sqlite3.connect('file:'+str(root/'data-final/runs/01M2Z04VN15G7ATCGZBH2CM785.sqlite3')+'?mode=ro',uri=True) as db:
    start=db.execute('select min(at_ms) from entries').fetchone()[0]
for cli in ['claude','codex','cursor']:
    path=root/('env-'+cli+'.json')
    assert path.stat().st_mtime*1000 >= start, 'stale marker: '+cli
    data=json.loads(path.read_text())
    assert data == {'cli':cli,'unrelatedCredentialsAbsent':True,'sessionAuthenticationPresent':True}
    print(json.dumps(data))
