# Recording guide — real iPad + Apple Pencil footage and mobile screenshots

The promo videos made so far use **desktop footage only** (Obsidian desktop, released HandNote
0.8.1, strokes played back by a script). Footage that shows an Apple Pencil, palm rejection or
finger gestures must be **recorded on a real iPad by the maintainer**. Nothing in this project
simulates an iPad or a Pencil.

## 1. Prepare the iPad (10 minutes)

1. Create a **new, empty vault** called `HandNote Demo` (do not use your real vault). Do not sign in
   to Obsidian Sync or any other sync for it.
2. Install HandNote **from Community plugins** (so it is the public 0.8.1, not a test build).
   Check Settings → HandNote shows version 0.8.1.
3. Settings → HandNote → Local recognition → download the Chinese pack (and the English pack if you
   write English).
4. Create the folders `Courses` and `Reading`, and a Markdown note `Courses/Linear Algebra.md` with:

   ```markdown
   Week 3 — eigenvalues and eigenvectors.

   - A vector v is an eigenvector of A when Av = λv.
   - The characteristic polynomial is det(A − λI) = 0.

   Handwritten notes from the lecture:

   ![[Lecture 3.handnote]]
   ```

5. iPad settings for recording: Do Not Disturb **on** (no notifications), battery icon above 50 %,
   Light appearance, Obsidian theme "Default", text size default. Close other apps.
6. Control Center → add **Screen Recording**. Long-press it: microphone **off**.

Privacy check before every take: the vault name, file list and tabs show only demo content; no
e-mail, account name, other vault, path or key is visible.

## 2. Shots to record (landscape, unless noted)

Record each shot as its own clip; 3 seconds of stillness before and after each one. Write at a
normal pace — the edit speeds up long writing.

| # | Shot | What to do | Length | Used in |
|---|---|---|---|---|
| P1 | Pencil writing, close-up (camera, optional) | film the Pencil writing "Lecture 3" on the iPad from above with a phone camera (good light, no reflections, no face, no other screen visible) | 8–10 s | main video opening, short video |
| P2 | Screen: new note | Courses folder → New HandNote, rename to "Lecture 3" | 8 s | main |
| P3 | Screen: writing with pressure | write "Lecture 3", highlight it, write "Eigenvalues" in blue, then two lines of Chinese and English; press harder and lighter to show pressure | 30–45 s | main, short |
| P4 | Screen: palm rejection | rest your palm on the screen while writing one line | 8 s | main |
| P5 | Screen: finger gestures | one-finger pan, pinch zoom, two-finger tap undo, three-finger tap redo | 10 s | main |
| P6 | Screen: lasso → Convert → Text | circle a handwritten Chinese word, Convert → Text, tap a candidate, then Restore ink and convert again | 15 s | main, short |
| P7 | Screen: formula | circle a handwritten equation, Convert → Math → type the LaTeX (on-screen keyboard is fine), Replace | 20 s | main |
| P8 | Screen: pages | Pages → Add page → More → Change template → Grid → Apply; write a word | 15 s | main |
| P9 | Screen: Markdown embed | open `Linear Algebra.md`, scroll to the embedded page | 8 s | main, short |
| P10 | Portrait screen (iPad rotated) | short version of P3 + P6 in portrait | 20 s | short video (9:16) |

Do **not** record: on-device math recognition (not in the public version), AI mind maps or
flowcharts (need a paid provider key), any MyScript account screen.

## 3. Hand-over

- Files: the original `.mov` / `.mp4` from Photos (AirDrop or Files → "Keep originals"), not a
  screen recording of a screen recording.
- Put them in a folder named `ipad-footage/` **outside** the Git repositories (for example
  `handnote-video/ipad-footage/` next to your repositories), named `P1.mov`, `P3.mov`, …
- Send a note with: iPad model, iPadOS version, Obsidian version, HandNote version shown in
  Settings.

The edit then replaces the desktop playback shots with the iPad shots, removes the "desktop
playback" disclosure for those parts, and keeps the same captions.

## 4. Mobile screenshots for the directory listing (900 × 1600)

Take screenshots on the iPad in **portrait** (Top button + Volume up), same demo vault:

| # | Screen |
|---|---|
| M1 | Lecture 3 page with the pen toolbar open |
| M2 | Lasso around Chinese handwriting with the Convert → Text result and candidates |
| M3 | The LaTeX formula editor with preview |
| M4 | Pages sidebar with three pages (ruled, grid, dots) |
| M5 | `Linear Algebra.md` with the embedded page |

iPad portrait screenshots are 3:4 (for example 1640 × 2360); the listing wants 900 × 1600 (9:16).
Send the originals; they will be fitted onto a 900 × 1600 canvas **without cropping or retouching
the app's content** (paper-coloured margin, no fake device frame).
