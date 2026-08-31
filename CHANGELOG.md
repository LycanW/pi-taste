# Changelog

All notable changes to Pi Taste are documented here.

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
