# Changelog

All notable changes to Pi Taste are documented here.

## 0.5.1 - 2026-09-01

- Fix Learner tool schema for Pi: use `parameters` (Pi Tool type) instead of
  Command Code's `input_schema`, which caused
  `Cannot read properties of undefined (reading 'properties')` on some providers
  (notably Windows). The Learner now sends provider-compatible tool definitions.


## 0.5.0 - 2026-09-01

### v3: Command Code 1:1 learning pipeline (no cloud sync)

- The Learner is now a full Command Code-style tool-calling agent: it reads/writes
  taste.md directly via read_taste_file / write_taste_file / edit_taste_file.
- No state machine: all learnings are injected (Command Code injects everything,
  including low-confidence entries).
- No audit log, no preferences.json, no events.jsonl, no Reducer decision path:
  taste.md is the single source of truth in Command Code format:
  `- statement. Confidence: 0-1`.
- Injection uses the exact Command Code `<taste>...</taste>` block (global + project
  concatenated, "See [category/taste.md]" references preserved).
- Automatic category reorganization: categories with >5 learnings move into
  `{category}/taste.md` with a `See [category/taste.md]` link in the root file.
- Learner context mirrors Command Code: visible user/assistant text only, no
  thinking, no tool results, no metadata. Previous-analysis window prevents
  re-learning.
- Kept Pi integration shell: `/taste` commands, footer status, activity cards,
  model selector, post-settle trigger, single-concurrency queue.

## 0.4.0 - 2026-08-31

### v2 architecture (reverse-engineered from Command Code)

## 0.4.0 - 2026-08-31

### v2 architecture (reverse-engineered from Command Code)

- Replace the classified Observer with a semantic **Learner**: the model decides whether a durable, generalizable preference was revealed (no `task_constraint`/`correctness_fix`/`acknowledgement` buckets).
- Remove vocabulary gates (`hasDurableMarker`, `hasTurnOnlyMarker`, `isLowSignalFeedback`): the model sees full visible conversation and reasons semantically.
- Learner context now contains only visible user/assistant text (plus session summary); thinking, tool calls, tool results, and technical metadata are excluded.
- `taste.md` is now the **single authoritative state**, formatted like Command Code (`- statement. Confidence: 0-n` with `[pending]`/`[rejected]`/`[superseded]` markers); `preferences.json`/`events.jsonl` are gone (history lives in Pi session JSONL).
- Project `includeGlobalTaste` moved into `taste.md` frontmatter (no project `config.json`).
- Confidence is model-maintained (0-1), like Command Code, instead of code-computed.
- Audit log is bounded: `audit/current.jsonl` rotates into `segment-*.jsonl` with segment/total-byte caps.
- Keep approved-only injection, least-scope classification, manual global overrides, post-settle Learner, single concurrency, retry, Curator, footer, and activity cards.
- Reducer retains only mechanical safety: quote verification, dedupe, state machine, path containment, atomicity, locking, redaction.

## 0.3.2 - 2026-08-31

- Add `/taste retry [event-id]` for explicit, project-local replay of failed Observer events.
- Reuse saved redacted feedback and Agent outcome while applying the current model and Global setting.
- Keep the original failed event ID as the Reducer evidence ID for idempotent retries.
- Queue retries behind foreground Agent work and record every attempt with `retryOf` audit metadata.
- Exclude successfully retried events from later default retry selection.
- Remove the independent injection switch; `/taste on|off` now controls both automatic learning and all Taste injection.

## 0.3.1 - 2026-08-31

- Start automatic Observer work only after the complete foreground Agent run has settled.
- Capture raw interactive and RPC input, including mid-stream steering and follow-up corrections.
- Snapshot in-progress Assistant text, tool calls, and completed tool results when a correction is inserted.
- Keep Observer work asynchronous: later user turns do not wait for or cancel a running Observer.
- Preserve serialized Observer processing without adding a fixed delay or changing the configured model.

## 0.3.0 - 2026-08-31

- Apply least-scope automatic classification: Project by default, Global only from explicit cross-project evidence.
- Make the per-project Global switch govern both Global injection and automatic Global learning.
- Default newly initialized projects to Global injection and automatic Global learning enabled while preserving existing project config.
- Deterministically constrain automatic Global proposals to Project scope while Global learning is off.
- Keep explicit `-g` and `move ... global` commands as manual scope overrides.

## 0.2.0 - 2026-08-31

- Treat Pi's current working directory as the project root when no Git root exists.
- Keep nearest-Git-root behavior for nested folders inside repositories.
- Make ordinary workspace folders default to Project Taste without requiring `.git`.
- Initialize `.pi/taste/` state when Taste loads for a workspace.
- Default each project to Project-only injection; Global Taste must be enabled explicitly with `/taste global on`.
- Store the per-project Global Taste switch in `.pi/taste/config.json` and expose it in status/footer UI.
- Update scope status messages, documentation, and coverage for non-Git workspaces.

## 0.1.0 - 2026-08-30

Initial public release.

- Conservative Observer and deterministic Reducer preference-learning pipeline.
- Approved-only, cache-stable global and project Taste injection.
- Durable TUI activity cards and footer status.
- Explicit model selection with inherit and custom modes.
- Review, forget, import, move, and scope-aware manual preference commands.
- Explicit plan-review-apply Curator workflow.
- Read-only Command Code Taste compatibility.
- Atomic local storage, audit events, locks, redaction, and child-process learning guards.
- English and Simplified Chinese documentation.
