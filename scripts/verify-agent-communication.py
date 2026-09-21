#!/usr/bin/env python3
"""Verify the four-message example from its authoritative, read-only journal."""
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

appends = rows('channel.appended')
deliveries = rows('channel.delivered')
acks = rows('channel.acknowledged')
assert len(appends) == len(deliveries) == len(acks) == 4
assert {entry['payload']['message_id'] for entry in appends} == {
    'proposal-v1', 'critique-v1', 'proposal-v2', 'verdict-v1'}
for delivery in deliveries:
    body = delivery['payload']
    appended = [entry for entry in appends if
                (entry['payload']['channel'], entry['payload']['offset']) == (body['channel'], body['offset'])]
    acknowledged = [entry for entry in acks if entry['payload']['delivery_seq'] == delivery['seq']]
    assert len(appended) == len(acknowledged) == 1
    assert appended[0]['seq'] < delivery['seq'] < acknowledged[0]['seq']
    assert body['message'] == appended[0]['payload']['message']
    assert body['consumer'] == acknowledged[0]['payload']['consumer']
starts = rows('step.attempt.started')
assert len(starts) == 2 and max(entry['seq'] for entry in starts) < appends[0]['seq']
completed = rows('step.completed')
assert len(completed) == 2
assert all(entry['payload']['completionReason'] == 'success' for entry in completed)
assert rows('run.completed')[-1]['payload']['completionReason'] == 'success'
receipts = [entry['payload']['message'] for entry in rows('stream.appended')]
injections = [entry for entry in receipts if entry.get('kind') == 'delivery_injected']
assert len(injections) >= 4 and all(entry['processing_ack'] is False for entry in receipts)
print(json.dumps(dict(run_id=path.stem, appends=4, deliveries=4, processing_acks=4,
                     successful_agents=2, injection_receipts=len(injections), completionReason='success'), indent=2))
