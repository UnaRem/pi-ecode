# pi-ecode contributor guide

## Product intent

pi-ecode is a small, local-first desktop client for one person using the pi coding agent. It should feel calm and direct: open a project, continue a session, send a task, inspect tool activity, and stop or redirect the agent without leaving the window.

The product borrows interaction ideas from Codex Desktop, not its branding or exact visuals. Prefer a coherent minimal UI over a broad feature set.

## MVP contract

The first usable release includes:

- selecting a local working directory;
- persistent pi sessions scoped to that directory;
- creating and switching sessions;
- streaming assistant text and visible tool activity;
- sending, steering, and stopping work;
- selecting an available model and thinking level;
- clear empty, loading, error, and disconnected states;
- project-owned workspace checkpoints with undo/redo across conversation and files;
- host-owned validation of configured `typecheck`, `test`, and `build` scripts with streamed logs and stale-result tracking;
- task-level workspace diff review, per-file rejection, version ledger, bounded candidate retention, and guarded self-update candidates for the unpackaged development runtime.

Images, general-purpose session branching, compaction controls, command palettes, terminal embedding, git review, and settings screens are later work unless a task explicitly requests them.

## Architecture

Use Electron with three strict layers:

```text
src/renderer  React UI; no Node.js or pi imports
      │
      │ typed window.piDesktop API
      ▼
src/preload   narrow IPC adapter; no product state
      │
      │ named IPC channels
      ▼
src/main      windows, native dialogs, pi SDK, filesystem/session lifecycle
```

- The renderer is untrusted. Keep `contextIsolation: true`, `nodeIntegration: false`, and never expose raw `ipcRenderer`.
- Only `src/main/agent/` and `src/main/history/` may import `@earendil-works/pi-coding-agent` or `@earendil-works/pi-ai`.
- IPC contracts live in `src/shared/`. Main, preload, and renderer must use those shared types.
- Do not send class instances over IPC. Map SDK values and events to small serializable view models.
- Keep one active pi runtime per application window for the MVP. Replacing project or session must dispose the previous runtime and unsubscribe its listeners.
- The active working directory is explicit state. Never silently fall back to the app repository or home directory after the user selected another project.

## State and event rules

- Main process owns authoritative agent state: project, active session, model, thinking level, streaming status, available sessions, workspace history, and validation results.
- Renderer owns ephemeral presentation state: composer text, expanded tool cards, sidebar visibility, and scroll position.
- On startup or project change, renderer requests one snapshot and then applies ordered events.
- Treat the final SDK `message_end` payload as authoritative. Streaming deltas are temporary display state.
- Correlate tool activity by `toolCallId`; updates replace prior partial output, and end events finalize it.
- A prompt accepted while idle starts immediately. While streaming, the default send action is `steer`; stopping clears queued work before aborting.
- Surface recoverable failures in the conversation or status area. Do not hide errors in developer-console-only logs.

## Source layout

```text
src/
  main/
    agent/       pi SDK adapter and SDK-to-view-model mapping
    ipc/         IPC registration only
    history/     project-owned shadow Git snapshots and restore orchestration
    validation/  fixed host-run verification pipeline and process lifecycle
    update/      isolated runtime staging, supervisor, health gate, and fallback
    index.ts     Electron lifecycle and window creation
  preload/       safe window API implementation
  renderer/
    components/  focused visual components
    hooks/       renderer orchestration and subscriptions
    lib/         pure renderer helpers
    styles/      tokens and global styles
  shared/        serializable contracts, channel names, shared pure helpers
```

Keep files focused. When a component exceeds roughly 250 lines or mixes orchestration with several visual regions, split it by responsibility. Avoid generic `utils.ts`; name helpers after their domain.

## UI principles

- Optimize for a 1100×720 window, while remaining usable down to 820×560.
- Use a restrained neutral palette, one accent color, subtle borders, and no decorative gradients.
- Conversation content has a readable maximum width; chrome may span the window.
- User messages are visually compact. Assistant responses prioritize readable prose and code.
- Tool calls are collapsed summaries by default and reveal command/output on demand.
- The composer is the visual anchor. `Enter` sends, `Shift+Enter` inserts a newline, and the stop action occupies the send button while streaming.
- Every icon-only control needs an accessible name and visible hover/focus state.
- Respect `prefers-reduced-motion`; animation must not communicate unique state.

## Code conventions

- TypeScript is strict. Do not use `any`; prefer `unknown` plus narrowing at external boundaries.
- Use functional React components and hooks. Keep agent orchestration in a hook, not spread across presentational components.
- Use named exports except for the application root where a default export is acceptable.
- Prefer domain names such as `AgentSnapshot`, `ConversationItem`, and `ToolActivity` over transport names.
- Use immutable renderer state updates. Main-process service classes may use private mutable state for lifecycle management.
- Comments should explain protocol constraints or non-obvious lifecycle decisions, not restate code.
- Keep dependencies few. Add one only when it materially reduces complexity or accessibility risk.

## Verification

Before considering a change complete, run:

```bash
npm run typecheck
npm test
npm run build
```

For UI changes, also launch `npm run dev` and manually verify project selection, session switching, send/stream/stop, keyboard input, long tool output, and an error state. Tests should cover pure event reducers and SDK-to-view-model mapping before pixel-level component snapshots.

## Repository hygiene

- `docs/` and `examples/` are vendored pi reference material. Read them when changing integration behavior; do not casually edit them.
- Never commit credentials, `.env` files, session JSONL files, build output, Electron user data, or shadow Git history.
- Workspace history is a core project module. Keep its storage outside the selected workspace and do not make correctness depend on a globally installed checkpoint extension.
- Validation commands are selected from an internal allowlist. Never accept an arbitrary executable or shell command from the renderer for the self-hosting pipeline.
- A successful validation becomes stale after a new agent run, workspace restore, or observed source change. Do not present stale checks as proof that the current source is safe to adopt.
- Candidate preparation requires a current successful validation and the recognized pi-ecode source project. Stage candidates outside the workspace.
- Never overwrite the frozen previous runtime after validation has rebuilt `out/`. The supervisor must retain an immutable fallback until candidate health is confirmed.
- Candidate health requires main, preload, renderer, IPC, and initial project/runtime restoration to complete. A process merely staying alive is not healthy.
- Keep self-update disabled for packaged builds until a packaging-aware external launcher is implemented.
- Renderer-requested per-file rejection must resolve only from the current main-owned review list. Never treat a renderer path as an arbitrary filesystem target.
- Keep at most three non-protected candidate artifact directories. Preserve ledger records after cleanup by marking them discarded.
- Write update ledger changes through a temporary file and rename, and reconcile supervisor result files at startup.
- Keep architectural decisions reflected here. If a feature needs to violate a rule, update this file in the same change and explain why.
- Do not add compatibility abstractions for hypothetical platforms. This project targets the current owner's desktop first.

## Relevant pi references

- `docs/sdk.md`: direct SDK integration and `AgentSessionRuntime` lifecycle.
- `docs/session-format.md`: persistent session structure.
- `docs/sessions.md`: session discovery and naming behavior.
- `examples/sdk/13-session-runtime.ts`: replacing and rebinding sessions.
- `docs/rpc.md`: event semantics; useful even though this app uses the direct SDK.
