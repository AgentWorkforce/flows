import glob
import json
import sqlite3
import sys

for directory in sys.argv[1:]:
    paths = glob.glob(directory + '/runs/*.sqlite3')
    expired = []
    for path in paths:
        with sqlite3.connect(path) as db:
            for step, payload in db.execute("select step_id, payload from entries where entry_type='step.completed'"):
                if json.loads(payload).get('completionReason') == 'lease_expired':
                    expired.append({'journal': path, 'step': step})
    print(json.dumps({'directory': directory, 'journals': len(paths), 'lease_expired': expired}))
    assert paths and not expired
