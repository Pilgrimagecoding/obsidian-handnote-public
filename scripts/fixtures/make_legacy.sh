#!/bin/sh
# Legacy Office fixtures (Word / PowerPoint / Excel 97–2003) written by LibreOffice from the OOXML samples.
# Run from the repository root: sh scripts/fixtures/make_legacy.sh
set -e
d=$(mktemp -d)
cp tests/fixtures/import/sample.docx tests/fixtures/import/sample.pptx tests/fixtures/import/sample.xlsx "$d/"
(cd "$d" && soffice --headless --convert-to 'doc:MS Word 97' sample.docx && soffice --headless --convert-to 'ppt:MS PowerPoint 97' sample.pptx && soffice --headless --convert-to 'xls:MS Excel 97' sample.xlsx) >/dev/null
cp "$d/sample.doc" tests/fixtures/import/   # .ppt / .xls detection uses compound files built by the tests
# sample-zh.doc: a Chinese document (headings, lists, a table, a picture) written by LibreOffice from HTML
echo done
