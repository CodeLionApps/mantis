# Working on Mantis

Read [README.md](README.md) first, especially [Scope](README.md#scope). This repo is public.

## Keep core generic

- The only assumption is React Native (New Architecture). No app-specific testIDs, labels, strings, screens or
  locales in `src/`, `android/`, `ios/`.
- Prefer RN-level mechanisms (the fiber tree, `BackHandler`, `Modal` `onRequestClose`, the native view hierarchy)
  over UI heuristics. When a heuristic can't be avoided, make it locale-free, the last resort, and document it.
- A change motivated by one app: state it as a generic problem, reproduce it with a screen in `example/`, and test it
  there. Don't name that app in code, tests, commit messages, PR descriptions or issues.
- Return facts, not policy. Retries, fallbacks and "what to do next" belong to the caller; core reports what happened
  (`moved`, `seen`, `MantisError.code`) so the caller can decide.
- No option added for one caller's convenience. If a caller needs a different policy, expose the fact it needs.
- Agent logic (LLM prompts, planning, judging), reporting (video, metrics) and app glue (login, launch arguments)
  stay in the tools that use Mantis.

## Public repo hygiene

No internal hostnames, account names, credentials, screenshots, logs or bundle ids from private apps in code, docs,
commits, PRs or issues.

## Checks

- `npm test`: runner and query engine against fakes, no device.
- Device, from `example/`: `npm run e2e:build:android` (or `:ios`), then `npm run e2e:android` (or `:ios`) for the
  Detox layer, and `node --test --test-concurrency=1 e2e/*.mantis.js` for the runner API.
- The runner listens on host port 9123: only one Mantis app may be connected per host. Stop any other Mantis build
  (and its `adb reverse`) before running the example, and run the `*.mantis.js` files one at a time.
- A change on one platform: check the other one too, or say in the PR that it is untested there.
