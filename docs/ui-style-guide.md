# PiECode UI style guide

PiECode uses one fixed light visual system. A user-selected conversation background image may sit beneath translucent conversation surfaces, but component colors do not change with user configuration.

## CSS architecture

Renderer styles load through `src/renderer/styles/index.css` in this order:

1. `tokens.css` — palette primitives, semantic tokens, spacing, radii, shadows, layout dimensions, motion;
2. `base.css` — reset, typography inheritance, focus, scrollbars, shared icon controls and reduced motion;
3. `layout.css` — application columns, region sizing and scroll ownership;
4. `components/*.css` — component-local appearance and state rules.

A component sheet may depend on tokens and base rules, but must not depend on another component sheet's internal selector. Temporary migration aliases and rules live in `components/legacy.css` and must not receive new features.

## Variable contract

Use variables by responsibility:

- palette primitives (`--blue-500`, `--slate-200`) are defined only in `tokens.css`;
- components consume semantic colors (`--color-accent`, `--color-surface`, `--color-text-muted`);
- spacing uses the 4px scale (`--space-1` through `--space-10`);
- controls consume shared radius, height and shadow tokens;
- application columns consume `--sidebar-width`, `--inspector-width` and `--conversation-max-width`.

Do not add a raw color to a component rule when an existing semantic token expresses its role. Add a semantic token when the role is real and shared; do not add a token for a single arbitrary value.

## Layout contract

- `.app-shell` owns the application columns.
- The sidebar, workspace and inspector are peer regions.
- Each region root owns its scrolling. Nested lists may scroll only when their content is explicitly bounded.
- Components do not set viewport-wide widths or reposition sibling regions.
- The conversation and composer share `--conversation-max-width` and align to the same horizontal edges.
- The three-column workspace remains present at the supported 820px minimum width. The existing sidebar collapse action may release space; the inspector remains visible.

## Component contract

- Use focused class names tied to a product concept; avoid generic `.card`, `.row` or `.container` selectors.
- Represent state with semantic classes or `data-state`; do not infer product state from incidental DOM nesting.
- Icon-only buttons have an accessible name, a visible hover state and a `:focus-visible` outline.
- Click targets are at least 32px; primary circular actions are 44px.
- Cards use semantic surface, border, radius and shadow tokens. Extra borders must communicate grouping or state.
- Selected tools synchronize the inspector. Conversation tool cards do not add a selection outline.
- Code and terminal output use `--color-code-bg` and `--color-code-text`.

## Motion contract

Motion must explain space, state or progress:

- hover/focus feedback: 120–150ms;
- mounted panels and menus: 180ms enter, 140–180ms exit;
- tool insertion: 180–220ms;
- looping motion is reserved for genuinely running work.

Animations must be interruptible. Closing logic and focus changes must not wait for decorative motion. Streaming text and incremental tool output must not replay entrance animations. Under `prefers-reduced-motion: reduce`, remove movement and loops while preserving every action and cleanup path.

## Background images

A custom background image affects only the conversation workspace. Text and controls remain on semantic translucent surfaces with sufficient contrast. Theme color configuration is not applied to the renderer.

## Review checklist

Before merging a UI change, verify:

- the rule belongs in the correct layer;
- component colors use semantic tokens;
- layout and scroll ownership remain explicit;
- hover, focus, disabled, running, success and error states remain distinguishable;
- reduced-motion behavior preserves functionality;
- 1100×720 and the supported 820×560 minimum remain usable;
- no streaming or incremental render replays an entrance animation.
