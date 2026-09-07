Spec review at 1a43d2ff5865f5094983175d139247718bcae28c: BLOCKED / leave open.

This serves RFC-0001 covenant 2 (check authentication before starting) and §2 rule 7 (a real review swarm, not a green vendor check). The fingerprint helps diagnose credential mismatch without printing the credential.

Blocking content finding: `.github/workflows/review-swarm.yml:75-81` invokes curl without connect/total timeouts, hides curl failures behind `|| echo 000`, and recommends credential rotation for every non-200 response, including transport failures and server errors. Bound the probe and distinguish transport/HTTP failures from 401. The existing unresolved thread discussion_r3952636976 remains valid.

The current `review` failure is credential infrastructure, not a content verdict. Literal command: `gh run view 34163837060 --log-failed`. Captured relevant output:
```
review	Validate cloud authentication	2026-09-07T21:38:11.3476428Z ##[error]CLOUD_API_KEY is set but not accepted by https://agentrelay.com/cloud (HTTP 401). Re***mint the credential; do not re***run this job.
review	Validate cloud authentication	2026-09-07T21:38:11.3487776Z ##[error]Process completed with exit code 1.
```

No gate edit performed: this workflow judges my assigned work, so settled decision #6 prohibits me from changing it. An independent gate owner must repair the probe on this PR branch; the cloud credential owner must restore accepted CI credentials and rerun at the final head. Leave open until those changes, real independent review, green CI at that head, and resolution of the outstanding thread. No merge attempted.
