---
name: engineering-conventions
description: House engineering conventions for this repo. Apply to every code change, however small.
---

# Engineering conventions

Follow these four rules on every change, without being reminded per task:

1. **Test-first.** Before changing implementation code, add or update a test
   that fails for the bug/behavior you're about to fix, then make it pass.
   Never ship a behavior change with no test covering it.
2. **No debug leftovers.** Never leave `console.log`, `console.debug`,
   `debugger`, or commented-out code in what you commit.
3. **No secrets.** Never commit API keys, tokens, private keys, or other
   credentials, including as placeholder-looking example values in code you
   add.
4. **Conventional commits.** Format every commit message as
   `type(scope): subject` using one of `feat`, `fix`, `chore`, `refactor`,
   `test`, `docs` — e.g. `fix(calculator): reject division by zero`.
