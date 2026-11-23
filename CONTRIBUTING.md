# Contributing

Thanks for looking. This is a small plugin; the bar is low and the rules are short.

## Before you start

Run the tests. They need no network and no account:

```bash
npm test
```

If you change anything that decides what goes over the wire — the prompt a turn becomes, the JSON envelope for tool calls, the cookie renewal, the event stream reader — **add a test for it.** Almost every bug found in this plugin so far was in exactly those places, and each one has a test that would have caught it.

## What is worth a pull request

- A bug you hit, with the error text
- A place where Logicc behaves differently than the README says
- Anything that makes the paste-the-cookie path easier — it is the path people actually use
- Model metadata that is more accurate than our defaults

## What to avoid

- **Do not work around the macOS cookie permission.** The plugin cannot read Chrome's cookie store when magpie runs under `launchd`, and that is a deliberate boundary in the README, not a bug to fix. Anything that tries to bypass TCC will be declined.
- **Do not add dependencies.** Node built-ins only; that is a design constraint, not an accident.
- **Do not guess at Logicc's behaviour.** Measure it against your own account and say what you measured in the PR description. The `## Behaviour you should know about` table in the README exists because guesses turned out wrong.

## Testing against a real account

`test/live.e2e.mjs` spends real quota, so it is not part of `npm test`:

```bash
echo -n '<your __client value>' > /tmp/cookie.txt
node test/live.e2e.mjs /tmp/cookie.txt
```

Never commit that file. `.gitignore` covers `*.cookie`, `cookie.txt`, and `.env*`, but check before you push.

## Commit messages

One line, imperative, lowercase: `fix: keep rotated __client cookie`, `add: signin test for refused store`. Not enforced, just easier to read.

## Reporting a bug

Include:

- what you did, what happened, what you expected
- the exact error text (it is shown in magpie, and in `~/Library/Logs/magpie-web.log`)
- `node --version` and your magpie version
- whether the failing path was the browser sign-in or the paste sign-in

Do **not** paste a `__client` value, a session JWT, or a cookie of any kind into an issue. Redact it; the tail four characters are enough to identify which account you mean.
