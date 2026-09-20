#!/usr/bin/env python3
"""Verify the Claude/Codex/Cursor example against its read-only kernel journal."""
import json
import sqlite3
import sys
from pathlib import Path

path = Path(sys.argv[1]).resolve()
with sqlite3.connect(path.as_uri() + '?mode=ro', uri=True) as db:
    entries = [dict(seq=seq, type=kind, step=step, payload=json.loads(payload))
               for seq, kind, step, payload in db.execute(
                   'select seq,entry_type,step_id,payload from entries order by seq')]

def rows(kind):
    return [entry for entry in entries if entry['type'] == kind]

steps = rows('run.spawned')[0]['payload']['spec']['steps']
clis = {step['id']: Path(step['cli']).name for step in steps}
assert clis == {'claude': 'claude', 'codex': 'codex', 'cursor': 'cursor-agent'}, clis
appends = rows('channel.appended')
deliveries = rows('channel.delivered')
acks = rows('channel.acknowledged')
assert len(appends) == len(deliveries) == len(acks) == 3
receivers = {'claude': 'codex', 'codex': 'cursor', 'cursor': 'claude'}
for appended in appends:
    body = appended['payload']
    assert body['message'] == 'HELLO-' + body['producer']
    assert body['message_id'] == 'hello-v1'
    delivered = [entry for entry in deliveries if
                 (entry['payload']['channel'], entry['payload']['offset']) == (body['channel'], body['offset'])]
    assert len(delivered) == 1
    delivery = delivered[0]
    assert delivery['payload']['consumer'] == receivers[body['producer']]
    acknowledged = [entry for entry in acks if entry['payload']['delivery_seq'] == delivery['seq']]
    assert len(acknowledged) == 1
    assert acknowledged[0]['payload']['consumer'] == delivery['payload']['consumer']
    assert appended['seq'] < delivery['seq'] < acknowledged[0]['seq']
completed = rows('step.completed')
assert len(completed) == 3 and all(entry['payload']['completionReason'] == 'success' for entry in completed)
assert rows('run.completed')[-1]['payload']['completionReason'] == 'success'
print(json.dumps(dict(run_id=path.stem, clis=clis, appends=3, deliveries=3,
                     processing_acks=3, successful_agents=3, completionReason='success'), indent=2))
