# Forum showcase post — draft (not posted)

For the Obsidian forum, category **Share & showcase**. Post only after your approval; attach the
images from `assets/screenshots/desktop/` (upload them in the forum editor) and, when it exists,
link the video. Keep the disclosure line: forum rules ask authors to say that it is their own
plugin.

---

## English

**Title:** HandNote — handwritten notebook pages with Apple Pencil, lasso and on-device handwriting-to-text

Hi everyone,

I made **HandNote**, a free and open-source community plugin (MIT) that adds handwritten notebook
pages to Obsidian. I'm the author; it's now in the community directory.

**What it does**

- Write with an **Apple Pencil** (pressure, palm rejection), a finger or a mouse. A4 / A5 / A3 /
  Letter pages, blank, ruled, grid or dotted paper, many pages per note.
- Fountain pen, pencil, highlighter, dashed strokes, a shape pen that straightens lines, arrows,
  circles and rectangles, and a laser pointer.
- **Lasso** anything to move, resize, rotate, recolour or group it.
- **Convert → Text**: lasso a few words and the ink turns into editable text in place (Chinese and
  English), with candidates and a *Restore ink* button. Recognition runs **on your device**; the
  runtime is built in and the text models are downloaded once, only when you press Download
  (15.8 MB Chinese, 7.5 MB English). Nothing is uploaded.
- **Formulas** are typed as LaTeX with a live preview (or recognised by MyScript if you bring your
  own keys). There is no on-device math recognition yet.
- Every note is a **`.handnote` file in your vault**. Embed it in Markdown with
  `![[Lecture 3.handnote]]`. No account, no telemetry. Saving checks for sync conflicts first and
  keeps a recovery journal.

[screenshot 1: handwritten page] [screenshot 2: lasso → text] [screenshot 3: LaTeX editor]
[screenshot 5: embedded in a Markdown note]

**Install:** Settings → Community plugins → Browse → "HandNote", or
https://community.obsidian.md/plugins/handnote

**Good to know**

- The iPad with Apple Pencil is the main target; Windows / macOS / Linux work with mouse, pen
  tablet or touch. Phones should work but are not tested.
- `main.js` is about 5.9 MB because the recognition runtime is built in (Obsidian Sync Standard
  doesn't sync files over 5 MB — install the plugin on each device in that case).
- Optional: MyScript or an AI provider (OpenAI, Anthropic, Gemini, DeepSeek, Qwen, any
  OpenAI-compatible endpoint) with **your own key**, only after a confirmation.

Source and issues: https://github.com/Pilgrimagecoding/obsidian-handnote-public — feedback, bug
reports and handwriting that it reads badly are all very welcome (please don't attach private
notes).

*The screenshots are from Obsidian desktop with HandNote 0.8.1 in a demo vault; the handwriting in
them was played back by a script, the conversion is the plugin's real output.*

---

## 中文

**标题：** HandNote：Obsidian 手写笔记本页面——Apple Pencil、套索、本机手写转文字

大家好，

我做了一个免费开源（MIT）的社区插件 **HandNote**，为 Obsidian 增加手写笔记本页面。我是作者，插件已进入社区插件目录。

**它能做什么**

- 用 **Apple Pencil**（压感、防误触）、手指或鼠标书写。A4 / A5 / A3 / Letter 页面，空白、横线、方格或点阵纸，一篇笔记可以有很多页。
- 钢笔、铅笔、荧光笔、虚线，能把直线、箭头、圆和矩形画规整的图形笔，还有激光笔。
- 用**套索**移动、缩放、旋转、改色或编组任何内容。
- **转换 → 文字**：圈住几个字，笔迹就在原位变成可编辑的文字（中文和英文），带候选字和「还原笔迹」。识别**在本机运行**：运行库已内置，文字模型只在你点击下载时下载一次（中文 15.8 MB，英文 7.5 MB），不上传任何内容。
- **公式**用 LaTeX 输入并实时预览（也可以用你自己的 MyScript 密钥识别）。目前没有本机公式识别。
- 每篇笔记都是**仓库里的 `.handnote` 文件**，可以用 `![[Lecture 3.handnote]]` 嵌入 Markdown。无需账号，没有遥测。保存前会检查同步冲突，并有恢复日志。

【截图 1：手写页面】【截图 2：套索 → 文字】【截图 3：LaTeX 编辑器】【截图 5：嵌入 Markdown 笔记】

**安装：** 设置 → 第三方插件 → 浏览 → 搜索「HandNote」，或打开 https://community.obsidian.md/plugins/handnote

**需要知道**

- 主要面向 iPad + Apple Pencil；Windows / macOS / Linux 可用鼠标、数位板或触屏。手机理论上可用，但未测试。
- 因为识别运行库内置，`main.js` 约 5.9 MB（Obsidian Sync 标准版不同步超过 5 MB 的文件，这种情况下请在每台设备上安装插件）。
- 可选：MyScript 或 AI 服务商（OpenAI、Anthropic、Gemini、DeepSeek、Qwen、任意 OpenAI 兼容接口），使用**你自己的密钥**，每次发送前都会确认。

源代码和问题反馈：https://github.com/Pilgrimagecoding/obsidian-handnote-public ——欢迎反馈、报告问题，或者告诉我哪些手写识别得不好（请不要附上私人笔记）。

*截图来自 Obsidian 桌面版 + HandNote 0.8.1 演示仓库；其中的笔迹由脚本回放，转换结果是插件的真实输出。*
