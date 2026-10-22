# Promo videos — storyboard, sources and licences

Status (2026-10-22): **rendered and checked** — two cuts, each in English and Chinese, made from
real iPad + Apple Pencil recordings (filmed by the maintainer) and desktop screen recordings. The
video files are not in Git (`handnote-video/out/` outside the repositories; `.gitignore` also
ignores `ipad-footage/` and video files).

| File | Format | Duration | Size |
|---|---|---|---|
| `handnote-main-en.mp4` / `handnote-main-zh.mp4` | 1920 × 1080, 30 fps, H.264 High, yuv420p, AAC stereo 48 kHz (silent track), faststart | 66.2 s | ≈ 20 MB |
| `handnote-short-en.mp4` / `handnote-short-zh.mp4` | 1080 × 1920, same codecs | 34.6 s | ≈ 7.9 MB |
| `handnote-{main,short}-{en,zh}.srt` | captions as subtitle files (the MP4s have them burned in) | — | — |
| `video-thumbnail.png` (`assets/branding/`) | 1920 × 1080 cover | — | 219 KB |

No voice-over and no music; the audio of the iPad recordings (room sound) is removed. The audio
track is digital silence so that platforms which expect audio accept the file.

## What is real and what is not

- **iPad clips (P1, P6, P7):** real recordings by the maintainer — an iPad with Apple Pencil running
  the public HandNote 0.8.1 from Community plugins, filmed from above with a phone (4K HEVC). Only
  rotated upright, scaled to 1920 × 1080, trimmed, sped up and cropped; sound removed. Recognition in
  P6 ("Hello, this is handnote.") is the plugin's real on-device output.
- **Desktop clips:** Obsidian desktop 1.14.4 (Linux build) running the **released 0.8.1 files**
  (`main.js` SHA-256 `f5a89b0a…`) in a new demo vault; every dialog, menu and result is real
  (神经网络, PP-OCRv5 on the device, 0.8–1.0 s). The handwriting is **played back by a script**
  (English: Hershey script glyphs, public domain; Chinese: Make Me a Hanzi medians, APL); every
  desktop clip says so on screen and the end card repeats it.
- **Typed, not recognised:** the formula. The public edition has no on-device math recognition; the
  video shows the real dialog that says so and the LaTeX being typed. The maintainer's clip of
  formula recognition (`公式识别.mp4`) is kept for a future version with an own model and is **not
  used**.
- **Not shown:** palm rejection, finger gestures, AI mind maps / flowcharts (need a paid provider
  key), MyScript.
- Edits: trimming, speed-up (shown on screen, e.g. "2.5×"), one smooth zoom, static crops, framing
  on a paper background, captions, fades. No frame was retouched.

On-screen source line: iPad clips "iPad + Apple Pencil · HandNote 0.8.1 · real recording";
desktop clips "Obsidian desktop · HandNote 0.8.1 · handwriting played back by a script" (+ speed).

## Main cut (16:9, 66 s)

| # | Out | Source | Speed | Picture | Caption EN / 中文 |
|---|---|---|---|---|---|
| 1 | 0:00.0–0:03.5 | title card | — | logo, "Your handwriting, inside your vault." | — |
| 2 | 0:03.5–0:12.1 | iPad P1 1.0–22.5 s | 2.5× | Apple Pencil writes "Hello, this is handnote." | Made for Apple Pencil: write on iPad like on paper. / 为 Apple Pencil 而做：在 iPad 上像在纸上一样书写。 |
| 3 | 0:12.1–0:25.3 | iPad P6 0–19.8 s | 1.5×, crop x 260 y 90 w 1600 | lasso → Convert → Text → result with candidates → enlarge with the lasso | Lasso → Convert → Text. Recognition runs on your device. / 套索 → 转换 → 文字。识别在本机完成。 |
| 4 | 0:25.3–0:34.4 | desktop 60.66–69.75 s | 1× + zoom | lasso 神经网络 → Convert → Text → candidates, Restore ink | Chinese and English, converted in place, with candidates. / 中文和英文，原地转换，带候选字。 |
| 5 | 0:34.4–0:44.0 | iPad P7 1–25 s | 2.5× | page sidebar → add pages → page menu → Change template dialog | Add pages and change the template: size, paper, ruled, grid, dotted. / 添加页面、更换模板：尺寸、纸色、横线、方格、点阵。 |
| 6 | 0:44.0–0:53.7 | desktop 70.27–82.84 s | 1.3× | lasso equation → Convert → Math → "no on-device math model" dialog → Type LaTeX → Replace | Formulas: type LaTeX with a live preview, then replace the ink. / 公式：输入 LaTeX、实时预览，再替换笔迹。 |
| 7 | 0:53.7–1:00.2 | desktop 102.34–108.84 s | 1× | Linear Algebra.md with the embedded page | Embed any page in Markdown with ![[Lecture 3.handnote]]. / 用 ![[Lecture 3.handnote]] 把手写页嵌入 Markdown。 |
| 8 | 1:00.2–1:06.2 | end card | — | "Free and open source · MIT", install path, source disclosure | — |

## Short cut (9:16, 35 s)

| # | Out | Source | Speed | Crop (x, y, width; 4:3) | Caption EN / 中文 |
|---|---|---|---|---|---|
| 1 | 0:00.0–0:02.5 | title card (portrait) | — | — | — |
| 2 | 0:02.5–0:09.7 | iPad P1 3–21 s | 2.5× | 360, 0, 1440 | Write with Apple Pencil / 用 Apple Pencil 书写 |
| 3 | 0:09.7–0:18.9 | iPad P6 0.5–17 s | 1.8× | 300, 30, 1400 | Lasso → Convert → Text, on your device / 套索 → 转换为文字，本机识别 |
| 4 | 0:18.9–0:25.7 | iPad P7 1–25 s | 3.5× | 240, 0, 1440 | Pages and templates / 多页与模板 |
| 5 | 0:25.7–0:30.6 | desktop 102.74–107.64 s | 1× | 470, 0, 1440 | Every page is a file in your vault / 每一页都是仓库里的文件 |
| 6 | 0:30.6–0:34.6 | end card (portrait) | — | — | — |

## iPad footage

Delivered: `P1.mp4` (23 s), `P6.mp4` (20 s), `P7-P9.mp4` (48 s), `公式识别.mp4` (not used). Not
recorded (optional for a later cut): palm rejection, finger gestures, Markdown embed on the iPad,
portrait screen recording, mobile listing screenshots. Proxies were made with
`ffmpeg -vf "transpose=1,scale=1920:1080,fps=30" -an -map_metadata -1` (rotation upright, sound and
phone metadata removed) and placed in `<work>/ipad/`.

## Reproduce

Maintainer tools (development repository, `scripts/marketing/`, not part of the plugin):

1. `scripts/marketing/demo/start-demo.sh` with `DSF=1.5` — fresh demo vault, Obsidian on a virtual display.
2. `node scripts/marketing/demo/record.mjs` (desktop screenshots: `screens.mjs`) → `raw.mkv` (1920 × 1080, 30 fps) + `markers.json`.
3. Render cards and frames: `node scripts/marketing/render.mjs assets/branding/src/cards.html#<variant> …`
   and `…/frames.html#wide|tall` (variants listed in the files).
4. iPad proxies into `<work dir>/ipad/` (above), then `python3 scripts/marketing/build_video.py <work dir> <out dir>` (env `CUTS=main` or `short` to
   build one cut).
5. Check: `ffprobe`, frame sheets (`ffmpeg -vf fps=1/3,tile=…`), `volumedetect` (−91 dB = silence).

## Licences of everything in the videos

| Item | Source | Licence |
|---|---|---|
| Obsidian app UI | Obsidian 1.14.4 desktop, screen recording of the app in use | Obsidian's UI is shown as the platform the plugin runs on; no Obsidian logo or trademark is used as our brand |
| HandNote UI, icon, cards | this project | MIT (code); brand assets by the HandNote author (see LICENSE) |
| Inter, Inter Display | rsms/inter | SIL OFL 1.1 |
| Noto Sans CJK SC | Google / Adobe | SIL OFL 1.1 |
| English handwriting strokes | Hershey fonts (A. V. Hershey, U.S. NBS) via the HersheyFonts package | public domain data; package MIT |
| Chinese handwriting strokes | Make Me a Hanzi medians (`tests/fixtures/hanzi-medians.json`) | Arphic Public License |
| iPad recordings | filmed by the maintainer | maintainer's own footage |
| Recognition model in the footage | PaddleOCR PP-OCRv5 mobile rec (downloaded/imported like a user would) | Apache-2.0 |
| Music / voice / stock footage | none | — |
