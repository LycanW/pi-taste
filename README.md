# Pi Taste

**English** | [简体中文](README.zh-CN.md)

Pi Taste is a local Taste-learning extension for the [Pi coding agent](https://github.com/earendil-works/pi-mono). Its learning pipeline follows the same approach as [Command Code](https://commandcode.ai) Taste (without cloud sync), so it stays local and works with any model, including your ChatGPT/Codex account.

It does **not** train or modify model weights. Learned preferences land in a single readable `taste.md` file.

Pi Taste is an independent open-source project inspired by Command Code's Taste workflow.

## 1. Quick start

Install the Pi package directly from GitHub:

```bash
pi install git:github.com/LycanW/pi-taste@v0.5.4
```

Try it for one run without installing:

```bash
pi -e git:github.com/LycanW/pi-taste@v0.5.4
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

- Taste is on: automatic learning and Taste injection are both enabled;
- the Learner follows the current main Pi model (use `/taste model` to set a separate one);
- automatic learning starts after the foreground Agent fully settles and may continue in the background alongside later turns.

Useful first commands:

```text
/taste list
/taste remember -g Always keep responses concise unless I request detail.
/taste model status
```

## 2. How learning works

When `/taste on` is active, an ordinary user turn follows this pipeline:

```text
your visible message + assistant's visible text
    → current foreground Agent fully settles
    → background Learner (tool-calling model agent)
    → the model reads/writes taste.md itself
        read_taste_file / write_taste_file / edit_taste_file
    → automatic category reorganization (>5 learnings → {category}/taste.md)
    → full taste.md injected on a future turn via <taste>
```

The Learner gets the same kind of context Command Code uses:

- **NEW messages**: the visible user/assistant text from the current turn (thinking, tool results, and metadata are stripped);
- **Previously analyzed window**: recent surrounding context, provided only to resolve references, never re-learned;
- **Current taste structure**: a tree of your taste files and their learning counts.

The model decides semantically whether a durable, generalizable preference was revealed: coding style, tooling, workflow, communication. It records each one as:

```text
- Prefers tabs over spaces. Confidence: 0.9
```

There is **no state machine**. Anything the model writes is injected — exactly like Command Code, including low-confidence entries. Silent feedback, one-off constraints, and factual corrections are filtered by the model's judgment, not by keyword rules.

User steering and follow-up messages inserted while the Agent is streaming are also captured, evaluated against the assistant text visible at the insertion point.

The injection snapshot is created before the current feedback is held for learning, so a newly learned preference can affect only a later turn.

Pi processes launched with `--no-session`, and `pi-subagents` children marked by `PI_SUBAGENT_CHILD=1`, receive Taste injection but do not generate learning events. `PI_TASTE_ALLOW_NO_SESSION=1` is intended only for isolated testing and never overrides the subagent-child guard.

## 3. Conversation activity cards

Taste transcripts appear as activity cards in the conversation, so you can see what was learned. Cards show contents and paths; they are TUI-only and never enter the model context.

```text
✓ Taste Updated — 1 learned: Prefer tabs over spaces. (90%) → taste.md
State [global]: /home/user/.pi/agent/taste/taste.md
```

Cards cover:

- a learned preference (write/edit);
- a category reorganization;
- a Learner failure.

Press `Ctrl+O` to expand. Expanded details include model, event ID, and paths.

## 4. Safety

- Learning happens after `agent_settled`; later turns never wait for or cancel a running Learner (single-concurrency queue).
- Paths are contained: the model can only touch `taste.md` or `{category}/taste.md` inside the taste directory. `..`, absolute paths, and other names are rejected.
- Feedback and assistant text are length-capped and redacted (tokens/secrets) before being sent to the Learner.
- Provider credentials are never copied into Taste configuration or source code.

## 5. Footer status

When Taste is active, the model footer shows:

- `Taste:on` or `Taste:off`;
- `·N`: N Learner jobs queued or running;
- `!`: the most recent Learner operation failed.

## 6. Taste model configuration

The default mode is `inherit`: the Learner uses the current main Pi model. Changing `/model` changes the model used for later learning.

```text
/taste model status       # show mode and active model
/taste model inherit      # follow the current main model
/taste model select       # open Pi's model picker (TUI)
/taste model set provider/model
/taste model only provider/model
/taste model add provider/model
/taste model remove provider/model
/taste model list [query]
```

## 7. Managing preferences

Taste state is a single editable `taste.md`. You can also manage it with commands:

```text
/taste list [id|all]                 # show all learnings
/taste remember [-g] <preference>    # record manually (explicit user action)
/taste move <id> [global|project]    # move between scopes
/taste forget <id>                   # remove a learning
/taste import <file> [-g] [--yes]    # import bullets from a markdown file
```

- Default scope is `project`; `-g` targets the global store.
- `import` deduplicates and skips lines that look like credentials; it does not call a model.
- `forget` deletes the line.

## 8. Taste and Global controls

```text
/taste on | off
```

- `/taste on` enables both automatic learning and injection;
- `/taste off` disables automatic learning and all Taste injection; stored state is preserved.

There is no independent injection switch and no per-project global switch: like Command Code, the Learner writes to the project store (and the global store is available for explicit `-g` management). The `[pending]` marker from earlier versions no longer exists.

## 9. Storage

Global:

```text
~/.pi/agent/taste/taste.md
```

Project (nearest Git root, else Pi's working directory):

```text
<project-root>/.pi/taste/
├── .gitignore         # prevents accidental publication of private state
└── taste.md           # single authoritative preference file
```

`taste.md` format:

```text
- Prefers tabs over spaces. Confidence: 0.9
- Avoid worktrees. Confidence: 0.4
```

Categories (>5 learnings) automatically become:

```text
<project-root>/.pi/taste/<category>/taste.md
```

with the root `taste.md` holding `See [<category>/taste.md](<category>/taste.md)`.

Writes use atomic replacement and a cross-process lock. Store files are created with private permissions where supported.

## 10. Command Code compatibility

Pi Taste reads your existing Command Code Taste files as read-only input for injection:

```text
~/.commandcode/taste/taste.md
<project-root>/.commandcode/taste/taste.md
<project-root>/.commandcode/taste/<category>/taste.md
```

It never modifies them and deduplicates against Pi Taste. Since v0.5.0, the format and learning behavior follow Command Code, so you can point both tools at compatible files.

## 11. Configuration

Default `~/.pi/agent/taste/config.json`:

```json
{
  "version": 3,
  "learningEnabled": true,
  "observer": {
    "modelMode": "inherit",
    "models": [],
    "reasoning": "low",
    "maxOutputTokens": 6000,
    "timeoutMs": 90000,
    "maxInputChars": 30000
  },
  "injection": {
    "maxChars": 16000
  }
}
```

`learningEnabled` is the master switch controlling both automatic learning and injection.

For isolated tests, `PI_TASTE_DIR=/tmp/pi-taste-test` redirects only the global Taste store. It does not move or copy provider credentials.

## 12. Privacy and security

- Common token and secret patterns are redacted before interaction excerpts are sent to the Learner.
- User messages and assistant text are length-capped.
- Redaction is defense in depth, not a complete secret scanner.
- `taste.md` can contain preference text; treat it as private.
- Activity cards contain preference text and absolute file paths, but they are not sent to the model.
- Provider credentials are never copied into Taste configuration or source code.

## 13. Backup and reuse on another device

The extension source can be reinstalled from GitHub. To preserve learned behavior, back up the private Taste state:

```text
~/.pi/agent/taste/
<project-root>/.pi/taste/
```

A private encrypted backup of global state can be created with:

```bash
tar -C ~/.pi/agent -czf - taste \
| gpg --symmetric --cipher-algo AES256 \
  -o ~/pi-taste-backup.tar.gz.gpg
```

## 14. Troubleshooting

**Nothing is learned.**

- Check `/taste status` — `Taste: on` and no `!` in the footer.
- The Learner must have a working Token/API for the current model. `/taste model status` shows the active model.
- Feedback must contain an actual preference; silent acknowledgements are ignored by the model's judgment.

**Learner failed (`!` in footer).**

- Run `/taste status` to see the last error.
- Common causes: model overload, timeout, or unavailable auth.

**Learned something unexpected.**

- Edit `taste.md` directly (it is human-readable) or `/taste forget <id>`.

## License

MIT
