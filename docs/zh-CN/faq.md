# 常见问题

[← 中文文档首页](README.md)

## 基本问题

**HandNote 是什么？**
HandNote 是 Obsidian 的手写笔记插件：在 Obsidian 里增加可以用 Apple Pencil、手指或鼠标书写的笔记本页面，支持套索、
本机手写转文字、LaTeX 公式，以及 PDF / Word / PowerPoint / Excel 文档批注。

**HandNote 是 Obsidian 的官方社区插件吗？**
它已收录在 Obsidian 官方社区插件目录（<https://community.obsidian.md/plugins/handnote>），可以在 Obsidian 里直接搜索
安装。它由社区开发者独立开发维护，不是 Obsidian 团队出品。

**Obsidian 怎样手写笔记？**
Obsidian 本身没有手写功能，需要插件。安装 HandNote 后，用「新建 HandNote」新建手写笔记，就可以用 Apple Pencil 或鼠标书写；
手写页面保存在仓库里，也能嵌入到 Markdown 笔记中。

**支持 iPad 和 Apple Pencil 吗？**
支持，这是主要目标平台。见 [iPad 与 Apple Pencil 使用教程](ipad-apple-pencil.md)。

**免费吗？开源吗？**
免费，源代码以 MIT 许可公开：<https://github.com/Pilgrimagecoding/obsidian-handnote-public>。

**需要账号、订阅或 API Key 吗？**
不需要。书写、套索、本机文字识别、LaTeX 公式、文档批注都不需要。MyScript 和 AI 功能是可选的，用你自己的密钥。

## 识别

**能把手写转成文字吗？**
能，中文和英文。见[手写转文字](handwriting-to-text.md)。

**有本地公式识别吗？**
没有。可以输入 LaTeX，或用你自己的 MyScript 密钥识别。见[公式](formulas.md)。

**识别需要联网吗？**
下载模型时需要（中文 15.8 MB，英文 7.5 MB）。下载后断网也能识别。内置的离线中文识别完全不联网。

**模型下载很慢或下不了？**
运行 **设置 → HandNote → 本地识别 → 运行自检**，看哪些下载源能连上。都连不上时，在电脑上下好文件，用
**从文件导入模型** 导入。刚更新插件后如果提示存储被旧版本占用，把 Obsidian 完全退出（iPad 上从后台划掉）再打开即可，不用重新下载。

**识别会上传我的笔迹吗？**
本机识别不会。只有你自己配置了 MyScript 或 AI 服务，并在每次发送前确认后，才会发送所选的内容。

## 文件与同步

**笔记存在哪里？能同步吗？**
每篇笔记是仓库里的一个 `.handnote` 文件（JSON 文本）。Obsidian Sync、iCloud、Remotely Save、OneDrive、Git 都可以同步。
HandNote 每次保存前都会检查文件；如果另一台设备在这期间改过，会另存一份 `(conflict …).handnote`，不会覆盖。

**写到一半 App 被关掉了怎么办？**
未保存的笔画大约 0.4 秒后就会写进插件文件夹里的恢复日志。重新打开笔记时，HandNote 会提示恢复。

**怎么备份和导出？**
备份仓库就包含了所有笔记。导出单页：⋯ → Export page as PNG / SVG。

**Obsidian Sync 不同步插件？**
`main.js` 约 6.2 MB，Obsidian Sync 标准版不同步超过 5 MB 的文件。请在每台设备上分别从社区插件目录安装 HandNote。

**导入文档时旁边多了一个 `.handnote-layout.json`？**
这是 Word / PowerPoint / Excel 的固定排版，让每台设备显示的页面完全一致。请让同步工具同步它。

## 其他

**能在 iPhone 或 Android 上用吗？**
没有使用桌面专用接口，但手机没有测试过，工具栏是按平板和电脑设计的。

**HandNote 和 Goodnotes、Notability 有关系吗？**
没有。HandNote 是独立的 Obsidian 社区插件。

**怎么反馈问题？**
在 [GitHub Issues](https://github.com/Pilgrimagecoding/obsidian-handnote-public/issues) 提交，请不要附上私人笔记或密钥。
安全问题请按 [SECURITY.md](../../SECURITY.md) 的方式联系。
