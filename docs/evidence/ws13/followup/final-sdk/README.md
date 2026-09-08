# Superseded: stale launcher captures

Both gallery captures here returned `invalid_invocation`, not `unsupported_header`.
The original report misclassified them. Installing only the SDK tarball allowed
npm to re-resolve the launcher from public npm; the direct packed-SDK test did
not exercise that launcher. `artifact.json` identifies the installed SDK, but
it does not establish which SDK the stale launcher executed.

Use the [corrected gallery](../../review/README.md), where the launcher and SDK
are pinned together and every installed candidate file is verified. These
original failures are preserved, not rewritten into passing evidence.
