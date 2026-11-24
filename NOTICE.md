# Notice

This repository is a **modified version of [LearnHarness](https://github.com/amosblomqvist/learnharness)**,
created by **Amos Blomqvist** ([@amosblomqvist](https://github.com/amosblomqvist)) and the LearnHarness contributors.

- **Original project:** https://github.com/amosblomqvist/learnharness (website: https://learnharness.ai)
- **Based on:** release `v0.7.0` (commit `0292b85bcce080cc685f85d174a8cb2cc553a0ad`). The full upstream git history,
  with its authors, is kept in this repository.
- **License:** GNU Affero General Public License v3.0 only (AGPL-3.0-only), the same as the original. See [LICENSE](LICENSE).
  Third-party licenses that ship with the original are kept where they were.

This is an independent personal fork. It is not made, endorsed or supported by Amos Blomqvist or the LearnHarness
project. Please don't report problems with this fork to them.

## Changes in this version

Modified by Parth Takkar ([@p42rthicle](https://github.com/p42rthicle)), from 24 November 2026:

| Date | Change |
| --- | --- |
| 2026-11-24 | Added the **Semester** plugin in [`plugins/semester/`](plugins/semester/): questions across a semester's classes with page citations, Moodle deadlines, class tutors. Copyright (C) 2026 Parth Takkar, AGPL-3.0-only. |
| 2026-11-24 | Added this notice and the fork note at the top of the README. |
| 2026-11-24 | The desktop app is called **Lernwerk** here, with its own bundle ID and profile folder (`electron/product.cjs`, `electron-builder.lernwerk.yml`, `scripts/build-lernwerk.sh`, `npm run lernwerk:build`). The in-app updater is off (`electron/main.cjs`, with a test). |

Everything else is the original LearnHarness 0.7.0 code, copyright (C) its authors.
