Expired agent-relay access tokens now refresh through `/api/v1/auth/token/refresh` before Cloud requests, hosted submissions, and mirror resume lookup. The rotated access and refresh tokens are persisted atomically at mode `0600`, under the relay-compatible directory lock. Explicit `token` and `FLOWS_CLOUD_TOKEN` precedence is preserved, including empty explicit credentials.

The store is re-read under the lock; concurrent callers reuse a completed rotation or post the latest refresh token. Unknown top-level fields survive writes, and all filesystem paths honour `AGENT_RELAY_HOME`. Refresh requests enforce the existing HTTPS/base-path policy, stay on the issuing deployment, refuse redirects, and produce no stdout. A server-selected base URL must also identify the same deployment.

Credential rejection (400/401/403), malformed responses, transport failures, other HTTP statuses, lock contention, and filesystem errors retain distinct classifications. Persistence failure refuses with `auth_store_unwritable`, naming the path and errno before any authenticated request uses the new token. Lock acquisition is bounded by five seconds and the request timeout; the shared stale-lock window remains 30 seconds.

This implements the file contract locally because flows has no runtime dependency on `@agent-relay/cloud`; invoking another CLI would require its binary and couple credential handling to its output. The existing mirror registration catch remains responsible for reporting projection errors without failing a local run. Normal store-backed requests read the small file twice; there is deliberately no cache hiding relay-side rotations.

There is no proactive renewal or renewal triggered by a non-refresh request's 401. Long polling can renew on the first request after the stored expiry. The standalone store reader in `workflows/stuck-run-triage.flow.ts` is outside this change. No workflow or gate files were edited.

Validation: 280 targeted tests passed, including 44 new store/refresh cases, CLI JSON logs, and hosted submission. Both TypeScript checks passed. The original expired-login refusal cases in `cloud-read.test.ts` and `cloud-deploy.test.ts` are unchanged and included in that run. Mutation checks detected both discarded refresh-token rotation and a removed explicit-credential bypass; both source files were restored byte-for-byte and the selected tests passed again.

Full-suite verification remains blocked: `npm test` stopped in `test:prep` because rustup has no configured default toolchain. Its Vitest phase did not run. No live credentials or `agent-relay cloud whoami` were used.

Literal commands and captured output follow. Test commands ran from `packages/sdk`.

<details>
<summary>Targeted regression suite</summary>

```sh
npx vitest run tests/cloud-auth-refresh.test.ts tests/cloud-deploy.test.ts tests/cloud-read.test.ts tests/cloud-run.test.ts tests/cloud-mirror-session.test.ts
```

```text

 RUN  v2.1.9 /home/daytona/.relayflow-v2-supervisor/durable/repository/packages/sdk

 ✓ tests/cloud-read.test.ts (47 tests) 59ms
 ✓ tests/cloud-auth-refresh.test.ts (44 tests) 149ms
 ✓ tests/cloud-mirror-session.test.ts (12 tests) 14ms
 ✓ tests/cloud-run.test.ts (60 tests) 664ms
 ✓ tests/cloud-deploy.test.ts (117 tests) 2078ms

 Test Files  5 passed (5)
      Tests  280 passed (280)
   Start at  10:22:31
   Duration  3.93s (transform 1.26s, setup 50ms, collect 5.01s, tests 2.96s, environment 1ms, prepare 219ms)
```

</details>

<details>
<summary>TypeScript source and type tests</summary>

```sh
npm run typecheck
```

```text

> @relayflows/sdk@2.0.42 typecheck
> tsc --noEmit && tsc -p tsconfig.type-tests.json
```

</details>

<details>
<summary>TypeScript regression-test compilation</summary>

```sh
npm run typecheck:tests
```

```text

> @relayflows/sdk@2.0.42 typecheck:tests
> tsc -p tsconfig.tests.json
```

</details>

<details>
<summary>Full gate — blocked during setup</summary>

```sh
npm test
```

```text

> @relayflows/sdk@2.0.42 test
> sh scripts/test.sh


> @relayflows/sdk@2.0.42 test:prep
> ( cd ../../kernel && sh ../ops/cargo.sh build ) && ( [ ! -d ../../testdata/preflight ] || find ../../testdata/preflight -name '*-cli' -type f -exec chmod +x {} + )

error: rustup could not choose a version of cargo to run, because one wasn't specified explicitly, and no default is configured.
help: run 'rustup default stable' to download the latest stable release of Rust and set it as your default toolchain.
```

</details>

The mutation procedure temporarily replaced `refreshToken: payload.refreshToken` with `refreshToken: login.refreshToken`, ran the rotation test, restored the original bytes, and re-ran. It then removed `if (explicitCloudToken(options) !== undefined) return;`, ran the precedence tests, restored the original bytes, and re-ran. Both mutations exited 1; both restored runs exited 0.

<details>
<summary>rotation — mutated failure</summary>

```sh
npx vitest run tests/cloud-auth-refresh.test.ts -t 'persists rotation'
```

```text

 RUN  v2.1.9 /home/daytona/.relayflow-v2-supervisor/durable/repository/packages/sdk

 ❯ tests/cloud-auth-refresh.test.ts (44 tests | 1 failed | 43 skipped) 15ms
   × cloud login refresh > persists rotation atomically in relay format before proceeding, silently 15ms
     → expected { …(6) } to deeply equal { …(6) }

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/cloud-auth-refresh.test.ts > cloud login refresh > persists rotation atomically in relay format before proceeding, silently
AssertionError: expected { …(6) } to deeply equal { …(6) }

- Expected
+ Received

  Object {
    "accessToken": "new-access",
    "accessTokenExpiresAt": "2098-01-01T00:00:00Z",
    "apiUrl": "https://login.example/cloud",
    "futureKey": Object {
      "keep": true,
    },
-   "refreshToken": "new-refresh",
+   "refreshToken": "old-refresh",
    "refreshTokenExpiresAt": "2099-01-01T00:00:00Z",
  }

 ❯ tests/cloud-auth-refresh.test.ts:62:19
     60|     expect(stdout).not.toHaveBeenCalled();
     61|     const saved = JSON.parse(await bytes());
     62|     expect(saved).toEqual({ ...old, ...rotated, futureKey: { keep: tru…
       |                   ^
     63|     expect(relayValid(saved)).toBe(true);
     64|     expect(await bytes()).toBe(`${JSON.stringify(saved, null, 2)}\n`);

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 43 skipped (44)
   Start at  10:22:05
   Duration  256ms (transform 71ms, setup 16ms, collect 69ms, tests 15ms, environment 0ms, prepare 45ms)
```

</details>

<details>
<summary>rotation — restored pass</summary>

```sh
npx vitest run tests/cloud-auth-refresh.test.ts -t 'persists rotation'
```

```text

 RUN  v2.1.9 /home/daytona/.relayflow-v2-supervisor/durable/repository/packages/sdk

 ✓ tests/cloud-auth-refresh.test.ts (44 tests | 43 skipped) 13ms

 Test Files  1 passed (1)
      Tests  1 passed | 43 skipped (44)
   Start at  10:22:06
   Duration  346ms (transform 138ms, setup 42ms, collect 113ms, tests 13ms, environment 0ms, prepare 44ms)
```

</details>

<details>
<summary>precedence — mutated failure</summary>

```sh
npx vitest run tests/cloud-auth-refresh.test.ts -t 'explicit precedence'
```

```text

 RUN  v2.1.9 /home/daytona/.relayflow-v2-supervisor/durable/repository/packages/sdk

 ❯ tests/cloud-auth-refresh.test.ts (44 tests | 4 failed | 40 skipped) 21ms
   × cloud login refresh > explicit precedence bypasses all store operations: token 11ms
     → expected "fetch" to be called 1 times, but got 2 times
   × cloud login refresh > explicit precedence bypasses all store operations: env 2ms
     → expected "fetch" to be called 1 times, but got 2 times
   × cloud login refresh > explicit precedence bypasses all store operations: empty-token 4ms
     → expected "mkdir" to not be called at all, but actually been called 3 times

Received: 

  1st mkdir call:

    Array [
      "/tmp/cloud-refresh-jz4EcY",
      Object {
        "mode": 448,
        "recursive": true,
      },
    ]

  2nd mkdir call:

    Array [
      "/tmp/cloud-refresh-jz4EcY/cloud-auth.json.lock",
      Object {
        "mode": 448,
      },
    ]

  3rd mkdir call:

    Array [
      "/tmp/cloud-refresh-jz4EcY",
      Object {
        "mode": 448,
        "recursive": true,
      },
    ]


Number of calls: 3

   × cloud login refresh > explicit precedence bypasses all store operations: empty-env 2ms
     → expected "mkdir" to not be called at all, but actually been called 3 times

Received: 

  1st mkdir call:

    Array [
      "/tmp/cloud-refresh-td2Oj6",
      Object {
        "mode": 448,
        "recursive": true,
      },
    ]

  2nd mkdir call:

    Array [
      "/tmp/cloud-refresh-td2Oj6/cloud-auth.json.lock",
      Object {
        "mode": 448,
      },
    ]

  3rd mkdir call:

    Array [
      "/tmp/cloud-refresh-td2Oj6",
      Object {
        "mode": 448,
        "recursive": true,
      },
    ]


Number of calls: 3


⎯⎯⎯⎯⎯⎯⎯ Failed Tests 4 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/cloud-auth-refresh.test.ts > cloud login refresh > explicit precedence bypasses all store operations: token
 FAIL  tests/cloud-auth-refresh.test.ts > cloud login refresh > explicit precedence bypasses all store operations: env
AssertionError: expected "fetch" to be called 1 times, but got 2 times
 ❯ tests/cloud-auth-refresh.test.ts:128:21
    126|     else {
    127|       await request(options);
    128|       expect(fetch).toHaveBeenCalledTimes(1);
       |                     ^
    129|       expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ author…
    130|     }

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/4]⎯

 FAIL  tests/cloud-auth-refresh.test.ts > cloud login refresh > explicit precedence bypasses all store operations: empty-token
AssertionError: expected "mkdir" to not be called at all, but actually been called 3 times

Received: 

  1st mkdir call:

    Array [
      "/tmp/cloud-refresh-jz4EcY",
      Object {
        "mode": 448,
        "recursive": true,
      },
    ]

  2nd mkdir call:

    Array [
      "/tmp/cloud-refresh-jz4EcY/cloud-auth.json.lock",
      Object {
        "mode": 448,
      },
    ]

  3rd mkdir call:

    Array [
      "/tmp/cloud-refresh-jz4EcY",
      Object {
        "mode": 448,
        "recursive": true,
      },
    ]


Number of calls: 3

 ❯ tests/cloud-auth-refresh.test.ts:131:23
    129|       expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ author…
    130|     }
    131|     expect(mkdir).not.toHaveBeenCalled();
       |                       ^
    132|     expect(await bytes()).toBe(before);
    133|   });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/4]⎯

 FAIL  tests/cloud-auth-refresh.test.ts > cloud login refresh > explicit precedence bypasses all store operations: empty-env
AssertionError: expected "mkdir" to not be called at all, but actually been called 3 times

Received: 

  1st mkdir call:

    Array [
      "/tmp/cloud-refresh-td2Oj6",
      Object {
        "mode": 448,
        "recursive": true,
      },
    ]

  2nd mkdir call:

    Array [
      "/tmp/cloud-refresh-td2Oj6/cloud-auth.json.lock",
      Object {
        "mode": 448,
      },
    ]

  3rd mkdir call:

    Array [
      "/tmp/cloud-refresh-td2Oj6",
      Object {
        "mode": 448,
        "recursive": true,
      },
    ]


Number of calls: 3

 ❯ tests/cloud-auth-refresh.test.ts:131:23
    129|       expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ author…
    130|     }
    131|     expect(mkdir).not.toHaveBeenCalled();
       |                       ^
    132|     expect(await bytes()).toBe(before);
    133|   });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[3/4]⎯

 Test Files  1 failed (1)
      Tests  4 failed | 40 skipped (44)
   Start at  10:22:06
   Duration  323ms (transform 76ms, setup 14ms, collect 77ms, tests 21ms, environment 0ms, prepare 83ms)
```

</details>

<details>
<summary>precedence — restored pass</summary>

```sh
npx vitest run tests/cloud-auth-refresh.test.ts -t 'explicit precedence'
```

```text

 RUN  v2.1.9 /home/daytona/.relayflow-v2-supervisor/durable/repository/packages/sdk

 ✓ tests/cloud-auth-refresh.test.ts (44 tests | 40 skipped) 13ms

 Test Files  1 passed (1)
      Tests  4 passed | 40 skipped (44)
   Start at  10:22:07
   Duration  383ms (transform 153ms, setup 17ms, collect 98ms, tests 13ms, environment 0ms, prepare 98ms)
```

</details>

Unchanged-test comparison, run from the repository root:

```sh
python3 - <<'PY'
import subprocess
from pathlib import Path
cases = [
    ('cloud-read.test.ts', 'names the re-login remedy when the stored login has expired, before any request'),
    ('cloud-deploy.test.ts', 'refuses an expired login with the re-login remedy, and a missing store with the configuration message'),
]
for name, title in cases:
    path = 'packages/sdk/tests/' + name
    original = subprocess.check_output(['git', 'show', 'HEAD:' + path], text=True)
    start = original.index("  it('" + title)
    end = original.index('\n  });', start) + len('\n  });')
    assert original[start:end] in Path(path).read_text()
    print(name + ': original expired-login test unchanged')
PY
```

```text
cloud-read.test.ts: original expired-login test unchanged
cloud-deploy.test.ts: original expired-login test unchanged
```

Relay contract evidence is from the installed **`@agent-relay/cloud@12.4.1`**, not a dependency added to this repository. The following are literal excerpts from that version; line numbers refer to the published `dist/` files.

`@agent-relay/cloud@12.4.1 dist/types.js:14`:

```js
export const DEFAULT_REFRESH_TIMEOUT_MS = 10_000;
export const AUTH_FILE_PATH = path.join(os.homedir(), '.agentworkforce/relay', 'cloud-auth.json');
```

`@agent-relay/cloud@12.4.1 dist/auth.js:14`:

```js
const AUTH_DIR_PATH = path.dirname(AUTH_FILE_PATH);
const AUTH_LOCK_PATH = `${AUTH_FILE_PATH}.lock`;
const AUTH_LOCK_RETRY_DELAY_MS = 50;
const AUTH_LOCK_STALE_MS = 30_000;
const AUTH_LOCK_TIMEOUT_MS = 30_000;
```

`@agent-relay/cloud@12.4.1 dist/auth.js:62`:

```js
function isValidStoredAuth(value) {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const auth = value;
    return (typeof auth.accessToken === 'string' &&
        typeof auth.refreshToken === 'string' &&
        typeof auth.accessTokenExpiresAt === 'string' &&
        typeof auth.apiUrl === 'string' &&
        (auth.refreshTokenExpiresAt === undefined || typeof auth.refreshTokenExpiresAt === 'string') &&
        !Number.isNaN(Date.parse(auth.accessTokenExpiresAt)) &&
        (auth.refreshTokenExpiresAt === undefined || !Number.isNaN(Date.parse(auth.refreshTokenExpiresAt))));
}
```

`@agent-relay/cloud@12.4.1 dist/auth.js:97`:

```js
}
export async function writeStoredAuth(auth) {
    await fs.mkdir(AUTH_DIR_PATH, {
        recursive: true,
        mode: 0o700,
    });
    const temporaryPath = path.join(AUTH_DIR_PATH, `.${path.basename(AUTH_FILE_PATH)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
    try {
        await fs.writeFile(temporaryPath, `${JSON.stringify(auth, null, 2)}\n`, {
            encoding: 'utf8',
            mode: 0o600,
        });
        await fs.chmod(temporaryPath, 0o600);
        await fs.rename(temporaryPath, AUTH_FILE_PATH);
    }
    finally {
        await fs.rm(temporaryPath, { force: true });
    }
}
```

`@agent-relay/cloud@12.4.1 dist/auth.js:203`:

```js
async function acquireStoredAuthLock(signal) {
    const startedAt = Date.now();
    while (true) {
        if (signal?.aborted) {
            throw signal.reason ?? new Error('Cloud auth lock acquisition aborted');
        }
        try {
            await fs.mkdir(AUTH_LOCK_PATH, { mode: 0o700 });
            return;
        }
        catch (error) {
            if (!isNodeErrorWithCode(error, 'EEXIST')) {
                throw error;
            }
        }
        if (await removeStaleStoredAuthLock()) {
            continue;
        }
        if (Date.now() - startedAt >= AUTH_LOCK_TIMEOUT_MS) {
            throw new Error(`Timed out waiting for cloud auth lock at ${AUTH_LOCK_PATH}`);
        }
        await delay(AUTH_LOCK_RETRY_DELAY_MS, undefined, { signal });
    }
}
async function withStoredAuthLock(callback, options = {}) {
    await fs.mkdir(AUTH_DIR_PATH, {
        recursive: true,
        mode: 0o700,
    });
    await acquireStoredAuthLock(options.signal);
    try {
        return await callback();
    }
    finally {
        await fs.rm(AUTH_LOCK_PATH, { recursive: true, force: true });
    }
```

`@agent-relay/cloud@12.4.1 dist/auth.js:448`:

```js
    }
    return withStoredAuthLock(async () => {
        const latestAuth = await readCanonicalStoredAuth();
        const refreshSource = latestAuth?.apiUrl === auth.apiUrl ? latestAuth : auth;
        if (!options.force && latestAuth?.apiUrl === auth.apiUrl && !shouldRefreshStoredAuth(latestAuth)) {
            return latestAuth;
        }
        const nextAuth = await requestStoredAuthRefresh(refreshSource, options);
        // Some credentialed callers impose a stricter transport contract than the
        // general Cloud client. Validate a refresh-selected host before persisting
        // the rotated credentials or allowing a retry to send them there.
        options.validateApiUrl?.(nextAuth.apiUrl);
        await writeStoredAuth(nextAuth);
```

`@agent-relay/cloud@12.4.1 dist/auth.js:464`:

```js
async function requestStoredAuthRefresh(auth, options = {}) {
    options.validateApiUrl?.(auth.apiUrl);
    const response = await fetchWithRefreshTimeout(buildApiUrl(auth.apiUrl, '/api/v1/auth/token/refresh'), {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
        },
        body: JSON.stringify({ refreshToken: auth.refreshToken }),
        // An opt-in host policy also refuses HTTP redirects so a 307 cannot
        // replay the refresh token to an unvalidated destination.
        ...(options.validateApiUrl ? { redirect: 'error' } : {}),
    }, options);
    const payload = (await response.json().catch(() => null));
    if (!response.ok || !payload?.accessToken || !payload?.refreshToken || !payload?.accessTokenExpiresAt) {
        throw refreshExpired();
    }
    const nextRefreshTokenExpiresAt = typeof payload.refreshTokenExpiresAt === 'string' && payload.refreshTokenExpiresAt.trim()
        ? payload.refreshTokenExpiresAt.trim()
        : auth.refreshTokenExpiresAt;
    const nextAuth = {
        apiUrl: typeof payload.apiUrl === 'string' && payload.apiUrl.trim() ? payload.apiUrl.trim() : auth.apiUrl,
        accessToken: payload.accessToken,
        refreshToken: payload.refreshToken,
        accessTokenExpiresAt: payload.accessTokenExpiresAt,
        ...(nextRefreshTokenExpiresAt ? { refreshTokenExpiresAt: nextRefreshTokenExpiresAt } : {}),
    };
    return nextAuth;
```

`@agent-relay/cloud@12.4.1 dist/api-client.js:9`:

```js
export function buildApiUrl(apiUrl, p) {
    return new URL(trimLeadingSlash(p), withTrailingSlash(apiUrl));
}
function bearerHeaders(headers, accessToken, defaultJson) {
```

