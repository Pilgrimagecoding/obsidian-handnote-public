## HandNote 0.12.4 — sharper Markdown annotations and full-note exports

0.12.4 is available from **Settings → Community plugins → Check for updates**.

This update brings the Markdown annotation improvements together with the latest import, export and interface upgrades:

- **Sharper zoom on iPad:** enlarged Markdown text, handwriting and embedded HandNote previews stay clear. Embeds now use SVG for ink, text and shapes. Scanned document backgrounds retain their original image detail.
- **Export Markdown and ink together** as PDF, PNG or SVG. The export preserves native text spacing, removes extra blank trailing sheets and keeps page sizes consistent. Long notes become a multi-page PDF or an ordered PNG/SVG ZIP; Markdown SVG wraps a high-resolution composite image.
- **Better notebook export:** choose the current page or whole notebook, then save to the device or vault. Higher-quality output, vector handwriting in PDF, improved memory handling and clear save/cancel/share feedback.
- **Automatic annotation mode:** Markdown notes with existing ink or annotation objects open in annotation mode in editing view. After manually leaving it, that tab stays in normal editing until you open another note there.
- **Simpler controls:** the More menu stays below the three dots. The Done button is removed; leave through **More → Exit HandNote annotations** or the title-bar HandNote icon.
- **Annotations beside the Markdown:** `Note.md.handnote` lives beside `Note.md` and follows note/folder renames. Existing annotation locations remain compatible; the Markdown text stays unchanged.
- **Single-file imports:** new imports keep the original document bytes and annotations in one `.handnote`, avoiding a separate imports-folder copy. Large-PDF storage and mobile file compatibility are improved; older notes remain readable.
- **One interface language:** select Chinese or English globally in HandNote settings. Import/export actions have distinct icons, diagnostics are grouped away, and All pages / Bookmarks filters show counts.

Please update HandNote on every device before opening newly packaged imports. Older source documents are not automatically deleted, and sync services may still upload the whole package. Layout-preserving export tiles can split a text line or image at a page boundary.

[Full release notes and downloads](https://github.com/Pilgrimagecoding/obsidian-handnote-public/releases/tag/0.12.4)

Thanks to everyone who reported issues and tested on iPad and desktop.
