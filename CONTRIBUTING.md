# Contributing to NEO

Thanks for wanting to make NEO better. A few notes before you dive in.

## The philosophy

NEO exists because every writing app was eventually ruined by bloat. The bar for new features is not "would this be cool?" but "does this help a working author write, finish, and publish books?"

Good territory: bug fixes, performance, accessibility, better import/export precision, and platform polish (especially Windows and Linux, which I haven't tested much).

## How the code works

- `main.js` — Electron window/menu wiring and platform operations. `main/storage.js` owns atomic writes and the book write queue; `main/history.js` owns local checkpoints. Git work never holds up the save queue.
- `preload.js` — explicit desktop capabilities. Pocket implements the same bridge with a capability map; unavailable plugins are shown as unavailable.
- `renderer/` — the existing editor remains plain scripts loaded in order. Core owns manuscript state, undo, autosave, base tabs and goals.
- `renderer/plugin-host/` — the host, explicit context adapter, catalog and independent Library widget. The widget does not branch on plugin IDs.
- `plugins/<feature>/` — one private factory per bundled tool. Optional styles and main-process/worker files live beside it. Plugins receive operations and snapshots through the context adapter instead of mutating editor globals.
- `shared/` — pure text rules and dictionary metadata consumed by Node and browsers from the same source.
- `locales/` and `renderer/i18n.js` — interface text resources and fallback lookup. New Plugin Library labels use these resources; existing UI strings are migrated incrementally, not translated automatically. Manuscript language and dictionary language are separate.
- `renderer/features/revision/english.js` — English-specific revision rules. Keep language heuristics out of generic text helpers.
- `styles.css` — shared UI and editor styles; plugin styles live with their implementations.

### Adding or changing a bundled plugin

1. Create `plugins/<feature>/index.js`. Call `NeoPlugins.define(id, descriptor, context => api)` and keep implementation variables inside the factory. A descriptor supplies name, description, scope (`author` or `library`), and optional `requires`, `bookScoped`, `settings`, `bookFields` and `libraryFields`.
2. Add the folder to `renderer/plugin-host/catalog.js`, with the CSS flag if needed. Desktop and Pocket use this same catalog; do not edit both HTML files for each plugin.
3. Implement only needed hooks: `refresh`, `outline`, `tab`, `counter`, `settings`, `syncSettings`, `command`, `bookClosed`, and `dispose`. Register timers/listeners/UI once per activation. Remove timers in `dispose`; `context.listen`, `context.own`, and `context.addTab` clean up registered resources.
4. Use the context's save operations. Pending writes finish before book-scoped plugins are disposed. Disabling preserves metadata and JSON files. Keep unknown plugin IDs/data intact so another device or later version can use them.
5. Add behavior tests covering disable/re-enable, book/author changes, and saved-data retention. Any new platform capability must be explicit in preload and Pocket.

The catalog contains trusted bundled code, not downloadable third-party code. Enablement does not remove files from the installed app. Git backup and spellcheck are library-wide; palettes and writing tools are author-scoped. Git's old author flags migrate once without turning off existing backups.

Use small closure modules here to retain the no-build workflow and file-based browser tests. Main services use CommonJS. Do not add a bundler or general plugin framework just to move code between files.

Books are folders of plain files in the configured library directory (new Linux default: `~/Documents/NEO-Library`; legacy paths are preserved): `book.json` for metadata, `chapters/*.html` for text, JSON files for darlings/stickies.

## Ground rules

1. **Nothing interrupts a writer mid-sentence.** No popups, no squiggles, no notifications while typing.
2. **UI stays invisible until hovered.** 
3. **Words are never lost.** Any feature that removes text must route it somewhere recoverable.
4. **Plain files.** No databases, no proprietary formats. Future-proof, please!

## Practical bits

- Run from source: `npm install && npm start` (needs Node.js).
- Keep PRs focused — one feature or fix each.
- Describe the writer-facing behavior in your PR, not just the code. Think like an author, not a programmer!
- Bug reports: please include your OS, what you did, what happened, and the tail of `~/Documents/NEO Library/neo-errors.log` if it's a crash.

## Tests

`npm test` runs everything; `npm run test:main` and `npm run test:ui` run each half.

- `test/main/` loads `main.js` outside Electron with a stand-in `electron` module and a throwaway home folder. Git is pointed at a local bare repository instead of GitHub, so backup, restore and "someone else pushed first" can be tested without a network account.
- `test/renderer/` loads `index.html` in headless Chromium with an in-memory `window.neo`, and drives it like a writer: menu messages, clicks, typing. Run `npx playwright install chromium` once first; without it these tests skip.

GitHub runs both on every push and pull request (`.github/workflows/test.yml`). A change that alters what's saved, backed up or exported should come with a test.


### Integration checks

- `npm run test:spell-worker` exercises all seven dictionaries in Electron's actual utility process, including custom words and language changes.
- `npm run test:packaged-spell` builds a temporary ASAR fixture and repeats that check against packaged paths. Neither test opens the user's library or creates a window.
- The Pocket CI bundle and its renderer test copy `renderer/`, `plugins/`, `shared/`, and `locales/`. Update both if adding another shared source directory.

No runtime dependency was added for the plugin host. Dictionaries remain bundled (about 5.5 MiB combined); their parse cost is paid only on demand. UI translations and additional language heuristics can be added independently without duplicating word counting or persistence.

The September 2026 Windows headless renderer check used the same small mock library before and after this refactor. Warm load-to-bookshelf samples were 65 ms before and 75–78 ms after; retained JS heap was about 1.32 MB before and 1.34 MB after. These measure the renderer fixture, not Electron startup or large real libraries. Real Electron checks also loaded all seven dictionaries successfully from both loose files and ASAR, with no worker created until a spelling request.
