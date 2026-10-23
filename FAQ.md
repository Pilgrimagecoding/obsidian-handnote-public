# FAQ

### Where are my notes stored? Can I sync them?

Each note is a `.handnote` file in your vault (JSON text). Obsidian Sync, iCloud, Remotely Save,
OneDrive, Git — whatever syncs your vault syncs your notes. HandNote checks the file before every
save. If another device changed it in the meantime, that version is kept as a
`(conflict …).handnote` copy instead of being overwritten.

### What happens if the app is closed in the middle of writing?

Unsaved strokes go to a small recovery journal in the plugin folder about 0.4 s after you write. When
you open the note again, HandNote offers to restore them.

### A note says it is damaged / read-only. What now?

- **Damaged** (for example a sync that was cut off): HandNote shows what it could recover,
  read-only, and never writes the damaged file. Use **Save recovered copy** to keep the recovered
  strokes as a new note. An earlier version may also be in
  `<vault>/.obsidian/plugins/handnote/backups/`.
- **Read-only because it was made with a newer HandNote**: update HandNote on this device.

### How do I back up or export my notes?

- **Back up:** your notes are the `.handnote` files in your vault, so any backup of the vault
  (Obsidian Sync version history, Time Machine, a copy of the folder, Git) includes them.
- **Export:** command palette → "HandNote: Export current page as PNG" (or SVG), or the page menu in the page sidebar.
- The recovery journal and the automatic backups in `<vault>/.obsidian/plugins/handnote/` are a
  safety net on this device: most sync tools skip them, and they are removed when you uninstall
  HandNote. Do not rely on them as your backup.

### Do I need an account, an API key or a subscription?

No. Writing, the lasso, on-device text recognition and typing formulas as LaTeX need nothing. MyScript and the AI
tools are optional and use **your own** keys with the provider's own pricing.

### How large is the model download? Can I delete it?

15.8 MB (Chinese) or 7.5 MB (English); the runtime is built into the plugin. The
optional hand font is 12.1 MB and is loaded per character. Settings → HandNote → Local recognition
shows the size before downloading and has a Delete button for every pack. Models are stored per
device in the app's storage, not in your vault. They stay there when you uninstall or reinstall
HandNote (a reinstall uses them again without a download); delete them first if you want the space
back.

### Why does Convert → Math not recognise my formula on the device?

This version has no on-device math recognition: no handwritten-math model with clear licence terms
is included yet. Convert → Math opens the LaTeX editor instead (live preview; keep the ink beside the
formula or replace it), or uses MyScript if you entered your own MyScript keys. Formulas in your
notes — also ones made with other HandNote builds — open, edit, move, resize, copy and export
normally.

### Local recognition says it needs iPadOS 16.4.

The built-in runtime needs iPadOS / iOS 16.4 or newer. On older systems HandNote does not download a
runtime instead: update the system, or choose MyScript as the recognition engine.

### The download is slow or never finishes.

Run **Settings → Local recognition → Run self-test**. The "Download mirrors" line shows which
servers your network reaches. HandNote tries the fastest one first. If none is reachable, download
the files on a computer (see the pack list in `THIRD_PARTY_NOTICES.md`) and use **Import files**:
they are accepted only if their SHA-256 matches.

Right after updating HandNote, the settings may say the storage is held by the previous version.
Quit Obsidian completely (on iPad, swipe it away) and open it again. Nothing has to be downloaded
again.

### Does recognition work offline?

Yes, once the packs are downloaded. MyScript and AI providers need a connection.

### English (or my handwriting) is recognised poorly.

- Install the English pack: lines written in Latin script use it automatically.
- Write a little larger.
- Tap an uncertain (dashed) character for alternatives. Nothing is replaced without your choice
  when the engine is unsure.

### Can I select part of a converted text?

Yes. A lasso loop around some characters selects just those. The text is split only when you move,
recolour or delete them. Grouped pieces are edited as one text with the text tool.

### Which documents can I import, and where do the files go?

PDF, Word (.docx, .doc), PowerPoint (.pptx) and Excel (.xlsx): **Import document…** or right-click
a file → **Annotate in HandNote**. A file picked from the device is copied once into the folder
`HandNote imports` (Settings → HandNote → Imported documents; empty = Obsidian's attachment
location); a file that is already in the vault is used where it is. The original is never modified,
and importing the same file again does not copy it twice. Deleting a note does not delete the
original.

### An imported Word / PowerPoint / Excel page looks different from Office.

HandNote lays the file out itself, without Office, so page breaks, fonts and line breaks can differ a
little. Charts, SmartArt, animations, headers / footers and footnotes are not shown; the import
lists what was left out. Excel formulas show the value saved in the file (HandNote does not
recalculate). Old .ppt / .xls, Pages / Keynote / Numbers and password-protected files are refused
with a reason: save them as .pptx / .xlsx or PDF.

### What is the `.handnote-layout.json` file next to my document?

The fixed layout HandNote computed when you imported a Word, PowerPoint or Excel file (compressed
as `.json.gz` when large). It makes every device show exactly the same pages. Let your sync tool
sync it; if it is missing, HandNote lays the document out again and tells you.

### Does HandNote send my handwriting anywhere?

Not unless you set up MyScript or an AI provider, and then only the selection you convert, after a
confirmation. See [PRIVACY.md](PRIVACY.md).

### Does HandNote sync with Obsidian Sync?

Your notes (`.handnote` files) sync like any other file. The plugin itself: `main.js` is about
6.2 MB because the recognition runtime is built in, and Obsidian Sync's Standard plan does not sync
files over 5 MB. With that plan, install HandNote on each device from Community plugins.

### Does it work on iPhone or Android?

It contains nothing desktop-only, but phones are not tested and the toolbar is designed for tablets
and desktops.

### Is this an official MyScript / Goodnotes / Obsidian product?

No. HandNote is an independent community plugin.
