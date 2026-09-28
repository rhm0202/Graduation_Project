# Spotlight Cam Design System

## 0. Visual Preservation Contract

- The rendered Electron app and documentation at the start of this task are the visual source of truth.
- Maintenance and cleanup may remove comments or dead code only when the UI design contract test proves that CSS rules, HTML structure, visible copy, icons, and document behavior remain unchanged.
- No palette, typography, spacing, layout, component, motion, responsive, or interaction-state change is allowed without an explicit user request.
- If any visual change appears, restore the pre-change design before retrying the maintenance work.

## 1. Atmosphere & Identity

Spotlight Cam is a compact dark broadcast control surface focused on the live image. Teal communicates ready and active AI states, coral communicates recording emphasis, and purple remains part of the existing compatibility and AI-active language. The documentation deliberately keeps its separate dark navy, indigo, and violet gradient identity with centered marketing content and the existing camera mark.

## 2. Color

### Palette

| Role | Token | Value | Usage |
|---|---|---:|---|
| Surface/app | `--bg-app` | `#111113` | Electron app background |
| Surface/sidebar | `--bg-sidebar` | `#151517` | Sidebars and alternate sections |
| Surface/preview | `--bg-preview` | `#0a0a0b` | Video stage |
| Surface/elevated | `--bg-medium` | `#1e1e21` | Menus, controls, cards, modals |
| Surface/interactive | `--bg-light` | `#222226` | Hovered and selected controls |
| Text/primary | `--text-primary` | `rgba(255,255,255,0.9)` | Headings and essential content |
| Text/secondary | `--text-secondary` | `rgba(255,255,255,0.56)` | Body copy and labels |
| Text/muted | `--text-muted` | `rgba(255,255,255,0.34)` | Metadata and disabled states |
| Border/default | `--border-default` | `rgba(255,255,255,0.10)` | Structural separation |
| Border/subtle | `--border-subtle` | `rgba(255,255,255,0.06)` | Low-emphasis separation |
| Accent/primary | `--teal` | `#5dcaa5` | Links, focus, ready and active states |
| Accent/subtle | `--teal-bg` | `rgba(29,158,117,0.12)` | Selected and status backgrounds |
| Status/recording | `--coral` | `#f0997b` | Recording and destructive emphasis |
| Status/error | `--color-danger` | `#ef4444` | Errors only |
| Status/warning | `--color-warning` | `#f59e0b` | Warnings only |
| Docs/primary | `--primary` | `#6366f1` | Documentation links, metrics, and gradient start |
| Docs/secondary | `--secondary` | `#8b5cf6` | Documentation gradient end |
| Docs/background | `--bg-dark` | `#0f172a` | Documentation page background |
| Docs/surface | `--bg-medium` | `#1e293b` | Documentation header and elevated surfaces |
| Docs/alternate | `--bg-alt` | `#1a1f2e` | Alternate documentation sections |
| Docs/text | `--text-primary` | `#f1f5f9` | Documentation primary text |
| Docs/text muted | `--text-secondary` | `#cbd5e1` | Documentation body copy |

### Rules

- The Electron app keeps its teal, coral, and purple status language.
- The documentation keeps its existing indigo-to-violet gradients and translucent sticky header.
- New colors must first be assigned a semantic role in this table.

## 3. Typography

### Scale

| Level | Size | Weight | Line height | Tracking | Usage |
|---|---:|---:|---:|---:|---|
| Display | `3.5rem` | 700 | 1.2 | `0` | Documentation hero |
| H1 | `2rem` | 650 | 1.15 | `-0.025em` | Page title |
| H2 | `1.5rem` | 650 | 1.25 | `-0.015em` | Section title |
| H3 | `1.125rem` | 600 | 1.35 | `-0.01em` | Component title |
| Body/lg | `1.125rem` | 400 | 1.7 | `0` | Lead copy |
| Body | `1rem` | 400 | 1.65 | `0` | Documentation copy |
| UI | `0.8125rem` | 400 | 1.4 | `0` | Desktop app controls |
| Caption | `0.75rem` | 500 | 1.4 | `0.02em` | Metadata and labels |
| Overline | `0.6875rem` | 600 | 1.3 | `0.08em` | Compact section labels |

### Font Stack

- Primary: `"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`
- Mono/data: `"SFMono-Regular", Consolas, "Liberation Mono", monospace`

### Rules

- Preserve the existing Korean line breaks and wrapping behavior during maintenance work.
- Timers, percentages, dates, and versions use tabular figures.
- The desktop UI stays compact but never renders essential labels below the Caption size.

## 4. Spacing & Layout

### Base Unit

All authored spacing derives from a 4px base.

| Token | Value | Usage |
|---|---:|---|
| `--space-1` | `4px` | Icon-to-label |
| `--space-2` | `8px` | Compact controls |
| `--space-3` | `12px` | Form padding |
| `--space-4` | `16px` | Standard inset |
| `--space-5` | `20px` | Comfortable inset |
| `--space-6` | `24px` | Card or group inset |
| `--space-8` | `32px` | Related section gap |
| `--space-10` | `40px` | Major group gap |
| `--space-12` | `48px` | Section separation |
| `--space-16` | `64px` | Page rhythm |
| `--space-20` | `80px` | Hero rhythm |

### Grid

- Documentation content width: `1200px`; prose width: `65ch`.
- Documentation gutters: `20px`; content is centered within `1200px`.
- Documentation responsive breakpoint: `768px`; the existing rules below it are part of the frozen contract.
- Desktop app shell: top bar and status bar stay fixed; the preview and sidebar share the only flexible row. The sidebar owns its internal overflow.
- Documentation: the document owns vertical scrolling; the existing card grids and responsive collapse behavior remain unchanged.

## 5. Components

### App shell

- **Structure**: top bar / preview with sidebar / status bar.
- **Variants**: sidebar expanded or collapsed; comparison view.
- **States**: loading, ready, recording, disconnected, error.
- **Accessibility**: preserve the current control semantics in cleanup; semantic redesign belongs to a separately approved task.
- **Motion**: state changes use opacity or transform only; status pulses are limited to live loading or recording feedback.
- **Layout**: bounded `scroll-body-shell`; preview is fluid and sidebar is fixed-width.

### Control button

- **Variants**: default, icon, active, recording, destructive.
- **Spacing**: `--space-2` and `--space-3`.
- **States**: default, hover, active, focus-visible, disabled.
- **Accessibility**: button semantics and a visible teal focus outline.
- **Motion**: micro transition; pressed feedback uses transform.

### Panel and field group

- **Structure**: semantic heading plus body; labels explicitly bind to inputs.
- **Variants**: compact sidebar panel, modal fieldset, documentation section.
- **States**: default, selected, empty, error.
- **Layout**: stack with a single named overflow owner.

### Documentation header

- **Structure**: product mark, primary navigation, mobile menu button.
- **States**: default, current section, hover, focus, mobile expanded.
- **Accessibility**: preserve the current navigation markup and interaction contract during cleanup.
- **Motion**: navigation state uses color and opacity; the mobile icon transforms only when the menu changes state.

### Documentation content rows

- **Structure**: centered headings followed by the existing comparison table, feature cards, progress cards, release card, download cards, and team cards.
- **Variants**: comparison, feature, progress, release, download, and team sections.
- **States**: ready, complete, unavailable, loading, error.
- **Accessibility**: headings remain hierarchical; progress exposes text in addition to color.
- **Layout**: preserve the current centered grid and table geometry at every breakpoint.

## 6. Motion & Interaction

| Type | Duration | Easing | Usage |
|---|---:|---|---|
| Micro | `150ms` | `ease` | Electron control feedback |
| Standard | `300ms` | `ease` | Documentation navigation, cards, and header |
| Status | `1.5s` | `ease-in-out` | Loading or recording pulse only |

- Motion must communicate an interaction or live state.
- Animate only `transform`, `opacity`, `filter`, or color paint properties.
- Reduced-motion support is desired but must be introduced only in a separately approved, visually verified change.

## 7. Depth & Surface

The depth strategy is **mixed tonal shift, structural borders, and the existing documentation shadows and gradients**.

- App frame and documentation sections separate through surface tone.
- One-pixel borders mark controls, menus, and modal boundaries.
- Electron shadows remain concentrated on overlays and menus; documentation cards retain their current shadows and hover elevation.
- Border radii step down with hierarchy: `10px` modal, `6px` panel or menu, `4px` control, circular only for true indicators.

## 8. Accessibility Constraints & Accepted Debt

### Constraints

- WCAG 2.2 AA remains the target for future explicitly approved design work.
- Cleanup work must not claim accessibility improvements that require changing markup, focus styling, icons, motion, or layout.
- Existing keyboard behavior, icon treatment, touch targets, Korean wrapping, and motion remain part of the current visual contract.

### Accepted Debt

| Item | Location | Why accepted | Owner / Exit |
|---|---|---|---|
| Existing documentation camera mark and current responsive wrapping are frozen during cleanup | `docs/index.html`, `docs/styles.css` | The user explicitly prohibited design changes | Review only in a separately requested design task |
| Current semantics, focus treatment, and reduced-motion behavior are unchanged | Electron and documentation UI | Fixing them could alter the visual or interaction design | Address only with explicit approval and before/after visual evidence |
| Real camera, microphone, GPU, and Raspberry Pi states require hardware | Electron runtime | Static browser QA cannot produce these devices | Verify during the next hardware integration session |
| Update modal IDs are referenced but absent, so manual update UI is currently a guarded no-op | `renderer/updates.js`, app HTML | Pre-existing behavior outside this cleanup's source scope | Restore or remove the feature in a dedicated updater task |
