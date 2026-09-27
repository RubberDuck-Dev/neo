# Upstream alignment

Ported all changes since the common ancestor `5b610129` through hughhowey/neo
main `ffbfefc7164a3d9edfcccecc208ff3d5903522c0` (2026-09-27).
The desktop version now matches upstream 0.8.3.

Upstream's app.js changes live in the corresponding renderer modules here:

- Author drag targets, undoing author moves, and reshelving: 01-bookshelf.js.
  These reuse the existing ownership operation and retain safe shelf deletion.
- Deleted-chapter save cancellation: 05-poetry.js and the existing guarded saving service.
- Chapter drag lifecycle and keeping navigation open: 07-nav-pane.js.
- Enter-at-start insertion and smart punctuation in Notes: 09-outline.js.
- Typewriter keyboard tracking and menu state: 18-read-aloud.js, main.js, preload.js.
- Paragraph/sentence/off focus with Ctrl/Cmd+Shift+O: features/focus.js.
- Markdown and HTML metadata escaping: 24-export.js.
- Google Docs Title/tab imports: main.js; multilingual chapter detection is retained.
- Font consistency, alignment and text-size shortcuts: styles.css and main.js.
- Popup dismissal: the shared settings dialog behavior; Cancel still discards drafts.
- Pocket iOS shell, LibraryHome/iCloud bridge, assets, entitlements, dependencies,
  and build instructions: pocket/. Shared assets remain the modular renderer,
  plugins, shared utilities and locales rather than upstream's app.js.

Read Aloud uses Ctrl/Cmd+Alt+R to avoid upstream's Ctrl/Cmd+Shift+R right-alignment
shortcut. Existing boolean focus preferences migrate to paragraph mode.
Linux keeps the previously implemented NEO-Library default and legacy path support.

Native iOS builds/signing require macOS and Xcode. Windows tests cover the shared
renderer and mocked Capacitor file/iCloud bridge, not device signing or iCloud sync.
