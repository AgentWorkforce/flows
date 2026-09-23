These are unmodified historical implementation snapshots (apart from location),
retained so the existing pure-state and fake-GitHub regression suites continue
to test their original contracts. They are not supported deployment entries.
The 989-line historical example is intentionally not refactored: it is a
baseline fixture, not the modular Babysitter implementation. The recommended
entry points both delegate to ../babysitter.flow.ts. No existing behavioral
assertion was weakened; only regression imports moved with their baselines.
