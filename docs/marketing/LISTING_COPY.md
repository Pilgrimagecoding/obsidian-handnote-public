# Directory listing and GitHub metadata — copy for review

Status: **prepared, not applied.** Nothing on GitHub or in the Obsidian directory has been changed.
All claims are checked against the public 0.8.1 release.

## 1. Short description (the `description` in `manifest.json`)

The directory shows `manifest.json` → `description` under the plugin name and in Obsidian's plugin
browser. It can only change with a new release (a new version with an edited manifest); an
already published tag is never changed.

Rules (Obsidian guidelines + `eslint-plugin-obsidianmd` `validate-manifest`): starts with a verb,
ends with a period, at most 250 characters, no emoji, does not contain the words "Obsidian" or
"plugin".

Current (0.8.1):

> Write and draw by hand in notebook pages with Apple Pencil, touch or mouse, and convert
> handwriting into editable text, formulas, mind maps and flowcharts.

Problem: "convert … formulas, mind maps and flowcharts" over-promises for the public edition —
there is no on-device math recognition (formulas are typed as LaTeX or recognised by MyScript with
the user's keys), and mind maps / flowcharts need the user's own AI provider.

| # | Candidate | Chars | Notes |
|---|---|---|---|
| **A (recommended)** | Write by hand in notebook pages with Apple Pencil, touch or mouse, and convert handwriting to editable text on your device. | 121 | the three facts people search for (handwriting, Apple Pencil, convert to text), all true without any account |
| B | Take handwritten notes with Apple Pencil, touch or mouse in pages saved as files in your vault, then lasso, edit and convert them to text. | 137 | stresses "files in your vault"; a little long for the plugin browser card |
| C | Write and sketch by hand with Apple Pencil, touch or mouse, convert handwriting to text, and keep formulas as editable LaTeX. | 123 | mentions formulas honestly (LaTeX), loses "on your device" |

Why A: it is short enough to show in full on the plugin card, names the main input device, and
"on your device" sets HandNote apart from cloud-only handwriting tools. When the next release is
made, change only the `description` line; it does not need a feature version on its own.

中文参考（目录只显示英文 manifest，以下仅供对照）：

- A：用 Apple Pencil、手指或鼠标在笔记本页面上手写，并在本机把手写转换成可编辑的文字。
- B：用 Apple Pencil、手指或鼠标记手写笔记，页面以文件形式保存在你的仓库里；可以套索、编辑并转换为文字。
- C：用 Apple Pencil、手指或鼠标书写和画草图，把手写转换成文字，公式以可编辑的 LaTeX 保存。

## 2. Long description (directory "About" text)

English (≈ 900 characters):

> HandNote adds handwritten notebook pages to your vault. Write with an Apple Pencil (pressure,
> palm rejection), a finger or a mouse, on A4, A5, A3 or Letter pages with blank, ruled, grid or
> dotted paper. Use pens, a highlighter, a shape pen and a laser pointer; add text boxes, images,
> shapes with connectors and formulas; move, resize, rotate and recolour anything with the lasso.
>
> Lasso a few words and choose Convert → Text: Chinese and English handwriting becomes editable
> text in place, with candidates and Restore ink. Recognition runs on your device — the runtime is
> built in, and the text models are downloaded once, only when you ask (15.8 MB Chinese, 7.5 MB
> English). Formulas are typed as LaTeX with a live preview, or recognised by MyScript with your own
> keys.
>
> Each note is a .handnote file in your vault and can be embedded in Markdown with ![[…]]. No
> account, no telemetry. Free and open source (MIT).

中文（约 380 字）：

> HandNote 为你的仓库增加手写笔记本页面。用 Apple Pencil（压感、防误触）、手指或鼠标书写，纸张有 A4、A5、A3、Letter，背景可选空白、横线、方格或点阵。可以使用钢笔、荧光笔、图形笔和激光笔；添加文本框、图片、带连线的图形和公式；用套索移动、缩放、旋转和改色。
>
> 用套索圈住几个字，选「转换 → 文字」：中文和英文手写在原位变成可编辑的文字，带候选字和「还原笔迹」。识别在本机运行——运行库已内置，文字模型只在你要求时下载一次（中文 15.8 MB，英文 7.5 MB）。公式用 LaTeX 输入并实时预览，也可以用 MyScript（你自己的密钥）识别。
>
> 每篇笔记都是仓库里的一个 .handnote 文件，可以用 ![[…]] 嵌入 Markdown。无需账号，没有遥测。免费开源（MIT）。

## 3. Categories

Current: **Drawing**, **OCR** — keep both. If the directory offers a note-taking or handwriting
category when editing the listing, add it; do not add AI-related categories (AI is optional and
needs the user's own key).

## 4. Screenshots for the listing

Desktop, 1200 × 800 PNG, real Obsidian 1.14.4 (Linux build) with the released HandNote 0.8.1 files
in a new demo vault. Upload in this order (the directory takes up to 5):

| # | File | Caption (EN) | 说明（中文） |
|---|---|---|---|
| 1 | `assets/screenshots/desktop/01-handwriting.png` | Handwritten notebook page with the pen toolbar | 带笔工具栏的手写笔记页 |
| 2 | `assets/screenshots/desktop/02-convert-to-text.png` | Lasso → Convert → Text, on the device, with candidates | 套索 → 转换 → 文字，本机识别，带候选字 |
| 3 | `assets/screenshots/desktop/03-latex-formula.png` | Type a formula as LaTeX with a live preview | 用 LaTeX 输入公式并实时预览 |
| 4 | `assets/screenshots/desktop/04-pages.png` | Many pages per note; ruled, grid and dotted paper | 一篇笔记多页；横线、方格、点阵纸 |
| 5 | `assets/screenshots/desktop/05-in-your-vault.png` | A handwritten page embedded in a Markdown note | 嵌入 Markdown 笔记中的手写页面 |
| spare | `assets/screenshots/desktop/06-formula-object.png` | The formula placed back on the page as an editable object | 公式作为可编辑对象放回页面 |

Strokes in these screenshots were drawn by a script that plays back pen input on the desktop app
(handwriting data: Hershey script, public domain; Chinese stroke medians from Make Me a Hanzi, APL).
The conversion results are the plugin's real output. Nothing private is visible (demo vault
"HandNote Demo", no account, no paths, no keys).

Mobile (900 × 1600, up to 5): **not made.** They must come from a real iPad with Apple Pencil — see
`VIDEO_RECORDING_GUIDE.md` §4 for the exact list. No mobile screenshot was simulated.

Icon: the directory shows no custom plugin icon at the moment; the icon options in
`BRAND_GUIDE.md` are for GitHub, social images and videos. The listing icon was not changed.

## 5. GitHub repository metadata (`obsidian-handnote-public`)

| Field | Now | Proposed |
|---|---|---|
| About (description) | empty | `Handwritten notebook pages for Obsidian: Apple Pencil, touch and mouse, a lasso, and handwriting-to-text on your device. Every page is a .handnote file in your vault.` |
| Website | empty | `https://community.obsidian.md/plugins/handnote` |
| Topics | none | `obsidian`, `obsidian-plugin`, `obsidian-md`, `handwriting`, `apple-pencil`, `ipad`, `stylus`, `digital-ink`, `note-taking`, `handwriting-recognition`, `ocr`, `latex`, `paddleocr`, `onnxruntime-web` |
| Social preview | GitHub default | `assets/branding/social-preview.png` (1280 × 640, 116 KB) — **upload by hand**: Settings → General → Social preview → Edit → Upload an image |
| Releases / Packages / Deployments on the home page | as is | keep Releases; hide Packages and Deployments (Settings → General, "Include in the home page") — optional |

Description, website and topics can be set with the repository API once you approve
(`PATCH /repos/Pilgrimagecoding/obsidian-handnote-public` and `PUT …/topics`); the social preview
has no API and must be uploaded in the browser.
