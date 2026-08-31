# Contributing

Issues and focused pull requests are welcome.

## Development

```bash
git clone https://github.com/LycanW/pi-taste.git
cd pi-taste
npm install
npm run check
npm run pack:check
```

`npm run check` runs TypeScript plus Node's test coverage gate. The aggregate
minimums are 90% lines, 75% branches, and 85% functions. CI runs the same gate
on Node 22 and 24 on both Linux and Windows.

Try the extension without installing it permanently:

```bash
PI_TASTE_DIR=/tmp/pi-taste-dev pi -e .
```

Do not commit real preference state, provider credentials, or session data.
Real-provider E2E tests must use an isolated `PI_TASTE_DIR` and temporary
project/session directories.

## Test expectations

Tests should cover the full affected feature surface, not only a happy path.
Depending on the change, include:

- unit cases for parsing, path validation, and tool failures;
- extension lifecycle coverage (`input` → `agent_settled` → Learner);
- Global and Project scope behavior;
- raw `<taste>` injection, including Confidence and category references;
- queue concurrency, provider failures, and disabled learning;
- Windows-invalid paths, reserved names, CRLF, and long inputs;
- command integration for any affected `/taste` command.

Credential-gated real-provider E2E remains a manual release check and does not
run in pull requests:

```bash
PI_TASTE_E2E_MODEL=provider/model npm run test:e2e
```

Set `PI_BIN` when `pi` is not on `PATH`. Set `PI_TASTE_E2E_KEEP=1` to preserve
an isolated failed run for diagnosis. The script verifies actual model learning,
physical Project Taste persistence, the seven-unheaded-entry Windows regression,
and injection into an independent second session.

## Design constraints

Changes should preserve these invariants:

- `taste.md` is the single readable source of truth.
- The Learner writes only `taste.md` or `{category}/taste.md` inside its store.
- Learner input contains visible user/assistant text, never thinking or tool results.
- Learning runs after `agent_settled` through a single-concurrency queue.
- Subagent children may receive injection but must not learn independently.
- Global Taste is explicitly managed; automatic learning writes Project Taste
  whenever a project/current working directory is available.
- Stored Taste is injected verbatim enough to preserve headings, Confidence,
  and `See [category/taste.md]` references.
