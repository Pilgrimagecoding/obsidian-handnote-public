# Security policy

## Reporting a vulnerability

Please report security problems **privately** through GitHub: open the repository's **Security**
tab → **Report a vulnerability** (private vulnerability reporting). Do not open a public issue for a
security problem, and do not include real notes, keys or personal handwriting in a report. A
minimal `.handnote` file made for the report is the most useful attachment.

You can expect an acknowledgement within 7 days. Fixes are released as a new version; the release
notes credit the reporter unless you ask otherwise.

## Supported versions

Only the latest release receives fixes.

## Design notes

- No telemetry. HandNote has no server of its own; see `PRIVACY.md` for every network request.
- Keys for MyScript and AI providers are supplied by the user (bring your own key). They are kept in
  Obsidian's secret storage, never in `data.json` or in notes, and are only sent in request headers
  to the service they belong to.
- Content returned by recognition engines and AI providers is treated as untrusted. It is validated
  as JSON, inserted as plain text or as LaTeX rendered by Obsidian's MathJax. HTML, scripts and URLs
  from a model are never executed or fetched.
- Downloaded recognition models, ONNX Runtime Web and fonts are pinned by SHA-256 and size. A file
  whose bytes differ is rejected and never stored or run.
- A damaged or newer-format note is opened read-only and never overwritten.
