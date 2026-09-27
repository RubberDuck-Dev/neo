# NEO

**A distraction-free word processor for authors, by a wannabe author.**

NEO understands from the moment you install it that you are writing *books* and nothing else. No bloat, no distractions, with manuscripts that look like books as you write them.

NEO runs locally. WIPs are saved in plain files on your disk. No accounts or subscriptions. And it's free!

## Download

Get the latest installer from the **[Releases page](../../releases)**:

- **macOS** — download the `.dmg` for older Intel machines or the arm64 file for Mac silicon. Open it and drag NEO to Applications.
- **Windows** — download the `.exe` and run it. Or get the setup installer and run that.

- **Linux** — download the `.AppImage`, make it executable with `chmod +x NEO-*.AppImage`, then run `./NEO-*.AppImage`. If the system reports an Electron sandbox startup error, upstream documents `--no-sandbox` as a workaround. New Linux libraries use `~/Documents/NEO-Library`; existing library paths are preserved.

## Why NEO?

**The bookshelf** 

Your library looks like a bookshelf, not a file list. Labeled shelves you organize however you like — by series, by status, by pen name. Progress bars on the covers show how far you are from your word goals. You can drag-and-drop books anywhere. Drag a book to the author name to move it to another pen name; Esc or Ctrl/Cmd+Z can undo that move for 15 seconds. File → Reshelve a Book finds books still on disk but no longer on a shelf. You can also drag shelves around and put cover art on your titles. Use a shelf’s ⋯ menu to delete it while keeping its books; right-click a book and choose “Move to another author…” to change its pen name.

**Search every book**

On the bookshelf, ⌘F (or the Search button) searches all your manuscripts at once. Handy for series continuity: what colour were her eyes in book one? Click a result and NEO opens that book with Find already on the match.

**Just a blank page** 

There's a white page by default or a dark mode (which I now prefer!). Controls fade until you mouse over them. Chapters number and renumber themselves automatically. Drop caps mark chapter openings, because I'm a sucker for drop-caps. Em dashes, true ellipses, and curly quotes sort themselves out as you type. Spellcheck exists only when you invoke it — no more red squiggles mid-sentence triggering your imposter syndrome.

**Revision pass**

When you're editing, not drafting: Edit → Revision Pass (⌘⇧;) marks echoes (the same word again within a few lines), filler words, -ly adverbs, and names spelled differently from how you usually spell them. Right-click a mark to see why it's there. Esc puts it all away. Nothing shows until you ask.

**Read aloud**

Hearing your prose catches clunky rhythm and missing words that your eyes skip. Edit → Read Aloud (⌘⌥R) reads from the caret to the end of the chapter, or just the selection, in your computer's own voice, and lights up each sentence as it goes. Any key stops it. Pick the voice and speed in Edit → Read Aloud Settings.

**Focus mode**

View → Focus Mode (⌘⇧O / Ctrl+Shift+O) cycles paragraph, sentence, and off. Focus follows the caret as you click or use the arrow keys. Off by default; NEO remembers your choice.

**Enter, Enter, Enter** 

One Enter: new paragraph. Two: a `***` section break. Three: a new chapter. The goal is to KEEP WRITING.

**Darlings** 

The writing advice is "kill your darlings" — but I say: *keep the bodies*. Drag any beautiful-but-in-the-way passage onto the Darlings tab. It leaves your manuscript but isn't lost. Darlings restore to the exact spot it came from. More like zombies than darlings.

**Placeholders** 

Mid-flow and need a name, a fact, a date? ⌘⇧X drops a mark and a sticky note. The left panel shows a red dot on every chapter that you need to get back to. The right panel will list all these to-do items.

**Chapter status**

Right-click a chapter in the chapter list to mark it Draft, Revised or Done. A small mark sits beside the word count, and the list's heading keeps score ("3 of 12 done"). Handy in revision; invisible if you never use it.

**Outlining for plotters** 

Outline chapters and sections in the Outline tab; section notes appear in the manuscript as gray ghost paragraphs, ready to be overwritten. Pantsers can ignore all of it or learn to draw a freakin' map for the first time. Try it. You might like it!

**Cover Art** 

Every book gets a cover! New books are dressed in a seeded abstract (six art styles, six type templates, typefaces bundled with NEO) so no two stories on the shelf look alike. Once a story passes 1,000 words, NEO can read it and paint an abstract cover from the text. This is a bit more work but totally worth it. Get an OpenAI API key from their website and paste it into File → Cover Art. The art is generated in the background for about a penny a picture. (These are not meant for publication, just writing inspiration!) The API key is stored encrypted in NEO's own settings, never in your library folder. The title and author are always set in real type on top, so the lettering is never left to a gen-AI model. The ↻ on any book re-rolls its type and colors, or paints it again. And you can always switch back and forth from the seeded modern look to the painted variety.

**Goals and momentum** 

Daily word goals and a NaNoWriMo-style progress chart. Want to race the clock? Enable Writing Sprints from ✦ Plugins: a timer or word-count sprint takes over the word counter until it's done.

**Exports** 

EPUB 3 with a proper table of contents built to KDP's guidelines, Word .docx, PDF, HTML, markdown, and plain text. File → Publishing Details… keeps two tabs per pen name. Manuscript holds your submission contact details. End Matter holds an Also By list, About the Author and a copyright page, written once; they're added to the back of every export of that author's books (never to the manuscript itself), and any book can opt out. Submitting to agents or magazines? File → Export → Manuscript Format builds a standard-submission .docx (Times New Roman, double spaced, contact block, rounded word count, running header). Your contact details (Publishing Details → Manuscript) are saved on this computer only. Email a timestamped PDF snapshot to yourself with a SHA-256 fingerprint of the text in the body. Might come in handy someday.

**Import** 

Bring in existing .docx, .txt, and .md manuscripts; chapters and scene breaks are detected automatically. This is still a bit rough and might require you to tweak things. It will try to grab your title and remove that from the body, and it seems to be working okay.

**Backups** 

Continuous autosave, daily zip backups kept for two weeks, everything stored as plain files. Set up your NEO library folder on your iCloud if you want for extra safety. You can also email copies of your WIP to yourself with a keystroke: ⌘E.

**Version history**

Optional local checkpoints preserve complete book states while you write. Browse them from File → Saving & Recovery; Compare shows exactly what changed since any version, chapter by chapter, before you decide to restore it. Enable GitHub backup in ✦ Plugins, then use the GitHub backup tab in File → Saving & Recovery (or its Plugin Library settings) to connect an empty GitHub repository for the entire NEO Library. NEO creates its local history automatically, and you can opt into background GitHub backups after each version. NEO never creates a public repository. New computer? "Set up this computer from a backup…" in GitHub backup settings downloads the library and picks up the backups where they left off; anything already on that computer is set aside, not deleted.

Spellcheck uses bundled offline dictionaries, loaded only when needed. Choose a book’s manuscript language in File → Book Settings; it controls export metadata independently of the spellcheck dictionary. Revision Pass currently supports English manuscripts.

## Your files

New Linux libraries live in `~/Documents/NEO-Library`; macOS and Windows default to `~/Documents/NEO Library`. Existing libraries keep their locations — one folder per book, chapters as readable HTML, metadata as JSON. Open them in your favorite text editor. To keep it somewhere else (a sync folder, an external drive), use File → Library Folder…. Select the exact empty directory you want, with any name (spaces are optional), or select an existing NEO library. NEO copies your library there and leaves the original untouched.

## Building from source (for the eggheads):

Requires [Node.js](https://nodejs.org).

```
git clone https://github.com/hughhowey/neo.git
cd neo
npm install
npm start
```

For development with automatic reloads, use `npm run dev` instead. Changes to
the renderer reload the app window; changes to Electron's main or preload code
restart the app automatically.

To build installers: `npm install electron-builder --save-dev`, then `npm run package` (macOS), `npm run package:win` (Windows), or `npm run package:all`. Output lands in `dist/`.

The app uses an Electron shell (`main.js`), focused services in `main/`, a preload bridge (`preload.js`), and a plain-JavaScript renderer. Bundled optional tools live in `plugins/`, each with its own implementation and styles. `renderer/plugin-host/` connects them to the writing room and presents the Plugin Library. Shared text rules and language metadata live in `shared/`. See [CONTRIBUTING.md](CONTRIBUTING.md) for the boundaries and how to add a plugin.

## Roadmap (things I'm dreaming up but may never get to):

Chapter version history · manuscript format for agent submissions (Times New Roman, double-spaced, address block, just to make Kristin Nelson happy) · global end matter that updates every book at once (same for copyright pages, bios, etc).

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Fair warning: NEO is opinionated by design, and bloat killed every writing app I've ever tried. If you want complex, try Scrivener. It really is a great application beloved by many! There are so many wonderful writing apps out there! Nobody needs to use this but me.

## License

[MIT](LICENSE) — free to use, free to modify, free to share.

## Philosophy

If you didn't know, I opened up the Silo universe to fan fiction years ago. And not just to put on fan fiction sites, but you can charge money for the things you write and keep every penny of the income! Lots of incredible Silo Stories out there. But readers are forever looking for more.
