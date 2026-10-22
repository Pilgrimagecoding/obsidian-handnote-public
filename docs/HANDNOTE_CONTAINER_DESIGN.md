# Images inside the `.handnote` file — container design (v0.4)

User request (feedback 8): images inserted into a handwritten note should live **inside** the
`.handnote` file instead of as separate attachments.

## Options evaluated

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **A. base64 assets in the existing JSON (one asset per line)** | one file; stays valid JSON; the line-based recovery keeps working; no new dependency; Obsidian `vault.read/modify` text APIs and sync tools keep treating it as text | +33 % size for base64; a big image is one long line | **chosen** |
| B. ZIP container (`.handnote` = zip with `document.json` + `images/`) | compact; binary images | breaks every existing reader (v0.1–0.3 cannot even detect it); needs a zip library (none bundled, no runtime deps allowed); binary diffs/sync conflicts can no longer be salvaged line by line; partial writes corrupt the whole archive | rejected |
| C. Sidecar folder (`note.handnote` + `note.assets/`) | small JSON | not "inside the file"; moving/renaming the note must move the folder (Obsidian does not do that) | rejected |
| D. Keep vault attachments (v0.3) | smallest notes, images visible in the vault | what the user wants to avoid | kept as an option |

## Format (version 4)

- Image items reference an asset: `"src": "asset:<id>"`.
- After the pages, the file has an `"assets"` array, one asset per line:
  `{"id":"a…","mime":"image/png","w":800,"h":600,"data":"<base64>"}`.
- Only assets referenced by an item are written; an asset removed from every page disappears on
  the next save (undo during the same session still works because the editor keeps the asset in
  memory).
- Reading: `mime` must be png / jpeg / webp / gif, `data` must be base64 and ≤ 40 MB characters;
  anything else is skipped with a warning. Recovery of a damaged file recognizes asset lines.

## Size policy

New images are stored as-is when ≤ 2048 px on the long side and ≤ 3 MB; otherwise they are
downscaled to 2048 px and re-encoded (PNG, or JPEG 0.86 when the PNG would still exceed 3 MB).
WebP/GIF are re-encoded to PNG. The user sees a notice when an image was downscaled.

## Versioning, migration and rollback

- Files without embedded images keep their old version (1–3). Adding the first embedded image
  makes the file version 4; v0.3 opens version-4 files **read-only** and never overwrites them.
- **No silent batch conversion.** Existing attachment images are never converted automatically.
  The command *"Embed attachment images into the current handwritten note"* converts **only the
  open note**, as **one undo step**, and leaves the attachment files in the vault (nothing is
  deleted).
- Rollback: change *Settings → Images → Store inserted images* to "As vault attachments" for new
  images. A note can be returned to the v0.3 layout by undoing the embed command in the same
  session, or by restoring the local backup HandNote makes before the first overwrite of a note in
  each session (plugin folder, not synced).
- Settings default: **inside the note** for new images (the user's request).

## Trade-offs to know

- A note with many large photos becomes large (base64); sync tools copy the whole file on every
  change. For photo-heavy notes the attachment mode is better.
- Obsidian search / graph does not see embedded images (they are not vault files).
