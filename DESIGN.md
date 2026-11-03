---
name: Turnnote
description: 暖纸面上的会议文档：一份可以对照原话核对的纪要，界面退后，文档说话。
colors:
  paper: "oklch(0.975 0.006 85)"
  sidebar: "oklch(0.953 0.008 85)"
  sheet: "oklch(0.992 0.003 85)"
  hover: "oklch(0.935 0.009 85)"
  selected: "oklch(0.915 0.011 85)"
  rule: "oklch(0.9 0.01 85)"
  rule-strong: "oklch(0.82 0.012 85)"
  ink: "oklch(0.26 0.01 85)"
  ink-2: "oklch(0.45 0.012 85)"
  ink-3: "oklch(0.52 0.012 85)"
  mineral-blue: "oklch(0.45 0.09 255)"
  mineral-wash: "oklch(0.935 0.025 255)"
  mineral-ink: "oklch(0.38 0.1 255)"
  rec-red: "oklch(0.58 0.21 28)"
  warn-brown: "oklch(0.5 0.1 62)"
  warn-wash: "oklch(0.95 0.035 80)"
typography:
  title:
    fontFamily: "Iowan Old Style, Source Han Serif SC, Noto Serif CJK SC, Songti SC, STSong, Palatino Linotype, Georgia, serif"
    fontSize: "32px"
    fontWeight: 500
    lineHeight: 1.25
    letterSpacing: "-0.01em"
  headline:
    fontFamily: "Iowan Old Style, Source Han Serif SC, Noto Serif CJK SC, Songti SC, STSong, Palatino Linotype, Georgia, serif"
    fontSize: "22px"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "-0.005em"
  lede:
    fontFamily: "Iowan Old Style, Source Han Serif SC, Noto Serif CJK SC, Songti SC, STSong, Palatino Linotype, Georgia, serif"
    fontSize: "18px"
    fontWeight: 400
    lineHeight: 1.8
  body:
    fontFamily: "Iowan Old Style, Source Han Serif SC, Noto Serif CJK SC, Songti SC, STSong, Palatino Linotype, Georgia, serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.75
  ui:
    fontFamily: "-apple-system, BlinkMacSystemFont, PingFang SC, Hiragino Sans GB, Microsoft YaHei UI, Microsoft YaHei, Noto Sans CJK SC, Segoe UI, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 500
    lineHeight: 1.6
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, PingFang SC, Hiragino Sans GB, Microsoft YaHei UI, Microsoft YaHei, Noto Sans CJK SC, Segoe UI, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.6
  timecode:
    fontFamily: "ui-monospace, SF Mono, Cascadia Mono, Segoe UI Mono, Menlo, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.6
    fontFeature: "tabular-nums slashed-zero"
rounded:
  s: "6px"
  m: "10px"
  pill: "999px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "20px"
  "6": "24px"
  "8": "32px"
  "10": "40px"
  "12": "48px"
  "16": "64px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.s}"
    padding: "0 16px"
    height: "34px"
  button-default:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.s}"
    padding: "0 16px"
    height: "34px"
  button-default-hover:
    backgroundColor: "{colors.hover}"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.s}"
  button-caution:
    backgroundColor: "{colors.warn-brown}"
    textColor: "{colors.sheet}"
    rounded: "{rounded.s}"
    height: "34px"
  transport-key:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.pill}"
    padding: "0 20px"
    height: "40px"
  field:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.s}"
    height: "34px"
  cue:
    backgroundColor: "{colors.mineral-wash}"
    textColor: "{colors.mineral-ink}"
    rounded: "{rounded.pill}"
    height: "22px"
  cue-hover:
    backgroundColor: "{colors.mineral-blue}"
    textColor: "{colors.paper}"
  chip:
    backgroundColor: "{colors.selected}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    height: "28px"
  reel:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.s}"
    height: "36px"
  reel-current:
    backgroundColor: "{colors.selected}"
  dock:
    backgroundColor: "{colors.sheet}"
    rounded: "{rounded.pill}"
  dialog:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.m}"
  callout-fault:
    backgroundColor: "{colors.warn-wash}"
    textColor: "{colors.warn-brown}"
    rounded: "{rounded.s}"
    padding: "12px 16px"
---

# Design System: Turnnote

## Overview

**Creative North Star: "The Collated Minutes"** (inferred)

纪要是一份摊在纸上的文档，每条决策和行动项后面都挂着一个能翻回原话的时间码，像校对稿上的页码标注。界面是纸和墨：暖色纸面、墨色文字、发丝线，层级靠字号、间距和位置，不靠颜色和粗体。唯一的彩色是矿物蓝，只出现在“可以去核对的地方”和焦点上。

密度克制。左侧会议库、中间单列文档（行宽 44rem）、右侧转写抽屉，三块只靠底色深浅区分，几乎没有分隔线。信息由布局承载：状态用圆点的位置和颜色，操作用带 aria-label / title 的图标，不加说明性小字。

**Key Characteristics:**
- 暖纸面，全站没有纯黑纯白，没有渐变装饰（唯一的渐变是骨架屏和不定进度的扫描动画）。
- 一个强调色（矿物蓝），红色只属于“正在录音”，褐橙只属于故障和破坏性确认。
- 衬线读文档，无衬线做界面，等宽 tabular 做时间码。
- 字重只用 400 / 500 / 600，其中 600 极少。
- 表面几乎全部平放，只有悬浮的东西（录音条、抽屉、对话框）有阴影。

## Colors

暖纸、墨、一抹矿物蓝；红和褐橙是带语义的状态色，不参与装饰。全部以 OKLCH 在 `styles/tokens.css` 中定义，色相 85（暖黄）统一所有中性色。

### Primary
- **矿物蓝** (oklch(0.45 0.09 255)): 焦点环、输入光标、开关打开、进行中圆点、进度条、悬停时的时间码填充。
- **矿物蓝淡底** (oklch(0.935 0.025 255)): 来源时间码胶囊底色、转写行被定位时的整行底色、选区、焦点光晕。
- **矿物蓝墨** (oklch(0.38 0.1 255)): 淡底上的时间码文字。

### Tertiary
- **录音红** (oklch(0.58 0.21 28)): 仅用于“正在录音”：录音圆点（呼吸动画）和录音按钮上的圆形图标。
- **褐橙** (oklch(0.5 0.1 62)) 与 **褐橙淡底** (oklch(0.95 0.035 80)): 故障横幅、权限提示、错误文字、破坏性悬停、需要谨慎确认的实心按钮。

### Neutral
- **纸** (oklch(0.975 0.006 85)): 应用底、转写抽屉、设置面板。
- **侧栏纸** (oklch(0.953 0.008 85)): 会议库底、胶囊式标签底、可编辑块底。
- **面纸** (oklch(0.992 0.003 85)): 文档画布、输入框、对话框、录音条，最亮的一层，仍不是纯白。
- **悬停 / 选中** (oklch(0.935 0.009 85) / oklch(0.915 0.011 85)): 列表和按钮的交互底色，当前会议、关注词标签。
- **发丝线 / 强线** (oklch(0.9 0.01 85) / oklch(0.82 0.012 85)): 抽屉边、对话框边、输入框边、滚动条。
- **墨 / 次墨 / 弱墨** (oklch(0.26 0.01 85) / oklch(0.45 0.012 85) / oklch(0.52 0.012 85)): 正文、次要文字、元信息。源码注明对比度：正文 ≥ 14:1，次要 ≥ 6:1，弱化 ≥ 4.6:1。

### Named Rules
**The One Voice Rule.** 矿物蓝只标记“可核对”和“焦点”：时间码、当前定位、焦点环。不做大面积填充，不做装饰性链接色；开关轨道、进度条这类小面积状态填充除外。

**The Recording-Only Red Rule.** 红色出现即表示正在录音，别处一律不用。故障是褐橙，不是红。

**The Warm Ink Rule.** 文字是墨色（hue 85），背景是纸色；`#000` / `#fff` 不出现。主按钮的实心是墨色而不是蓝色。

## Typography

**Reading Font:** Iowan Old Style → Source Han Serif SC / Noto Serif CJK SC / Songti SC → Georgia (serif)
**UI Font:** 系统无衬线（-apple-system、PingFang SC、Microsoft YaHei UI、Segoe UI）
**Mono Font:** ui-monospace、SF Mono、Cascadia Mono、Menlo、Consolas

**Character:** 衬线负责“读”的东西（文档标题、纪要正文、转写原话、对话框标题），无衬线负责“操作”的东西，等宽只给时间码。两套字体分工明确，不混用同一层级。

### Hierarchy
- **Title** (500, 32px, 1.25, -0.01em): 文档标题（会议名），窄窗口降到 26px。衬线。
- **Headline** (500, 22px, 1.3): 纪要章节标题。衬线。
- **Lede** (400, 18px, 1.8): 纪要摘要段落、对话框标题（500）、空状态标题。衬线，行宽 ≤ 44rem。
- **Body** (400, 16px, 1.7–1.75): 纪要条目、转写原话、可编辑文本区。衬线。
- **UI** (400/500, 14px, 1.6): 按钮、输入框、列表项、提示条。无衬线。
- **Small / Label** (500, 13px / 12px): 分组标题、编辑器标签、元信息、日期分组、胶囊标签。
- **Timecode** (400, 12px, tabular-nums slashed-zero): 来源时间码、转写时间码、录音计时（18px）。

### Named Rules
**The Weight Ceiling Rule.** 只用 400 / 500 / 600。层级靠字号、衬线与无衬线、位置，不靠加粗。600 仅用于设置面板标题和权限提示里的一个词。

**The Tabular Timecode Rule.** 时间码一律 tabular-nums，来源和转写时间码用等宽字体，数字不跳动。

## Layout

整窗不滚动（`overflow: hidden`），各区域自己滚动。网格是 `264px 会议库 | 画布`，顶栏 52px（macOS 左侧让出 84px 红绿灯位，Windows/Linux 右侧让出 152px 窗口控件）。画布内文档居中，正文 `--measure` 44rem，两侧 64px 内边距；转写抽屉 380px，点击纪要里的时间码才打开，打开时挤占画布右侧。抽屉收起时仍留在 DOM 里（视觉隐藏），转写始终可被读取。

间距是 4px 模数（4 / 8 / 12 / 16 / 20 / 24 / 32 / 40 / 48 / 64）。纪要章节之间 40px，章节内条目 12px，文档头部到正文 32px。录音条是画布底部 sticky 的浮条，居中，距底 24px。

响应式：
- **< 1100px**：会议库变成左侧滑入抽屉（宽 min(320px, 86vw)，带遮罩），顶栏出现打开按钮。
- **< 900px**：转写抽屉打开时替代画布，文档边距收到 20px，标题降到 26px。

## Elevation & Depth

平放为主，靠底色分层：侧栏纸 → 纸 → 面纸，深浅差只有几个百分点的亮度。画布与会议库之间没有分隔线，画布左上角 10px 圆角加 1px 发丝阴影即为边界。

### Shadow Vocabulary
- **Float** (`0 1px 2px oklch(0.26 0.01 85 / 0.06), 0 10px 30px oklch(0.26 0.01 85 / 0.12)`): 录音条、对话框、窄窗口的会议库抽屉。暖墨色，不是中性黑。
- **Focus halo** (`0 0 0 3px` 矿物蓝淡底): 输入框聚焦；搜索框用 2px 矿物蓝实环。
- 遮罩：`oklch(0.26 0.01 85 / 0.32)`。

### Named Rules
**The Flat-At-Rest Rule.** 静止的内容面不带阴影。阴影只属于会浮起来的东西：录音条、对话框、窄窗口抽屉。

## Shapes

三档圆角：6px（按钮、输入、列表项、提示条）、10px（对话框、画布左上角）、胶囊（时间码、关注词标签、录音条、录音按钮、开关、进度线）。圆点 8px 正圆。边界优先用 1px 发丝线或底色差，不用粗边框，不用左侧色条。

## Components

### Buttons
- **Shape:** 6px 圆角，内边距 0 16px，字重 500。高度只有两档：默认 34px，大号 40px（录音条和对话框里的动作）。
- **Primary / Record:** 墨色实心、纸色字（`key-primary`、`key-record`）。录音按钮上的圆形图标是录音红。悬停变浅一档，按下变深一档。
- **Default:** 面纸底 + 1px 强线；悬停 hover 底，按下 selected 底；禁用时去底、弱墨字。
- **Quiet / Icon:** 无框无底，次墨字；图标按钮 34px 方形，靠 aria-label / title 说明。
- **Caution:** 褐橙实心，用于需要谨慎确认的动作；`key-danger` 只在悬停时显示褐橙淡底。
- **Transport:** 录音条里的按钮是大号档（40px）胶囊，内边距 0 20px。

### Inputs / Fields
- 面纸底、1px 强线、6px 圆角；悬停边框变弱墨，聚焦边框变矿物蓝并带 3px 淡蓝光晕。文本区用衬线 16px / 1.75，标题输入用 32px 衬线。`field-bare` 去掉边框，用于就地改名和搜索。禁用时侧栏纸底。

### Source Cue (signature)
纪要里的来源时间码：22px 高胶囊、矿物蓝淡底、矿物蓝墨字、12px 等宽，紧跟条目文字。悬停整体翻成矿物蓝底纸色字；无来源时不显示；点击打开转写抽屉并定位，被定位的转写行整行淡蓝底，1.8s 淡出。反方向同样成立：悬停或聚焦转写某一行时，纪要里引用它的条目整行淡蓝底、时间码翻蓝，离开即熄灭。

### Meeting Reel (library item)
36px 高、三列网格：8px 状态点 | 标题（单行省略）| 时间。按日期分组，分组标题 12px 弱墨并吸顶。搜索命中转写正文时（标题未命中），标题下多一行 12px 次墨的原话片段，命中词矿物蓝淡底。当前项 selected 底 + 500 字重。状态点：红呼吸 = 录音，蓝呼吸 = 处理中，弱墨 = 完成，褐 = 故障。

### Recording Dock
画布底部居中的胶囊浮条，面纸底、Float 阴影；左侧录音圆点和 18px 等宽计时，右侧是 transport 按钮。无录音状态时只显示按钮。录音圆点和计时出现时有一次 200ms 的轻缩放，之后只有圆点呼吸。

### Dialog
全部确认交互使用原生 `<dialog>` + `showModal()`：宽 min(460px, 100vw-32px)，面纸底，10px 圆角，Float 阴影，标题衬线 18px / 500，正文次墨 14px / 1.7，按钮在底部横排。设置是同一元素的整高右侧面板（460px，纸底，无圆角，标题改用无衬线 14px / 600）。

### Chips & Keyword tags
6px 圆角、选中底、13px，右侧 24px 圆形移除按钮。关键词末尾是一个虚线描边的“＋ 关键词”输入槽，聚焦时变成矿物蓝实线。纪要里的主题标签同为 6px 圆角、侧栏纸底。

### Toast
成功确认（例如导出完成）是画布底部居中的墨色胶囊，纸色字，停留约 3 秒后自动消失；它是计时器驱动而不是 CSS 动画，所以在“减少动效”下仍然可见。故障和警告不用 Toast，保持在顶部横幅直到被处理。

### Transcript Drawer
右侧 380px，始终在栅格里，列宽 0 ↔ 380px 过渡 320ms；收起时 `inert`，焦点和读屏都不会进入，内容仍在 DOM 中。窄于 900px 时抽屉替代画布，不做过渡。

### Callouts & Bulletins
横幅与提示条：6px 圆角（顶部横幅通栏）；信息用侧栏纸底或矿物蓝淡底，故障用褐橙淡底 + 褐橙字。

### Progress
3px 细线，纸色槽，矿物蓝填充；不定进度时是一段蓝色扫过。

## Do's and Don'ts

### Do:
- **Do** 让红色只表示正在录音（录音圆点、录音按钮图标）。
- **Do** 用褐橙 + 褐橙淡底表达故障、权限问题和破坏性确认。
- **Do** 所有文字用 `--ink` 系列，所有底用 `--paper / --sidebar / --sheet` 系列；新增颜色先在 `tokens.css` 里定义。
- **Do** 纪要正文、转写原话、对话框标题、文档标题用衬线；按钮、列表、提示用无衬线；时间码用等宽 tabular。
- **Do** 状态靠圆点颜色和位置、操作靠带 aria-label / title 的图标表达，少写辅助说明文字。
- **Do** 所有确认（删除、外发转写文本、覆盖）使用原生 `<dialog>`，破坏性或向外发送数据的动作必须先确认。
- **Do** 提供方名称来自 `settings.noteProvider`，经 `providerLabel()` 显示；未登记的提供方直接显示其标识。
- **Do** 尊重 `prefers-reduced-motion`（呼吸、扫描动画停止，过渡缩到 1ms）。
- **Do** 保持 4px 间距模数、6 / 10 / 胶囊三档圆角，正文行宽不超过 44rem。

### Don't:
- **Don't** 使用 `#000` / `#fff` 或中性灰；中性色一律带 hue 85 的暖调。
- **Don't** 把矿物蓝做成大面积填充或装饰色；它只给焦点、时间码、当前定位和进度。
- **Don't** 用红色表达错误、删除或警告。
- **Don't** 用字重制造层级，不使用 400 / 500 / 600 以外的字重。
- **Don't** 在 UI 文案里写死 DeepSeek、OpenAI 等提供方名称。名称只登记在 `ui/providers.ts`，界面一律经 `providerLabel()` 取自 `settings.noteProvider`；新增服务商只改这一处。
- **Don't** 给静止的内容面加阴影，也不加左侧色条或粗边框。
- **Don't** 在窄窗口把会议库和转写抽屉同时挤在画布旁；< 1100px 库进抽屉，< 900px 转写替代画布。
- **Don't** 用 `window.confirm` 或自制遮罩代替原生 `<dialog>`。
