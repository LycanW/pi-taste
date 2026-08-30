# Contributing

Issues and focused pull requests are welcome.

## Development

```bash
git clone https://github.com/LycanW/pi-taste.git
cd pi-taste
npm install
npm run check
```

Try the extension without installing it permanently:

```bash
pi -e .
```

Use `PI_TASTE_DIR=/tmp/pi-taste-dev` for isolated manual testing. Do not commit real preference state, audit logs, provider credentials, or session data.

## Design constraints

Changes should preserve these invariants:

- Agent output alone is never preference evidence.
- Only approved preferences are injected.
- Current user instructions override stored Taste.
- Models propose semantic interpretations; deterministic code validates and persists them.
- Curator changes require an explicit plan and confirmation.
- Canonical injection must remain stable when effective approved content is unchanged.
- Subagent children may receive injection but must not learn independently.
