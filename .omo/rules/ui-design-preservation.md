---
description: Preserve the existing UI design and local design artifacts
alwaysApply: true
---

# UI design preservation

- Keep `DESIGN.md` and `.omo/` listed in the repository root `.gitignore`.
- Treat the currently rendered Electron app UI and `docs/index.html` as the visual contract.
- UI-related cleanup, refactoring, and maintenance must preserve visible copy, colors, typography, spacing, layout, icons, motion, responsive behavior, and interaction states.
- Change the visual design only when the user explicitly requests a design change.
- Before finishing UI-related work, compare the result with the pre-change design contract. If a visual difference was introduced, restore the original design and redo the code change without that difference.
