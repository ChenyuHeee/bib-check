# 小红书发布物料

## 图片规格：3:4（1080×1440），共 4 张（1 封面 + 3 内页）

---

## 图 1 · 封面（最重要）

**画面概念**：左右对比——左边是混乱的 `.bib` 文件（红色标记的错误），右边是整洁规范的 bibliography，中间一道光扫过。

**Prompt（Flux Pro / Midjourney v6 / DALL·E 3）：**

```
A split-screen composition. LEFT SIDE: a messy BibTeX code block on a dark editor background, with red underlines, warning icons, and crossed-out "et al." text visible — chaotic academic citation. RIGHT SIDE: a pristine, perfectly formatted bibliography list on a warm ivory paper texture, with a green checkmark, elegant typography, light academic ambiance. A glowing blue scan line sweeps from left to right across the center, as if the messy citations are being audited and corrected in real time. Volumetric lighting, editorial photography style, 8K, ultra-detailed typography.

Negative prompt: cartoon, illustration, low quality, blurry text, watermarks, people, faces
Aspect ratio: 3:4
```

---

## 图 2 · 数据源网络

**画面概念**：中心是 @bibtex 图标，四周放射状连接 5 个数据源，不同颜色光缆。

**Prompt：**

```
A minimalist infographic illustration. CENTER: a glowing three-dimensional "@bibtex" text icon in white-gold. RADIATING from it are five luminous connection lines in different colors (blue, green, amber, purple, red), each connecting to a floating, semi-transparent logo badge labeled: "OpenAlex", "Crossref", "S2", "DBLP", "Scholar". Dark navy background with subtle grid pattern. Tech-infused academic aesthetic, like a network topology diagram but elegant enough for a magazine spread. Neon glow, clean vector style, 8K.

Negative prompt: people, faces, realistic photography, cluttered
Aspect ratio: 3:4
```

---

## 图 3 · 浏览器 UI 展示

**画面概念**：MacBook 屏幕展示 bib-check 浏览器界面，diff 视图高亮，温暖书房背景。

**Prompt：**

```
A MacBook Pro sitting on a clean wooden desk, screen facing the viewer. On the screen: a beautiful dark-themed web application showing a side-by-side Git-style diff of a BibTeX entry. Green highlights on added lines, red on removed lines. The UI has a modern developer-tool aesthetic — monospace fonts, colored badges, clean cards. Warm ambient lighting, a cup of coffee nearby slightly out of focus, morning sunlight from a window creating soft shadows. Cozy academic workspace vibe, photorealistic, 8K.

Negative prompt: screen glare, distorted text, watermarks, cartoon
Aspect ratio: 3:4
```

---

## 图 4 · 核心功能卡片

**画面概念**：4 张精美卡片 2×2 排列，每张代表一个核心功能。

**Prompt：**

```
Four elegant floating cards arranged in a 2x2 grid against a dark gradient background. Each card has a minimalist icon and short text:
Card 1 (red accent): magnifying glass icon, text "Detect Issues"
Card 2 (blue accent): puzzle piece icon, text "Auto-fill Missing Fields"
Card 3 (green accent): magic wand icon, text "Normalize to Unified Style"
Card 4 (amber accent): download icon, text "Export .bib / .md / .json"
The cards cast soft colored shadows on the background. Clean, modern SaaS landing-page style. Subtle particle effects between the cards. 8K, vector-style render.

Negative prompt: people, faces, messy, cluttered text
Aspect ratio: 3:4
```

---

## 小红书标题（3 个备选）

1. **论文参考文献格式一团糟？这个工具 3 秒帮你全部规范化** 🔥
2. **导师再也没骂过我的 Reference 了…（免费开源工具）**
3. **写论文必备｜自动审计 BibTeX 引用，支持 5 大数据源**

---

## 正文

```
📌 写 LaTeX 论文最烦的就是整理 .bib 文件——

❌ author = {Kaplan, J. and others}   ← et al. 省略
❌ booktitle = {NeurIPS}               ← 缩写不规范
❌ journal = {CoRR}                    ← 引的是 arXiv 预印本
❌ 缺 volume / number / pages          ← 期刊信息不全

这些问题 bib-check 全部帮你自动修 ✨

🔍 同时查询 OpenAlex + Crossref + Semantic Scholar + DBLP（还可开 Google Scholar），自动匹配最权威的元数据

📝 输出：
• 逐条 diff 对比原文 → 建议版
• 按统一规范重写的 .bib 文件
• 标注所有 error / warning

🌐 浏览器打开即用，零安装
🤖 也可 pip install 本地跑 CLI

🔗 chenyuheee.github.io/bib-check
💻 GitHub: ChenyuHeee/bib-check

完全免费 · 开源 · 数据不上传服务器
```

---

## 标签

```
#LaTeX #论文写作 #BibTeX #参考文献 #学术工具 #研究生必备 #开源工具 #论文排版 #科研效率 #AcademicWriting #PhDlife #写论文神器
```

---

## 生成建议

| 图片 | 推荐模型 | 比例 |
|------|---------|------|
| 图 1 · 封面 | Flux 1.1 Pro / Midjourney v6 | 3:4 |
| 图 2 · 数据源 | Midjourney v6 / DALL·E 3 | 3:4 |
| 图 3 · UI | Flux 1.1 Pro（写实最强） | 3:4 |
| 图 4 · 卡片 | DALL·E 3 / Midjourney v6 | 3:4 |

优先保证图 1 和图 3 的质量，封面决定点击率，UI 图决定信任度。
