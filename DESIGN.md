---
# gstack: design-md-format=spec
name: QA NXT
description: A calm, dense evidence room where every number is a tagged exhibit you can open.
colors:
  primary: "#0b5efd"
  primary-dark: "#0847c4"
  primary-light: "#e8f0ff"
  on-primary: "#ffffff"
  surface: "#ffffff"
  surface-sunken: "#f6f8fb"
  text: "#101a2b"
  text-muted: "#5b6b82"
  text-subtle: "#667382"
  line: "#e2e8f2"
  line-strong: "#cbd5e3"
  success: "#117e55"
  success-light: "#e6f5ee"
  error: "#c02626"
  error-light: "#fdecec"
  warning: "#a06000"
  warning-light: "#fdf3e2"
  info: "#5a4bd6"
  info-light: "#eeecfd"
  tag: "#edf2f9"
  tag-edge: "#b9c6da"
  unbacked: "#9aa6b8"
  seal: "#13213d"
  on-seal: "#e8eef8"
  guilloche: "#d3dcea"
  hash: "#3d5a80"
typography:
  display:
    fontFamily: IBM Plex Sans
    fontWeight: 600
    fontSize: 1.625rem
    letterSpacing: 0em
  heading:
    fontFamily: IBM Plex Sans
    fontWeight: 600
    fontSize: 1.125rem
  body:
    fontFamily: IBM Plex Sans
    fontSize: 0.875rem
    lineHeight: 1.5
  table:
    fontFamily: IBM Plex Sans
    fontSize: 0.8125rem
    lineHeight: 1.45
  label:
    fontFamily: IBM Plex Sans
    fontWeight: 500
    fontSize: 0.75rem
    letterSpacing: 0em
  count:
    fontFamily: Martian Mono
    fontWeight: 500
    fontFeature: tnum
  docket:
    fontFamily: Martian Mono
    fontWeight: 600
    fontSize: 0.8125rem
    letterSpacing: 0.04em
  mono:
    fontFamily: IBM Plex Mono
    fontSize: 0.75rem
    fontFeature: tnum
rounded:
  xs: 2px
  sm: 4px
  md: 6px
  lg: 8px
  full: 9999px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  2xl: 40px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.md}"
  button-primary-hover:
    backgroundColor: "{colors.primary-dark}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    borderColor: "{colors.line-strong}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
  input:
    borderColor: "{colors.line-strong}"
    rounded: "{rounded.sm}"
  card:
    backgroundColor: "{colors.surface}"
    borderColor: "{colors.line}"
    rounded: "{rounded.lg}"
  custody-tag:
    backgroundColor: "{colors.tag}"
    borderColor: "{colors.tag-edge}"
    rounded: "{rounded.sm}"
  unbacked-count:
    borderColor: "{colors.unbacked}"
    textColor: "{colors.unbacked}"
    rounded: "{rounded.sm}"
  seal-band:
    backgroundColor: "{colors.seal}"
    textColor: "{colors.on-seal}"
  nav-link:
    textColor: "{colors.text}"
---

# QA NXT

## Overview

**Creative North Star:** an evidence room, not a dashboard: dense, calm instrument-panel UI where every count is a tagged exhibit that opens its proof, because the buyer is a QA lead who signs releases and must be able to defend each number to an auditor.
**Product context:** self-hosted autonomous web-app testing for QA leads at regulated companies (banks). Peers: TestRail, Xray, Qase, Allure, Currents. The console is a React + Tailwind app (apps/web-console).
**Mode per surface:** console pages: Operate. Signed sign-off pack: Read (a frozen record, printed and attached to change tickets).
**Reference sites:** none opened (web search only): browserstack.com/guide/test-management-tool-buyer-guide, webdesignhot.com/design.md/datadog, webdesignhot.com/design.md/linear.
**Key characteristics:**
- Proven numbers look different from unproven ones.
- Red appears only where something really failed.
- Tables first; nothing decorative.
- A signed pack visibly becomes a certified record.

## Colors

**Strategy:** Restrained plus semantic. Blue is for actions only; every other colour carries a fixed meaning: success = passed, error = a real failure or defect, warning = not run (always with a reason chip), info = healed or flaky, neutral grey = rejected or superseded.
**Light or dark:** light. The use scene is a bank office desk under daylight or fluorescent light, a projector in a release meeting, and a printed pack. A dark theme maps every token by role (see the preview) and keeps the same meanings; it is never the default.
Evidence tokens (tag, tag-edge, unbacked, seal, guilloche, hash) are reserved for evidence: never use them for decoration or layout. Destructive actions are ink-outlined buttons with a confirm, not red, so red stays a verdict.

## Typography

Three faces, all SIL OFL, bundled with `@fontsource` (no font CDN at runtime; bank networks block them):
- **IBM Plex Sans** for all UI and body text. Its engineering lineage fits an instrument for engineers; it is on the allowed list for Operate surfaces. It replaces the `Inter` declaration in tailwind.config.js, which never loaded (no @font-face, no package), so pages fell back to the system font.
- **Martian Mono 500, tabular figures** only for evidence-backed counts and the pack's docket line (600, uppercase). Its wide, stamped shapes make a count read as a label you can pick up.
- **IBM Plex Mono** for IDs, hashes, selectors, durations and timestamps.
Scale: 26 / 18 / 14 / 13 / 12px. Headings differ from body by size and weight, never weight alone.

## Layout

Max content width 1180px; 16px gutters; 4px spacing base. Tables are the primary layout: 13px rows, 9px vertical padding, row hover on surface-sunken. Breakpoints: ≥1024px full layout; 768–1023px metric rows wrap to two columns; <768px lists stack and the sign bar sticks to the bottom. Touch targets are at least 44px on narrow screens.

## Elevation & Depth

Depth comes from borders and the sunken surface, not shadows. Overlays (drawers, dialogs) use one offset shadow: 0 8px 24px rgba(16,26,43,0.12). No zero-offset glows.

## Shapes

Radii: 2px for the custody tag's punched edge, 4px for badges, chips and inputs, 6px for buttons, 8px for cards and panels. A nested element's radius is the outer radius minus the gap. No pills.

## Components

- **Custody tag** (evidence-backed count): tag ground, 1px tag-edge border with a dashed 2px left edge and a 4px punched hole; Martian Mono count plus a muted label. It is a link: hover sets the border to primary; focus-visible draws a 2px primary ring; click opens the evidence drawer.
- **Unbacked count:** dashed unbacked border, unbacked text, no tag. Any figure without evidence must use this, never a tag.
- **Evidence drawer:** right side panel, 300px; screenshot first, then trace, video and network files, then a custody line in Plex Mono (captured time, run, execution, hash).
- **Status badge:** 4px radius, light ground plus its colour. Not run always carries a reason chip (Plex Mono, warning outline). "Approved before review existed" is a dashed neutral outline.
- **Seal band** (signed pack only): seal ground, docket line, signer, time and content hash; enters with the one authored motion. The signed page adds the guilloche pattern and removes every control except Download.
- **Buttons:** primary (solid blue) once per view; secondary (outlined). Disabled at 45% opacity with aria-describedby pointing at the reason.

## Do's and Don'ts

- Do put every evidence-backed count in a custody tag and link it to its proof.
- Do show unproven figures as unbacked counts rather than hiding them.
- Do pair every "not run" with its reason chip.
- Do keep one primary button per view.
- Don't use red for anything but a failed test, failed check or defect, including destructive buttons.
- Don't use evidence tokens (tag, seal, guilloche) as decoration.
- Don't add a fourth typeface, gradients, pills, coloured card edges or nested cards.
- Don't show a percentage without its denominator nearby ("Ran 111 of 122").

## Motion

- **Approach:** minimal-functional.
- **Easing:** enter(ease-out) exit(ease-in) move(ease-in-out)
- **Duration:** micro(50-100ms) short(150-250ms) medium(250-400ms) long(400-700ms)
- **The one authored moment:** the seal band arriving when a pack is signed (200ms ease-out, 6px drop and fade); disabled under prefers-reduced-motion.

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-10-17 | Initial design system created | Created by /design-consultation from the sign-off engine design (docs/designs/qa-lead-sign-off-engine.md), web search of the QA-tool category and one independent Claude proposal ("Chain of Custody") |
| 2026-10-17 | IBM Plex Sans replaces the unloaded Inter declaration | Inter never loaded; Plex is allowed for Operate surfaces and bundles via @fontsource |
| 2026-10-17 | Red reserved for real failures; not run amber with reason; healed/flaky violet; rejected neutral | Design review D16 |
