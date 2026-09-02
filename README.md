# pi ecode

A minimal, local-first Electron UI for the [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent). It is designed as a focused personal desktop client: choose a project, continue a pi session, stream work, inspect tool activity, and stop or steer the agent.

## Current MVP

- Local project picker
- Persistent sessions per project
- New and resumed conversations
- Streaming assistant responses
- Collapsible tool activity and output
- Stop and steer behavior while the agent is working
- Available model and thinking-level selectors
- Project-owned shadow Git checkpoints with conversation-aware undo/redo
- Host-owned `typecheck → test → build` verification with live logs, cancellation, and stale-result tracking
- Automatic recognition of the pi-ecode source workspace as a self-hosting project
- Latest-turn changed-file list, line statistics, unified patch review, and per-file rejection
- Persistent update ledger with active/failed/discarded outcomes and three-candidate artifact retention
- Isolated candidate staging with a frozen previous runtime
- Guarded restart with renderer/runtime health acknowledgement and automatic fallback
- Restores the last opened project

The app uses your existing pi configuration and credentials from `~/.pi/agent`. Configure a model with the pi CLI before opening the desktop app.

## Run locally

Requirements: Node.js 24+ and a configured pi installation.

```bash
npm install
npm run dev
```

`npm run preview` automatically recognizes this checkout and opens it as the active self-hosting project before the window appears. Candidate and fallback runtimes restore the same source root from staged metadata.

On npm versions that defer Electron's binary download, run this once after installation:

```bash
npm exec electron -- --version
```

## Verify and build

```bash
npm run typecheck
npm test
npm run build
```

The unpackaged production output is written to `out/`. The in-app verification panel runs only configured `typecheck`, `test`, and `build` package scripts; it does not accept arbitrary renderer commands.

Rejecting a reviewed file restores only that path to its pre-task state, checkpoints the result, and invalidates prior verification/candidates. Keeping a file is the default acceptance; preparing a candidate adopts the remaining reviewed changes.

For the recognized pi-ecode source project, a passed verification can be staged under `~/.pi/agent/state/pi-ecode-self-update`. The app freezes the currently running artifact, stages the candidate separately, and starts it through an external supervisor. The candidate has 25 seconds to restore the renderer and initial pi project runtime; otherwise the supervisor terminates it and launches the frozen previous artifact. Supervisor outcomes are reconciled into `ledger.json`; old artifact directories are cleaned while their discarded history remains visible. This activation path currently targets the unpackaged development runtime. Packaged installer replacement remains disabled until a packaging-aware launcher is added.

## Architecture

```text
React renderer
     │ typed, narrow contextBridge API
Electron preload
     │ named IPC channels
Electron main ── @earendil-works/pi-coding-agent SDK
```

The renderer has no Node.js access. The main process owns the active pi runtime, session lifecycle, model state, filesystem-facing operations, and workspace history. History is stored outside projects under `~/.pi/agent/state/pi-ecode-workspace-history`; it does not add commits to the project's Git repository. See [AGENTS.md](AGENTS.md) for project rules, source layout, and the MVP boundary.

The checked-in `docs/` and `examples/` directories are upstream pi reference material and are not application source.
