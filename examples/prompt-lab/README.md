# Prompt Lab

Prompt Lab is your product brief as one runnable relayflow. It does the brief's
two jobs, plus making test patients. It stops and asks you wherever the brief
says **You**.

| Job | What it does | Where it asks you |
|---|---|---|
| `new-agency` | Sets up a new agency's prompts and runs them on fake patients | 1. Review the answers. 2. Approve what goes live. |
| `fix` | Fixes one prompt from an issue, then scores the fix | 1. Set the right answers. 2. Mark it done (it goes live). |
| `patient` | Makes a new fake patient for a coverage gap | 1. Start the build. |

## Setup (once)

You need Node 22.6+ and a signed-in [Claude Code](https://claude.com/claude-code).

```sh
npm install
node --experimental-strip-types store.ts ./lab seed fixtures
```

This creates `./lab`: a sample Bank with three agencies and three fake
patients.

## Run a job

```sh
npx flows run prompt-lab.flow.ts --local-agent --input \
  '{"job":"new-agency","reviewer":"you","lab":"./lab","agency":"sunrise","visitType":"soc"}'
```

Other jobs use the same command with a different `--input`:

- Fix a question: `{"job":"fix","reviewer":"you","lab":"./lab","issueId":"<id from lab/queue/issues.json>"}`
- Make a patient: `{"job":"patient","reviewer":"you","lab":"./lab","briefId":"<id from lab/queue/patient-briefs.json>"}`

## When it stops for you

The run pauses and prints three things:

1. **The file to review** (for example `lab/work/…/grid.json`). Open it and
   change any answer, confidence or explanation that's wrong.
2. **An answer command:** `npx flows answer … yes`. Use `no` to stop.
3. **A resume command:** `npx flows resume …`. Run it to continue.

Your first edits are saved as the right answers. The AI never overwrites them.

## Good to know

- **The fake Bank.** "Apricot" here is the local `lab` folder, and the chart
  engine is a Claude call. Connecting it to the real Bank and engine is the
  next step.
- **Shared prompts.** Marking a shared prompt done changes it for every agency
  that uses it. The run warns you first.
- **Runs locally, not on Cloud yet.** Each job takes a few minutes, because AI
  calls run one at a time for now.

How it was tested, with full evidence: [PROOF.md](PROOF.md).
