# Docs stylesheet validation

Scope: `docs/styles.css` only. `omo ulw-loop status --json` was unavailable (`omo` is not installed), so evidence is recorded under `.omo/evidence/`.

## Behavior lock

No project test harness exists (`npm test` is a placeholder failure), and this is presentation-only CSS. The observable contract was locked through the current `docs/index.html` and `docs/script.js`: script-targeted classes remain present in markup and stylesheet, and `node --check docs/script.js` exits `0`.

## Cleanup

- Deleted the copied legacy stylesheet, including purple gradients, shimmer/fade animation, decorative hover elevation, duplicated rules, and section-divider comments.
- Replaced it with the `DESIGN.md` charcoal, teal, coral, spacing, typography, border, and radius tokens.
- Reworked cards into left-led feature rows and intrinsic two-column layouts that collapse to one column at the compact breakpoint.
- Added visible focus states, skip-link reveal styling, motion reduction, and compact overflow-safe tracks.
- CSS overrides the legacy script's inline card transforms so its mouse handlers cannot recreate decorative motion.

## Invocations and binary observables

- CSS parse / selector / legacy-marker / whitespace scenario:
  `powershell -Command "... css braces; node --check docs/script.js; selector reference checks; git diff --check ..."`
  -> `PASS css_braces=109/109 script_parse=0 script_selectors=feature-card,header,nav,progress-fill unused_root_selectors=0 decorative_markers=0 diff_check=0`.
- Responsive render scenario:
  `chrome.exe --headless ... --screenshot=<artifact> file:///C:/SpotlightCam/Graduation_Project/docs/index.html`
  -> artifacts written at all requested widths.
  The 375px render uses a 750px headless window at scale factor 2 to emulate a 375 CSS-pixel viewport.

## Captured artifacts

- `docs-375.png` (105896 bytes): compact one-column document, no visible horizontal clipping.
- `docs-768.png` (20880 bytes): tablet document.
- `docs-1280.png` (22041 bytes): wide document.
- `chrome-375.log`, `chrome-768.log`, `chrome-1280.log`: Chrome's write confirmations.

## Gates

- Regression / unit tests: N/A. The package defines no executable test suite and no tests are appropriate for presentation-only CSS.
- Lint / LSP: N/A. Biome is not installed and its installation was previously declined.
- Static/security scan: N/A. No configured scanner for a standalone CSS file.
- Manual QA: PASS. Chrome headless captures were inspected at 375, 768, and 1280 CSS-pixel viewports.
