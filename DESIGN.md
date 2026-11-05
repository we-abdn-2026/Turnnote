---
name: Turnnote
description: 安静的工作台：石墨外壳、近白纸面、系统无衬线；纪要可以回到原话核对，界面不表演。
colors:
  sidebar: "oklch(0.955 0.004 95)"
  paper: "oklch(0.985 0.0025 95)"
  sheet: "oklch(0.998 0.001 95)"
  hover: "oklch(0.93 0.004 95)"
  selected: "oklch(0.9 0.006 95)"
  rule: "oklch(0.905 0.003 95)"
  rule-strong: "oklch(0.8 0.005 95)"
  ink: "oklch(0.225 0.004 95)"
  ink-2: "oklch(0.43 0.005 95)"
  ink-3: "oklch(0.535 0.005 95)"
  accent: "oklch(0.535 0.16 255)"
  accent-ink: "oklch(0.48 0.17 255)"
  accent-wash: "oklch(0.94 0.028 255)"
  rec: "oklch(0.56 0.21 27)"
  warn: "oklch(0.5 0.105 62)"
  warn-wash: "oklch(0.955 0.03 80)"
typography:
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, PingFang SC, Hiragino Sans GB, Microsoft YaHei UI, system-ui, sans-serif"
    fontSize: "26px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, PingFang SC, Hiragino Sans GB, Microsoft YaHei UI, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.4
  large:
    fontFamily: "-apple-system, BlinkMacSystemFont, PingFang SC, Hiragino Sans GB, Microsoft YaHei UI, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: 1.3
  title-sm:
    fontFamily: "-apple-system, BlinkMacSystemFont, PingFang SC, Hiragino Sans GB, Microsoft YaHei UI, system-ui, sans-serif"
    fontSize: "24px"
    fontWeight: 600
    lineHeight: 1.2
  timer:
    fontFamily: "ui-monospace, SF Mono, Cascadia Mono, Segoe UI Mono, Menlo, Consolas, monospace"
    fontSize: "40px"
    fontWeight: 500
    lineHeight: 1
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, PingFang SC, Hiragino Sans GB, Microsoft YaHei UI, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.75
  ui:
    fontFamily: "-apple-system, BlinkMacSystemFont, PingFang SC, Hiragino Sans GB, Microsoft YaHei UI, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  small:
    fontFamily: "-apple-system, BlinkMacSystemFont, PingFang SC, Hiragino Sans GB, Microsoft YaHei UI, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, PingFang SC, Hiragino Sans GB, Microsoft YaHei UI, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1.5
  timecode:
    fontFamily: "ui-monospace, SF Mono, Cascadia Mono, Segoe UI Mono, Menlo, Consolas, monospace"
    fontSize: "11px"
    fontWeight: 400
    fontFeature: "tabular-nums slashed-zero"
rounded:
  s: "4px"
  m: "8px"
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
    backgroundColor: "{colors.accent}"
    textColor: "oklch(0.99 0.004 255)"
    rounded: "{rounded.s}"
    padding: "0 12px"
    height: "30px"
  button-default:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    border: "1px solid {colors.rule-strong}"
    rounded: "{rounded.s}"
    height: "30px"
  button-record:
    backgroundColor: "oklch(0.235 0.004 95)"
    textColor: "{colors.paper}"
    rounded: "{rounded.s}"
    height: "30px"
  field:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    border: "1px solid {colors.rule-strong}"
    rounded: "{rounded.s}"
    height: "30px"
  source-cue:
    backgroundColor: "{colors.accent-wash}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.s}"
    height: "20px"
  dock:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    height: "40px"
---

# Turnnote 设计系统

Turnnote 是一个桌面会议工作台，不是一张网页。视觉世界是**安静的工作台**：石墨色的窗框、近白的纸面、1px 发丝线、系统无衬线，时间码用等宽。界面退后，纪要、转写和录音状态说话。

参考的气质是 Linear / Raycast 的桌面密度、Notion 的阅读秩序、Granola 的会议专注；不复刻它们的皮肤，也不把网页的营销布局塞进窗口。旧版“暖纸面 + 衬线 + 纸纹”的世界已整体替换，不再作为默认。

## 设计原则

1. **桌面优先。** 44px 标题栏、240px 会议库、340px 转写抽屉；窗口缩放时结构变化，不靠流体字号。
2. **可扫描的密度。** UI 13px、列表 32px 行高、按钮 30px；正文 15px / 1.75，行宽 36rem（约 70–75 字符）。
3. **一个强调色。** 信号蓝只给主操作、焦点、当前定位、来源时间码和进度。
4. **红色只属于正在录音。** 录音红点、录音图标；错误和破坏性动作用赭石。
5. **平放。** 静止的内容面没有阴影、纸纹或渐变；阴影只给会浮起来的东西：录音条、对话框、设置面板、提示。
6. **诚实。** 没有实时字幕、暂停或波形，就不画出来；界面显示真实状态，未实现就是未实现。

## 色彩

浅色是主场景（白天、办公室、会议中），深色跟随系统并同等完整。

| 角色 | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `--sidebar` | `oklch(0.955 0.004 95)` | `oklch(0.15 0.003 95)` | 会议库、转写抽屉、标题栏 |
| `--paper` | `oklch(0.985 0.0025 95)` | `oklch(0.185 0.003 95)` | 文档画布、设置面板 |
| `--sheet` | `oklch(0.998 0.001 95)` | `oklch(0.21 0.003 95)` | 输入框、按钮、浮层 |
| `--ink` | `oklch(0.225 0.004 95)` | `oklch(0.94 0.002 95)` | 正文、标题 |
| `--ink-2` | `oklch(0.43 0.005 95)` | `oklch(0.75 0.003 95)` | 次要文字 |
| `--ink-3` | `oklch(0.535 0.005 95)` | `oklch(0.63 0.003 95)` | 元信息、占位、弱化 |
| `--accent` | `oklch(0.535 0.16 255)` | `oklch(0.72 0.13 255)` | 主操作、焦点、当前项 |
| `--rec` | `oklch(0.56 0.21 27)` | `oklch(0.68 0.2 28)` | 正在录音 |
| `--warn` | `oklch(0.5 0.105 62)` | `oklch(0.78 0.11 70)` | 故障、权限、破坏性确认 |

对比度（相对 `--paper`）：浅色 `--ink` 16.4:1、`--ink-2` 7.8:1、`--ink-3` 4.9:1；深色分别为 15.6:1、8.4:1、5.3:1。`--ink-3` 也满足 `--sidebar` 上的 4.5:1。新增颜色先写进 `tokens.css` 并实测。

## 字体

只有一个界面家族：系统无衬线（macOS 上实际是 SF / PingFang SC）。纪要正文、标题、按钮、设置全部用它；等宽只用于时间码、模型标识和版本号，不用来“显得技术”。

- 标题 26px / 600 / 1.2，窄窗口降到 24px；空态标题 20px；录音计时 40px 等宽 / 500。
- 纪要章节 14px / 600；正文 15px / 1.75。
- UI 13px，辅助 12px，元信息 11px；字重只用 400 / 500 / 600。
- 中文断行用 `line-break: strict`；标题 `text-wrap: balance`，正文 `text-wrap: pretty`。
- 行宽 `--measure: 36rem`；不允许为了填满窗口拉宽正文。

## 布局

- 标题栏 44px，整窗拖动区；macOS 左侧让出 84px 红绿灯位，Windows/Linux 右侧让出 152px 窗口控件。左侧是产品名，右侧只有会议库/转写/设置。
- 会议库 240px（可拖 220–320px，双击复位 240）。顶部分两行：新建会议输入 + 加号、搜索。列表按日期分组，行高 32px，当前项是面纸底 + 1px 内描边，不用左侧色条。
- 画布：文档列最大 `36rem + 96px`，内边距 40px 48px 80px；整窗不滚动，画布和抽屉各自滚动。
- 转写抽屉 340px，右侧发丝线；宽度 0↔340ms 过渡，收起时 `inert`。
- 录音条：画布底部 sticky 的 40px 胶囊，距底 16px；底部有一层纸色渐隐，避免正文从按钮缝里穿过去。
- 断点：< 1100px 会议库变抽屉（宽 min(300px, 86vw)）；< 900px 转写抽屉替代画布，文档边距 20px。

## 组件

- **按钮**：30px 高、4px 圆角、1px 强线、12.5px/500。主操作信号蓝实心；录音操作墨色实心 + 红点；次级透明底或 1px 描边；危险动作悬停赭石。图标按钮 30px 方形，提示用 `data-tip` 自绘。
- **输入**：30px 高，面纸底，1px 线；聚焦 2px 信号蓝淡底环。标题输入 26px / 600。
- **开关**：28×16 胶囊，右侧永远有“开 / 关”二字；原生复选框保留语义。
- **关注词**：24px 小标签，4px 圆角；末尾是虚线“+ 关键词”输入槽。
- **来源时间码**：20px 高、等宽 11px、信号蓝淡底；悬停翻成信号蓝实底；点击定位转写并高亮整行。
- **纪要条**：上方发丝线，来源 / 版本 / 编辑 / 导出 / 重新生成；操作是 26px 高的透明按钮，悬停才出面。
- **录音条**：红点 + “正在录音” + 等宽计时 + 停止；保存中显示“录音已结束，等待保存”。新会议录音时，画布中央显示 40px 等宽计时和一句“停止后会在本机转写”。
- **转写抽屉**：头部 44px；行是 60px 时间列 + 16px 间距 + 正文，13px / 1.65；悬停行淡底，定位行信号蓝淡底。
- **对话框**：440px，8px 圆角，面纸底，Float 阴影；危险确认的初始焦点在“取消”，肯定确认在主操作；没有指定初始焦点时焦点落在对话框本身，不落在关闭按钮上。
- **设置**：右侧整高面板 420px，分组用 11px 大写标签；服务商行、Key 状态、模型、语言；关闭按钮 26px。
- **提示**：自绘，墨色实底，11px，450ms 延迟；禁用控件也显示理由。
- **Toast**：底部居中的墨色胶囊，3 秒；故障不用 Toast，用顶部横幅。

## 动效

- 120ms（悬停、焦点）、180ms（抽屉、浮层）、240ms（转写列宽）。
- 只表达状态：录音点呼吸、进度扫过、转写定位淡出、对话框进场。
- 没有页面载入编排、滚动显现、视差或逐段淡入。
- `prefers-reduced-motion: reduce` 下全部压到 1ms，内容必须直接可见。

## 桌面行为

- 快捷键：⌘/Ctrl+K 搜索，⌘/Ctrl+N 新建，⌘/Ctrl+\ 会议库，⌘/Ctrl+J 转写，⌘/Ctrl+, 设置。
- 录音中不能新建或切换会议；会给出原因，不静默禁用。
- 设置、删除、丢弃、外发转写都必须用原生 `<dialog>`；Escape 关闭，焦点归还打开者。
- 窗口缩放不遮挡录音状态或主操作；窄窗口不把会议库和转写同时挤在画布旁。
- 所有控件有默认、悬停、焦点、按下、禁用、加载/失败状态；失败信息不泄露路径、凭据或传输细节。

## 不做

- 不用衬线正文、纸纹、渐变文字、玻璃拟态、彩色左边条、硬偏移阴影。
- 不用卡片堆叠当页面结构；不嵌套卡片。
- 不用 `#000` / `#fff`；中性色带 95 的暖调。
- 不把信号蓝做成大面积填充或装饰；不给静止面加阴影。
- 不发明实时字幕、暂停、波形或“AI 正在思考”的假状态。
- 不把网页落地页的 hero、图片区、营销节奏搬进桌面窗口。