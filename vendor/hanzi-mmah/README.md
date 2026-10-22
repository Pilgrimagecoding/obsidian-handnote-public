# Offline Chinese handwriting templates (stroke data)

- `mmah.json`: 9,507 Chinese characters described as sequences of sub-strokes (direction, length, centre). It is copied unchanged from HanziLookupJS, commit `b21124f771ddd91f131e62aa478bc188f6ec78d3` (https://github.com/gugray/HanziLookupJS, `dist/mmah.json`). SHA-256: `287943446fe52cef43df1ba47619a3c040e5924b6031b90939e880711dbc70ae`.
- Origin: Make Me a Hanzi `graphics.txt` (Shaunak Kishore), derived from the fonts Arphic PL KaitiM GB and Arphic PL UKai.
- Licence: **Arphic Public License** (`LICENSE-APL.txt`, unaltered).

## Modification notice (APL §2a)

On 2026-10-20, `scripts/build-hanzi-data.mjs` converted the file into a compact binary, without changing any values: stroke count, sub-stroke count and sub-stroke bytes per character. It also added a GB2312 level flag per character, computed from the GB2312 code table. The output is `src/recognition/offline/hanzi-data.generated.ts`. The converted data stays under the Arphic Public License, and it is freely available in this repository and inside the distributed `main.js`, which embeds the licence text.

HandNote does **not** include any HanziLookup / hanzi_lookup code (LGPL). The recogniser in `src/recognition/offline/` is an independent implementation that reads this data format.
