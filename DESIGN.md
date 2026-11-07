---
name: Turnnote
description: 淡蓝空气里的工作台：白色玻璃面板、糖果色卡片、蓝色渐变；纪要可以回到原话核对，界面轻盈但不表演。
colors:
  bg: "oklch(0.975 0.018 255)"
  paper: "oklch(0.995 0.004 250)"
  glass: "oklch(1 0 0 / 0.64)"
  ink: "oklch(0.28 0.04 262)"
  ink-2: "oklch(0.46 0.035 262)"
  ink-3: "oklch(0.55 0.03 262)"
  accent: "oklch(0.56 0.18 255)"
  accent-2: "oklch(0.54 0.17 268)"
  rec: "oklch(0.58 0.21 10)"
  warn: "oklch(0.55 0.13 60)"
  tint-blue: "oklch(0.932 0.068 250)"
  tint-mint: "oklch(0.941 0.062 170)"
  tint-peach: "oklch(0.946 0.062 70)"
  tint-rose: "oklch(0.941 0.058 345)"
  tint-sand: "oklch(0.951 0.05 95)"
typography:
  micro:
    fontFamily: "-apple-system, BlinkMacSystemFont, PingFang SC, Hiragino Sans GB, Microsoft YaHei UI, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1.5
  small:
    fontFamily: "-apple-system, BlinkMacSystemFont, PingFang SC, Hiragino Sans GB, Microsoft YaHei UI, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
  ui:
    fontFamily: "-apple-system, BlinkMacSystemFont, PingFang SC, Hiragino Sans GB, Microsoft YaHei UI, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  read:
    fontFamily: "-apple-system, BlinkMacSystemFont, PingFang SC, Hiragino Sans GB, Microsoft YaHei UI, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.7
  lede:
    fontFamily: "-apple-system, BlinkMacSystemFont, PingFang SC, Hiragino Sans GB, Microsoft YaHei UI, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 400
    lineHeight: 1.6
  large:
    fontFamily: "-apple-system, BlinkMacSystemFont, PingFang SC, Hiragino Sans GB, Microsoft YaHei UI, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: 1.35
  title-sm:
    fontFamily: "-apple-system, BlinkMacSystemFont, PingFang SC, Hiragino Sans GB, Microsoft YaHei UI, system-ui, sans-serif"
    fontSize: "28px"
    fontWeight: 600
    lineHeight: 1.15
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, PingFang SC, Hiragino Sans GB, Microsoft YaHei UI, system-ui, sans-serif"
    fontSize: "34px"
    fontWeight: 600
    lineHeight: 1.12
  timer:
    fontFamily: "ui-monospace, SF Mono, Cascadia Mono, Segoe UI Mono, Menlo, Consolas, monospace"
    fontSize: "56px"
    fontWeight: 500
    lineHeight: 1
rounded:
  xs: "6px"
  s: "10px"
  m: "14px"
  l: "18px"
  xl: "24px"
  xxl: "28px"
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
    backgroundColor: "linear-gradient(135deg, {colors.accent}, {colors.accent-2})"
    textColor: "oklch(0.995 0.004 255)"
    rounded: "{rounded.pill}"
    height: "34px"
  button-record:
    backgroundColor: "linear-gradient(135deg, oklch(0.56 0.21 10), oklch(0.54 0.2 345))"
    textColor: "oklch(0.995 0.004 255)"
    rounded: "{rounded.pill}"
    height: "34px"
  field:
    backgroundColor: "oklch(1 0 0 / 0.64)"
    textColor: "{colors.ink}"
    rounded: "{rounded.m}"
    height: "38px"
  note-card:
    backgroundColor: "linear-gradient(135deg, tint 38%, white)"
    rounded: "{rounded.xl}"
    padding: "18px 20px"
  dock:
    backgroundColor: "oklch(1 0 0 / 0.72)"
    rounded: "{rounded.pill}"
    height: "48px"
---

# Turnnote 设计系统

Turnnote 是桌面会议工作台，不是网页。视觉世界叫 **Soft desk**：淡蓝空气里浮着两块玻璃——会议库和文档台面；文档里是五张糖果色卡片，颜色按内容类型固定。界面轻盈、有层次、有动效，但每个装饰都在替内容服务。

这一版是**浅色单一世界**：没有暗色主题，系统切到深色时界面仍然是淡蓝纸面。上一版“石墨 + 无衬线 + 无渐变”的冷工作台已整体替换。

## 原则

1. **浅色是承诺。** 背景是淡蓝到淡粉的渐变空气，面板是白色玻璃；不跟随系统深色。
2. **玻璃只给外壳。** 会议库、主面板、转写抽屉、对话框、设置、录音条用毛玻璃；内容卡片用不透明渐变，不做玻璃套玻璃。
3. **颜色是内容的索引。** 摘要=蓝，主题=薄荷，决策=桃，未决问题=玫红，行动项=沙金；同一个类型永远同一个色调，不随机。
4. **一个主操作。** 蓝色渐变只给主按钮；录音动作是玫红渐变；红色只属于正在录音的状态点。
5. **运动只表达状态。** 卡片悬停抬起、录音红圈扩散、抽屉滑入、笔记卡依次入场；没有滚动视差和全屏载入编排。
6. **诚实。** 没有实时字幕、暂停和波形，就不画；候选里的每个按钮都对应真实 IPC。
7. **界面不自我解释。** 状态和可用动作由布局、控件和内容本身表达：不写引导说明、辅助标签和快捷键提示，空态不铺介绍卡。

## 色彩与卡片

| 角色 | 值 | 用途 |
|---|---|---|
| `--bg` / `--bg-2` | `oklch(0.975 0.018 255)` / `oklch(0.988 0.012 235)` | 窗口空气 |
| `--glass` | `oklch(1 0 0 / 0.64)` | 外壳面板 |
| `--paper` | `oklch(0.995 0.004 250)` | 台面 |
| `--ink` | `oklch(0.28 0.04 262)` | 标题、正文（14.4:1） |
| `--ink-2` | `oklch(0.46 0.035 262)` | 次要文字（7:1） |
| `--ink-3` | `oklch(0.55 0.03 262)` | 元信息（4.8:1） |
| `--accent` → `--accent-2` | `oklch(0.56 0.18 255)` → `oklch(0.54 0.17 268)` | 主按钮、焦点、当前项 |
| `--rec` | `oklch(0.58 0.21 10)` | 正在录音 |

卡片色调（`--tint-*`，46–78% 混白后做渐变）：

| 卡片 | 色调 | 图标 | 文字 |
|---|---|---|---|
| 摘要 | `tint-blue` | `sparkles` | 正文 `--ink` |
| 关键主题 | `tint-mint` | `tag` | 标签 `mint-ink` |
| 决策 | `tint-peach` | `check` | 来源 `accent-ink` |
| 未决问题 | `tint-rose` | `help` | 正文 `--ink` |
| 行动项 | `tint-sand` | `list` | 元信息 `--ink-2` |

渐变只出现在：窗口背景、标题卡、五张内容卡、主按钮、录音按钮、录音光晕。不做渐变文字，不用渐变替代信息层级。

## 字体

系统无衬线承担全部 UI 与正文；等宽只给时间码、模型标识和计时。字重 400 / 500 / 600。

- 会议标题 34px / 600，窄窗口 28px；空态标题 28px；录音计时 56px 等宽。
- 纪要章节标题 15px / 600，带 28px 图标徽章；正文 15px / 1.7。
- UI 13px；辅助 12px；元信息 11px。
- 正文行宽 `--measure: 42rem`；标题 `text-wrap: balance`，摘要 `text-wrap: pretty`。

## 布局

- 窗口四周 14px 呼吸；标题栏 52px 透明，左侧品牌是玻璃胶囊，右侧是玻璃圆形按钮。macOS 让出 84px 红绿灯位，Windows/Linux 右侧让出 152px。
- 会议库 280px（可拖 240–360，双击复位 280），是 24px 圆角的玻璃卡；内部新建、搜索、按日分组的会议卡。
- 主面板同样是 24px 玻璃卡；文档列最大 `42rem + 96px`，内边距 28/48/88。
- 标题卡 24px 圆角，淡蓝到淡粉渐变；下面是设备条、纪要工具带和五张内容卡。
- 没有打开的会议时，画布只留一行状态和一枚“新建会议”按钮；新建会议页直接由标题卡、设备条和底部录音条组成，中间不放引导卡。
- 转写抽屉 340px，是主面板里的一张 24px 玻璃卡，四边 14px。
- 录音条不再是浮在内容上的胶囊，而是主面板底部的一行：居中的玻璃胶囊，永远不遮正文。录音中画布中央另有一张 56px 计时大卡。
- 断点：< 1100px 会议库变成浮起抽屉（宽 min(320px, 86vw)，背景模糊 + 遮罩）；< 900px 转写抽屉替代画布，文档边距 20px。

## 玻璃与阴影

- 外壳面板：`background: var(--glass)` + `backdrop-filter: blur(26px) saturate(1.25)` + 1px 白边 + 深蓝灰柔影。
- 对话框/设置：更强的 `--glass-strong`，`backdrop-filter: blur(28px)`；`::backdrop` 用 10px 模糊把应用压下去。
- 卡片和按钮不透明，靠 `--shadow-card`（14px/34px 负扩散）抬起；悬停再抬 1px。
- 不用纯黑/纯白；所有中性色带 255 的蓝调，白色用 `oklch(1 0 0 / α)`。

## 组件

- **按钮**：34px 高、全圆角、1px 白边、玻璃白底；主操作蓝渐变 + 蓝色光晕；录音玫红渐变；危险赭石渐变；次级半透明白。悬停上浮 1px，按下缩到 0.985。
- **图标按钮**：34px 圆形（顶栏 36px）；会议库行内使用 40px 彩色首字母头像，状态点压在头像右下角。
- **字段**：38px，14px 圆角，白色半透明底；聚焦时蓝色边框 + 4px 光晕。
- **纪要卡**：24px 圆角、18/20px 内边距、彩色渐变 + 右上柔光；章节标题带彩色图标徽章；条目是 7px 内边距的行，悬停变白。
- **来源时间码**：白色胶囊 + 蓝色等宽时间；悬停翻成蓝渐变实底。
- **录音条**：底部居中玻璃胶囊，38px 按钮；录音时红点扩散圈、计时在中央大卡里。
- **空态/准备态**：没有打开的会议时只有一行状态和“新建会议”按钮，点击打开会议库并聚焦标题输入；不铺卡片、不写说明、不列快捷键。新建的会议页没有“准备开始”引导卡，设备条和底部录音条就是入口；录音中只有计时大卡和状态。
- **对话框**：480px、28px 圆角、玻璃渐变；设置是右侧 460px、四周留 12px 的浮起面板，内容间隔随面板高度铺开，分组之间只用 1px 细线分开，不写小标题、引导句和字段说明，字段标签自己说清用途（如“转写语言”）。
- **设置里的控件要看得见边**：白边放在浅底上等于没边，卡片和输入框改用 1px 蓝灰描边（`--edge-line`）加柔和投影（`--shadow-lift`）；“添加自己的服务”是虚线框，表示新增，悬停变实线。
- **下拉候选**：不用原生 `<datalist>`（弹层跟随系统配色，深色下是黑框，也改不了样式）。模型候选和转写语言共用一块淡蓝玻璃弹层：1px `--edge-line` 描边、`--menu-bg` 渐变、`blur(20px)` 和 `--shadow-float` 投影；候选行 34px 高，悬停/键盘高亮是浅蓝渐变，当前模型加粗；下方放不下时翻到输入框上方。
- **提示**：深蓝玻璃，11px；不支持 `backdrop-filter` 时回退为 0.94 不透明底。

## 动效

- 背景两团光 34s / 41s 缓慢漂移；卡片悬停 140ms 抬起；笔记卡依次 380ms 浮入（45ms 间隔）。
- 录音红圈 2.8s 呼吸，状态点 1.8s 扩散；抽屉 320ms 滑入；对话框 240ms 弹性进场。
- 所有动效在 `prefers-reduced-motion: reduce` 下停用或压到 1ms；内容默认可见。

## 桌面行为

- 快捷键：⌘/Ctrl+K 搜索，⌘/Ctrl+N 新建，⌘/Ctrl+\ 会议库，⌘/Ctrl+J 转写，⌘/Ctrl+, 设置。快捷键照常可用，但界面不显示提示文字或 kbd 角标。
- 录音中不能新建或切换会议；会给出原因。
- 设置、删除、丢弃、外发转写都用原生 `<dialog>`；初始焦点在对话框本身，危险操作默认焦点在取消。
- 窗口缩放不遮挡录音状态或主操作；窄窗口不把会议库和转写同时挤在画布旁。
- 所有控件有悬停、焦点、按下、禁用和加载/失败状态；错误不泄露路径、凭据或传输细节。

## 不做

- 不做暗色主题；系统深色不切换整个世界。
- 不做渐变文字、发光描边文字或玻璃套玻璃。
- 不用紫色/薰衣草做大面积主色；卡片色调只取蓝、薄荷、桃、玫红、沙金。
- 不把卡片做成随机彩虹；颜色必须对应内容类型。
- 不给静止内容加浮动动画；不做滚动视差、自动轮播或页面载入编排。
- 不发明实时字幕、暂停、波形或假的“AI 正在思考”状态。
- 不在界面里写使用说明、辅助标签或快捷键提示；不用大卡片和引导文案填充空画布。