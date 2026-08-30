# Pi Taste

**English** | [简体中文](README.zh-CN.md)

Pi Taste is a local, reviewable preference-learning extension for the [Pi coding agent](https://github.com/earendil-works/pi-mono). It observes the previous Agent outcome together with the next user message, extracts evidence-backed durable preferences, applies them through deterministic code, and injects only approved preferences into future turns.

It does **not** train or modify model weights. The learned state remains readable, auditable, and removable on your filesystem.

Pi Taste is an independent open-source implementation inspired by the user-facing Taste workflow in Command Code. It is not affiliated with or endorsed by Command Code.

## 1. Quick start

Install the Pi package directly from GitHub:

```bash
pi install git:github.com/LycanW/pi-taste@v0.1.0
```

Try it for one run without installing:

```bash
pi -e git:github.com/LycanW/pi-taste@v0.1.0
```

This release is tested with Pi 0.84.4 and requires Node.js 22.19 or newer, matching Pi's runtime requirement.

After installation or an update, reload Pi:

```text
/reload
```

Check the current state:

```text
/taste status
```

Default behavior:

- automatic learning is on;
- approved Taste injection is on;
- the Observer follows the current main Pi model;
- automatic learning runs in the background;
- model-assisted curation never runs automatically.

Useful first commands:

```text
/taste list all
/taste remember -g Always keep responses concise unless I request detail.
/taste review
/taste model status
```

## 2. How automatic learning works

When `/taste on` is active, an ordinary user turn follows this pipeline:

```text
previous Agent behavior + current user feedback
    → background Observer
    → deterministic validation and reduction
    → approved / pending / rejected / superseded state
    → approved-only injection on a future turn
```

The current user message is the preference evidence. The previous Agent response, tool calls, and changed files are included only as the behavior being evaluated; they cannot independently create a preference.

The injection snapshot is created before the current feedback is queued for learning. Therefore, a newly learned preference can affect only a later turn, never the same turn that supplied its evidence.

Pi processes launched with `--no-session`, and `pi-subagents` children marked by `PI_SUBAGENT_CHILD=1`, receive approved Taste injection but do not generate learning events. `PI_TASTE_ALLOW_NO_SESSION=1` is intended only for isolated testing and never overrides the subagent-child guard.

## 3. Conversation activity cards

Every automatic Taste check writes a durable, tool-like card into the TUI transcript. The card can report:

- a newly approved preference;
- a pending preference awaiting review or repeated evidence;
- reinforcement of an existing preference;
- approval, rejection, forgetting, or supersession;
- an applied Curator operation;
- a checked turn with no persistent change;
- a deterministic low-signal skip; or
- an Observer failure.

Example:

```text
✓ Taste Updated — 1 approved
+ [global/approved] Always show exact file paths. — active next turn
State [global]: /home/user/.pi/agent/taste/preferences.json
Taste [global, approved view]: /home/user/.pi/agent/taste/taste.md
```

Status meanings:

- `approved`: becomes injectable starting with a future turn;
- `pending`: stored for review, but not injected;
- `rejected`: retained for audit, but not injected;
- `superseded`: replaced by another preference and no longer injected.

Press `Ctrl+O` to expand cards. Expanded details include preference IDs, reasons, Observer classification and model, event ID, and all audit paths.

Activity cards are Pi custom session entries, not model messages. They:

- persist when a session is resumed;
- never enter model context;
- consume no model tokens;
- do not alter the prompt-cache prefix.

Because the Observer runs in the background, its card may appear during or shortly after the main Agent response.

## 4. Safety and persistence policy

Pi Taste deliberately prefers missing a weak inference over storing a false preference.

- Silence, `ok`, `good`, `continue`, generic praise, and similar acknowledgements create no preference.
- One-turn constraints are never persisted.
- Correctness fixes and factual corrections are not treated as personal preferences.
- Explicit durable preferences can be approved immediately.
- An implicit correction starts as `pending`.
- A pending preference can become approved through explicit review or repeated independent evidence.
- `pending`, `rejected`, and `superseded` entries are never injected.
- Current explicit user instructions override all historical Taste.
- Project Taste overrides global Taste when both are relevant.
- Confidence is computed by code from evidence; the Observer cannot choose it.
- Confidence is audit metadata, not prompt weighting.
- Observer and Curator models never write preference files directly.

## 5. Footer status

In TUI mode, Taste status appears immediately after context-window usage:

```text
… 12.3%/272k Taste:on                         model • thinking
```

Possible indicators:

- `Taste:on`: automatic learning is enabled;
- `Taste:off`: automatic learning is disabled;
- `/inject-off`: approved Taste injection is disabled;
- `·N`: N Observer jobs are queued or running;
- `!`: the most recent Observer operation failed.

The footer is UI-only and does not enter model context. Other extension status lines are preserved. Pi supports only one custom footer owner, so another extension calling `setFooter()` later can replace this footer.

## 6. Taste model configuration

The default mode is `inherit`: the Observer uses the current main Pi model. Changing `/model` changes the model used for later Taste checks.

In TUI mode, run `/taste model` without arguments. Choose whether to follow the main model or use a separate model. Selecting a separate model opens Pi's native searchable model selector—the same interface used by `/model`, including provider labels, current-model marker, fuzzy search, keyboard navigation, scoped models, and catalog refresh.

```text
/taste model                    # mode menu, then Pi model picker
/taste model select             # open Pi model picker directly
/taste model select qwen        # open picker with an initial search
/taste model status
/taste model inherit
/taste model set                # picker in TUI; exact provider/model in RPC
/taste model only               # picker in TUI
/taste model add                # picker in TUI
/taste model remove             # choose from configured custom models
/taste model list qwen
```

Behavior:

- `status`: show mode, effective model, and custom fallback order;
- `inherit`: follow the current main model;
- `select [query]`: open Pi's model picker and use exactly the selected model;
- `set`: enter custom mode, make the selected model primary, and retain existing fallbacks;
- `only`: enter custom mode with exactly one selected model;
- `add`: add or move a selected fallback to the end;
- `remove`: select and remove a custom candidate; removing the last returns to `inherit`;
- `list [query]`: list available models matching an optional query.

Exact `provider/model` arguments remain available for scripts and RPC, but normal TUI use requires no manual model-ID entry. Custom mode never silently falls back to the main model. If none of its configured models has usable authentication, learning fails visibly and no preference is fabricated.

The Curator uses the same effective Taste model unless `/taste curate --model provider/model` supplies a one-plan override.

## 7. Reviewing and managing preferences

Scope follows Command Code's simple convention: inside a Git repository, manual remember/import defaults to **project** Taste; use `-g` for **global** Taste. Outside a Git repository, the default is global.

Show the exact paths and current default scope:

```text
/taste paths
```

List preferences:

```text
/taste list all
/taste list approved
/taste list pending
/taste list rejected
/taste list superseded
```

Remember an approved preference for the current project:

```text
/taste remember Always run this repository's formatter before committing.
```

Remember an approved global preference:

```text
/taste remember -g Always include exact validation commands.
```

`--global` is an alias for `-g`; `--project` is available when explicitness is useful.

Import a Command Code-style Markdown file (`- preference` per line):

```text
/taste import ./taste.md       # project by default in a Git repository
/taste import ./taste.md -g    # global
```

TUI import shows a bounded preview and asks for confirmation. Scripts and RPC use `--yes`. A confirmed import is an explicit user action, so imported entries are approved and deduplicated. Lines that resemble credentials are skipped. Import does not call a model.

Correct a preference's scope without losing history:

```text
/taste move <id> project
/taste move <id> global
```

The old entry becomes `superseded`; an approved entry is created or merged in the target scope.

Review a pending preference:

```text
/taste review
/taste review <id> approve
/taste review <id> reject
```

`/taste review` without an ID opens an interactive selector in TUI mode.

Forget a preference:

```text
/taste forget <id>
```

Forgetting is audit-preserving: it changes the status to `rejected` rather than deleting evidence.

## 8. Learning and injection controls

```text
/taste on
/taste off
/taste inject on
/taste inject off
```

These switches are independent:

- `/taste off` stops new automatic learning but does not remove or disable existing approved Taste;
- `/taste inject off` stops prompt injection but can leave automatic learning enabled;
- turning injection back on restores the approved snapshot.

## 9. Cache-stable injection

Approved Taste is appended to the system prompt as one deterministic snapshot. To protect provider prefix caches:

- only approved statements are included;
- timestamps, confidence, evidence counts, queue state, model names, and UI state are excluded;
- evidence reinforcement that does not change a statement leaves injected bytes unchanged;
- statements use stable source groups and creation order;
- Command Code confidence suffixes are stripped;
- category paths are sorted deterministically;
- pending preferences and unapplied Curator plans do not affect the prompt;
- the snapshot changes only when effective approved statements, scope, limits, or injection settings change.

`/taste status` reports the current snapshot digest, entry count, and byte count.

## 10. Curator

`/taste curate` performs explicit, model-assisted semantic maintenance over Pi Taste. It is never called automatically.

The Curator may propose:

- `merge`: combine true semantic duplicates;
- `rewrite`: clarify a preference without changing its meaning;
- `supersede`: choose a winner among clear variants or conflicts;
- `flag_conflict`: record a conflict requiring human judgment;
- `move_scope`: move a clearly misplaced global/project preference.

Commands:

```text
/taste curate                          # generate a plan; no mutation
/taste curate --model provider/model   # one-plan model override
/taste curate show                     # inspect the saved plan
/taste curate apply                    # confirm and apply in TUI
/taste curate apply --yes              # apply non-interactively
/taste curate discard                  # discard without changes
/taste curate rebuild                  # regenerate taste.md; no model call
```

Safeguards:

- every operation must reference existing preference IDs;
- the model cannot invent an unrelated preference;
- generated plans are validated and capped;
- plans are saved to `curation.json` before mutation;
- apply aborts if Taste changed after plan creation;
- apply requires a separate confirmation;
- original entries remain as `superseded` where applicable;
- evidence is preserved and merged;
- applied changes produce an activity card and audit event.

Command Code Taste imports remain read-only and are never curated.

## 11. Command reference

```text
/taste status
/taste list [approved|pending|rejected|superseded|all]
/taste paths
/taste remember [-g|--global|--project] <preference>
/taste import <markdown-file> [-g|--global|--project] [--yes]
/taste move <id> [global|project]
/taste review [<id> approve|reject]
/taste forget <id>
/taste on | off
/taste inject on | off
/taste model [status|inherit|select|set|only|add|remove|list] [provider/model|search]
/taste curate [show|apply [--yes]|discard|rebuild|--model provider/model]
/taste help
```

## 12. Storage

Global state:

```text
~/.pi/agent/taste/
├── config.json        # extension configuration
├── events.jsonl       # append-only feedback and audit events
├── preferences.json   # authoritative preference state
├── curation.json      # latest Curator plan, when present
└── taste.md           # generated approved-only human-readable view
```

Project state is created only when needed inside a Git repository:

```text
<git-root>/.pi/taste/
├── events.jsonl
├── preferences.json
└── taste.md
```

File roles:

- `preferences.json` is authoritative;
- `taste.md` is a generated approved-only view and the path shown in activity cards;
- `events.jsonl` is the append-only audit trail;
- editing generated `taste.md` directly is not the supported way to manage state.

Writes use atomic replacement and a cross-process lock. Store files are created with private permissions where supported.

## 13. Command Code compatibility

The following files are optional, read-only approved sources:

```text
~/.commandcode/taste/taste.md
<git-root>/.commandcode/taste/taste.md
<git-root>/.commandcode/taste/<category>/taste.md
```

Pi Taste normalizes and deduplicates these entries against Pi preferences. It never modifies Command Code Taste files. Suspicious malformed category paths are excluded.

## 14. Configuration

Default `~/.pi/agent/taste/config.json`:

```json
{
  "version": 1,
  "learningEnabled": true,
  "injectionEnabled": true,
  "observer": {
    "modelMode": "inherit",
    "models": [],
    "reasoning": "low",
    "maxOutputTokens": 2000,
    "timeoutMs": 45000,
    "maxInputChars": 24000
  },
  "injection": {
    "includeCommandCode": true,
    "maxPreferences": 80,
    "maxChars": 16000
  }
}
```

For isolated tests, `PI_TASTE_DIR=/tmp/pi-taste-test` redirects only the global Taste store. It does not move or copy provider credentials.

## 15. Privacy and security

- Common token and secret patterns are redacted before interaction excerpts are sent to the Observer or written to audit events.
- User messages and Agent outcomes are length-capped.
- Redaction is defense in depth, not a complete secret scanner.
- `events.jsonl` can still contain sensitive feedback or code excerpts; treat it as private.
- Activity cards contain preference text and absolute file paths, but they are not sent to the model.
- Provider credentials are never copied into Taste configuration or source code.

## 16. Backup and reuse on another device

The extension source can be reinstalled from GitHub. To preserve learned behavior, back up the private Taste state rather than only generated `taste.md`:

```text
~/.pi/agent/taste/
<git-root>/.pi/taste/   # when project Taste should also be preserved
```

A private encrypted backup of global state can be created with:

```bash
tar -C ~/.pi/agent -czf - taste \
| gpg --symmetric --cipher-algo AES256 \
  -o ~/pi-taste-backup.tar.gz.gpg
```

Restore with:

```bash
mkdir -p ~/.pi/agent
gpg --decrypt ~/pi-taste-backup.tar.gz.gpg \
| tar -xzf - -C ~/.pi/agent
```

Do not commit provider auth files or unencrypted Taste audit logs to a public repository. Avoid having two devices concurrently modify the same synced `events.jsonl` and `preferences.json`; the filesystem lock is local to one device and is not a cross-device merge protocol.

## 17. Troubleshooting

### No activity card appears

Check:

```text
/taste status
```

Possible causes:

- learning is off;
- the process is a `--no-session` or `pi-subagents` child;
- the background Observer has not finished yet;
- the extension was updated but Pi has not been reloaded.

Run `/reload` after changing extension files.

### A card says “pending; not injected”

This is intentional. Approve it with:

```text
/taste review <id> approve
```

or allow repeated independent evidence to reinforce it.

### Observer is unavailable or failed

Use:

```text
/taste model status
/taste model inherit
```

If custom mode is selected, confirm that the configured provider/model exists and has usable authentication. Taste does not silently switch to an unconfigured model.

The footer `!` marks the most recent unresolved Observer failure. It clears after a successful check, after changing the Taste model, after toggling learning, or after `/reload`. Historical failed events remain in `events.jsonl` for audit but do not restore the warning on startup.

### `taste.md` does not contain a pending preference

`taste.md` is approved-only. Pending and inactive preferences remain in `preferences.json` and can be inspected with `/taste list all`.

### Footer is missing but cards work

Another extension may own Pi's single custom footer slot. Activity cards and learning continue independently.

### Rebuild the readable view

```text
/taste curate rebuild
```

This regenerates `taste.md` from authoritative `preferences.json` without calling a model.

## 18. Design reference

Command Code's Taste documentation presents this objective:

```text
Meta-NeuroSymbolic Objective(φ)
= E[x~D_RL] E[y~LLM^NS_φ(x)] [
    RM_NS(x,y) - β_NS log(LLM^NS_φ(y|x) / LLM^SFT(y|x))
  ]
  + γ_NS E[x~D_pretrain] log LLM^NS_φ(x)
```

Pi Taste implements a transparent operational analogue rather than online weight training:

- `RM_NS`: grounded user evidence only;
- stability/change penalty: conservative updates and explicit state transitions;
- pretraining/stability term: stable readable instructions and deterministic injection;
- neuro-symbolic split: models propose semantic interpretations, while code validates evidence and owns persistence.

## License

[MIT](LICENSE) © 2026 LycanW
