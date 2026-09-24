import glob
import json
import sqlite3

for directory in ['/tmp/flows-561-live-default', '/tmp/flows-561-live-one']:
    journals = sorted(glob.glob(directory + '/runs/*.sqlite3'))
    assert journals
    llms = 0
    for path in journals:
        with sqlite3.connect('file:' + path + '?mode=ro', uri=True) as db:
            rows = db.execute('select entry_type, step_id, payload from entries').fetchall()
        assert all('lease_expired' not in payload for _, _, payload in rows), path
        starts = [step for kind, step, _ in rows if kind == 'step.attempt.started' and step.startswith('llm-')]
        if starts:
            assert len(starts) == 1, (path, starts)
            llms += 1
        for kind, step, payload in rows:
            if kind == 'step.completed' and step and step.startswith('llm-'):
                value = json.loads(payload)
                assert value['completionReason'] == 'success', value
                print(step, value['output'])
    assert llms == 9, llms
    print(directory, f'{len(journals)} journals, {llms} LLM children, one attempt each, no lease_expired')
