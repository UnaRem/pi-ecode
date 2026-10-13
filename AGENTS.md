# pi-ecode contributor guide

## Product intent

pi-ecode is a small, local-first desktop client for one person using the pi coding agent. It should feel calm and direct: open a project, continue a session, send a task, inspect tool activity, and stop or redirect the agent without leaving the window.

The product borrows interaction ideas from Codex Desktop, not its branding or exact visuals. Prefer a coherent minimal UI over a broad feature set.

## MVP contract

The first usable release includes:

- selecting a local working directory;
- persistent pi sessions scoped to that directory;
- creating and switching sessions, displaying session file sizes with a 10 MiB reminder, and generating a short title after the first message;
- up to two user sessions executing in parallel in the selected project directory, with separate conversation files, per-session stopping, and an explicit shared workspace path;
- local tool capability recommendations and per-device execution statistics;
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
- Keep one selected project and one foreground session per window. `ProjectSessionService` owns independent `AgentService` instances, allows at most two executing sessions, and never disposes an executing session just because the foreground changes. Project replacement and shutdown must await every runtime and managed-process cleanup; retain failed registrations for retry.
- Only the two most recently viewed idle child runtimes are retained for fast session switching; executing runtimes and runtimes with owned background resources are protected from eviction. Project replacement and shutdown still await cleanup of every retained runtime.
- Session summaries reuse scans while JSONL inventory, sizes and modification metadata are unchanged. Read-only snapshots reuse the service's published summary list; writes and session lifecycle events refresh it. A transition publishes one authoritative snapshot without rereading it a second time.
- New conversations use independent runtimes and conversation files in the selected project cwd, including non-Git and unborn repositories. Up to two conversations may execute concurrently in that shared directory; file changes and task reviews therefore reflect shared project state. Never resume the most recent conversation when creating another runtime for a new conversation.
- Retained worktree ledgers are read only to discover historical conversations; do not create, merge or delete worktrees automatically. Resume those conversation files with the selected project cwd while keeping their original transcript directories for discovery and deletion. Historical workspace checkpoints remain tied to their original cwd and must not be restored across directories.
- The active working directory is explicit state. Never silently fall back to the app repository or home directory after the user selected another project.

## State and event rules

- Main process owns authoritative agent state: project, active session, model, thinking level, streaming status, available sessions, workspace history, and validation results.
- Renderer owns ephemeral presentation state: composer drafts per session, expanded tool cards, sidebar visibility, and scroll position. Recover failed background sends in their originating session.
- `projectPath` identifies the selected project; `workspacePath` identifies the foreground agent's actual cwd. Route narrow IPC operations to that foreground service at request acceptance. Tag foreground events with session IDs and discard stale events; project-wide session summaries and parallel counts remain unscoped.
- `agent:stop-session` accepts only a bounded session-file string and resolves it against the current project's loaded service registrations; never accept PID, command, or arbitrary runtime targets. Workspace undo, redo and file rejection require every project runtime to be idle, reserve the active runtime, block new sends and session transitions until restoration finishes, and finish before shutdown disposes the runtime; apply deferred configuration only when all sessions are idle and shutdown has not started.
- Title generation uses the selected model in a separate bounded request after the first user message is persisted. Persist the attempt, preserve user renames, and cancel requests when their runtime is disposed.
- Tool advice is transient request context on every model call. Match the current concrete operation, inputs, permissions and required indexes against tool descriptions, namespace guidance and parameter schemas before comparing execution samples. Prefer an applicable dedicated tool; use native `tool_search` when available to discover inactive deferred/codemode tools before falling back to a general shell. Do not publish fixed per-capability candidate rankings. Show execution observations only for currently declared, available tools, without ranking or pooling direct and nested samples; fewer than five completed calls is insufficient evidence. Record execution success/failure, cancellation, blocking and nested calls separately; none of these proves task completion. Store only aggregate counts and the latest 128 durations, outside the project, using a shared atomic writer keyed by device, hostname, OS and architecture.
- On startup or project change, renderer requests one snapshot and then applies ordered events.
- Empty conversations show local project suggestions derived from bounded reads of README, AGENTS and package metadata. Clicking a suggestion appends to that session's composer draft; it never starts an agent run automatically.
- Destructive UI confirmations use a bounded typed IPC request and a main-owned message box attached to the requesting window. Avoid renderer `window.confirm`; restore renderer keyboard focus only while the owner remains focused.
- Treat the final SDK `message_end` payload as authoritative. Streaming deltas are temporary display state.
- Correlate tool activity by `toolCallId`; updates replace prior partial output, and end events finalize it.
- A prompt accepted while idle starts immediately. While streaming, the default send action is `steer`; stopping clears queued work before aborting.
- Surface recoverable failures in the conversation or status area. Do not hide errors in developer-console-only logs.
- `request_confirmation` 保存 `pi-ecode.confirmation` v1 pending 工具结果并立即结束本轮，不使用弹窗或超时；等待确认在会话分支中持久化，离开及重开会话后仍可回复。同批仅允许第一个确认工具，其他工具及重复确认必须阻断。主进程包装已有 `finishTurn`，先执行既有回调，再清空队列并发起非等待的 abort，阻止 SDK 外层继续本轮；pending 期间后台 custom 消息只写入会话，不触发新轮次。
- 确认按钮发送可读中文动作和标题，可附补充要求，末尾带 `pi-ecode-confirmation-response` JSON 标记；renderer 仅隐藏合法尾缀并投影成功且 ID 匹配的 pending 工具结果，乐观用户消息不清除请求。主进程仅在 idle 且无提示词预检进行时接受与当前分支 details、ID、标题和动作一致的标记回复；正式用户消息使旧请求失效，普通文字仍正常发送。
- 主 service 拥有项目托管进程的登记、实时日志与停止职责；`start_process` 工具启动持续进程，停止操作使用登记 ID，切换项目和退出应用必须等待进程清理完成，失败应报告并保留重试能力。
- 托管进程的 renderer 控制仅通过 `process:stop` 窄 IPC 传递非空、长度不超过 200 的字符串 ID；主 service 必须再次确认登记 ID 属于当前项目，不接受 PID、命令或任意进程目标。

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
- The inspector has separate Tools, MCP and Validation tabs. MCP directory and local tool statistics live under MCP; the whole MCP directory starts collapsed. Execution list and output follow independently while at the bottom and pause when the user scrolls upward.
- Ordinary conversation notices expire after five seconds; non-actionable errors and compaction failures expire after eight seconds. Recovery actions remain visible, and dismiss/exit cleanup must complete without animation events.
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

## Main-session execution

- Each user conversation performs all work in its own main session. Parallel user conversations are independent main-session runtimes, not subagents; there are no subagent dispatch tools, catalog, or management UI.
- The main session implements changes directly within the user's authorization, rereads changed files, runs final validation, reviews the diff and `git status`, and commits verified work.
- Main-session `run_validation` uses the background dispatch protocol; do not poll or duplicate runs. Later source edits invalidate previous results.
- Before loading sessions at startup, remove retired subagent catalogs/session directories and `pi-ecode.explorer-*` custom records from main histories. Preserve main messages, unrelated extension records, session IDs, tree references, compaction boundaries, and file modification times. Stream large JSONL files and replace them atomically; leave originals intact on failure.
- Manual history cleanup must exclude any session still open in a running runtime; the next startup cleans that residual history before loading it.

## MCP and extensions

- Register pi 1.1 native MCP, tool search, and codemode extensions in each main-session runtime. Load global `mcp.json` and trusted project `.pi/mcp.json` through the SDK; do not load `pi-mcp-adapter` alongside native MCP.
- The inspector MCP directory reflects tool definitions registered by the current main session, including deferred tools. Update it after discovery and tools/list changes, remove hidden withdrawn tools, and isolate directories across session replacement. Send only tool names, server names, descriptions, and exposure over IPC; credentials stay in main.
- SoL-Pi has no managed settings or automatic package registration. Removing its global package registration disables future loading while retaining its installed checkout, original configuration, session records, and observation archives.

## Verification

Before considering a change complete, run:

```bash
npm run typecheck
npm test
npm run build
```

For UI changes, manually verify project selection, session switching, send/stream/stop, keyboard input, long tool output, error states and reduced motion. The owner launches the development runtime; do not automatically start dev or preview servers. Do not invoke a browser MCP merely to discover whether an app is running: the call can launch an automation browser. Tests should cover pure event reducers and SDK-to-view-model mapping before pixel-level component snapshots.

## Delivery workflow

- For implementation tasks, inspect the final workspace diff, run `npm run typecheck`, `npm test`, and `npm run build`, then review `git status` before delivery.
- Commit completed, verified implementation work using `<type>(<scope>): <Chinese description>`. Workspace-history snapshots do not count as repository commits.
- If Git cannot commit because identity, permissions, or hooks block it, report the exact blocker and leave the verified changes intact; never claim the task was committed.

## Repository hygiene

- `docs/` and `examples/` are vendored pi reference material. Read them when changing integration behavior; do not casually edit them.
- Never commit credentials, `.env` files, session JSONL files, build output, Electron user data, or shadow Git history.
- Workspace history is a core project module. Keep its storage outside the selected workspace and do not make correctness depend on a globally installed checkpoint extension.
- Validation commands are selected from an internal allowlist. Never accept an arbitrary executable or shell command from the renderer for the self-hosting pipeline.
- A successful validation becomes stale after a new agent run, workspace restore, or observed source change. Do not present stale checks as proof that the current source is safe to adopt.
- Candidate preparation requires a current successful validation and the recognized pi-ecode source project. Only the root project service may prepare or activate self-update candidates; retained child services remain ineligible even when they share the project cwd. Stage candidates outside the workspace.
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
