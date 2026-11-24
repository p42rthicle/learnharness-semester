# Semester (a LearnHarness plugin)

A plugin by Parth Takkar for [LearnHarness](https://github.com/amosblomqvist/learnharness) by Amos Blomqvist.
Copyright (C) 2026 Parth Takkar, AGPL-3.0-only (see the repository's LICENSE).

It is written for one student's semester at TU Darmstadt, so the class names are in the code. No course material is
included. The Moodle watcher (`Dashboard/watcher`) and the course index builder (`Dashboard/index`) it reads from are
separate, private tools and are not in this repository. Without them the sidebar says the index is missing, search
returns an error, and there is no Moodle data.

It is **macOS only** (Keychain, `open`, install path) and needs poppler's `pdftoppm` for page images. To use it for
another semester, change the class names in the code and set `root` in the plugin's `settings.json`.

**Runs by itself:** if `Dashboard/watcher/watch.mjs` exists under `root`, the plugin runs it with Node one minute after
LearnHarness starts and then whenever the last check is over 2 hours old (looked at every 10 minutes).

Adds a **Semester** button to LearnHarness's sidebar. It opens:

- **Home**
  - An Ask box with class chips.
  - Deadlines, unsubmitted first.
  - New per class: counts of new files and ★ worth-a-look links (details are on the class page).
  - A "Check Moodle now" button.
- **Questions and Classes** in the sidebar.
  - Questions can be about all classes or one class. A class chat only searches that class's files.
  - Each chat keeps its history, and you continue it any time.
  - Answers cite file + page as `[n]`. "Show page" displays the slide; "Teach me this" starts a LearnHarness lesson.
  - A citation the tools didn't actually return is marked unverified.

LearnHarness's own lessons (prober, teacher, practice) also get the course search tools and the graded-work rule.

## Questions here, learning in LearnHarness

- **Semester** is for questions: deadlines and submission status (Moodle), exam dates, contacts, which slide something is
  on, a plan for the week. Answers cite file and page. Question chats stay out of the knowledge graph unless you turn
  that on in Settings (they're looked up, not learned).
- **Learning** happens in LearnHarness sessions filed under `WiSe 26/27 › <class>` (Semester creates the folders).
  Any session in a class folder is that class's tutor: it searches only that class, gets `class_updates` (new files
  since it last looked; recap after a break), `class_progress` (every session's plan and what was taught, lectures,
  key dates, days to the exam) and `moodle_info`. Exam prep builds on `class_progress` instead of a new plan.
- Each class page shows the lessons with progress (topics taught), the exam countdown, and buttons that start a lesson
  already filed in the folder: Continue the course, Exam prep, Practice, A topic, Homework concepts.
- Lessons idle for 15 minutes get their knowledge-map extraction, so the map and Flashcards keep up.
- Key dates: add them on the class page, or export the TUCaN timetable (Stundenplan → Export, iCal) into
  `WiSe26-27/TUCaN/`; registered exams are in that export. Re-export after registering for exams.
- In a lesson, a pending check hides the message box: press **Esc** (no field focused) → **Dismiss** to talk freely.

## Who pays

- **Your Claude subscription first.** Chats run on LearnHarness's Claude Code connection (Settings → Providers → External CLI → Claude Code, on).
- **Only if that hits its usage limit**, the same question goes to the Anthropic API.
  - It uses the key in the Keychain (`wise-anthropic` / `api-key` + `workspace-id`).
  - It stops at the monthly cap in Semester settings (default $20).
  - Each API answer shows its cost.

## Graded work: topic yes, task no

- Graded files are searchable and readable, flagged `graded`.
- The model never solves, writes code for, checks or hints a graded task, even pasted. It explains the topic with different examples instead.

## Data

- **Course text:** `Dashboard/index/out-semester/index.json.gz`, built by `node Dashboard/index/build.mjs --semester`.
  - The watcher rebuilds it after new files.
  - It is never served over the network.
- **Home:** `Dashboard/watcher/feed.json`, written by the watcher.
- **Plugin data:** LearnHarness's `data/plugins/semester/data/`: `chats.json`, `settings.json`, `api-spend.json`, `tutors.json`, `dates.json`. Never in git.

## Build and install

```sh
npm install
npm test                     # offline: made-up course, fake LearnHarness host, mock Anthropic API
npm run build                # dist/
node scripts/install.mjs     # into ~/Library/Application Support/LearnHarness/data/plugins/semester/dist (data kept)
```

Then restart LearnHarness (0.7.0 or newer) and enable **Semester** in Settings → Community plugins.
