# 打包可行性验证

本文记录 Issue #14 的安装包可行性验证。仓库已提供 `electron-builder`、PyInstaller
和原生双平台 CI；当前安装包用于验证，不作为正式签名发布。

## 验证结果

| 日期 | 平台 | 安装包 | 启动 | SQLite | Sidecar ping |
|---|---|---|---|---|---|
| 2026-10-11 | macOS 26.6.2 arm64 | 通过 | 通过 | 通过 | 通过 |
| 2026-10-11 | Windows x64（GitHub runner） | 通过 | 通过 | 通过 | 通过 |

macOS arm64 产物：`dist-packaging/Turnnote-0.1.0-arm64.dmg`（约 143 MB）。
可提交的详细验证记录见
[`packaging-validation/macos-arm64-2026-10-11.json`](packaging-validation/macos-arm64-2026-10-11.json)。
Windows x64 由 GitHub Actions 原生 runner 构建、静默安装并运行相同自检，安装包和
报告保存在对应 workflow run 的 `turnnote-windows-x64` artifact 中。

已有双平台 CI 证据：
[`38152507798`](https://github.com/we-abdn-2026/Turnnote/actions/runs/38152507798)，
对应 PR revision `1e4d7d7`。它证明该版本可安装和启动，不替代后续修改的验收。
本次收尾同步 `dev@51e5c3d`（包含 #71 的采集与转写集成），最终版本以 PR #68
最新 `Packaging validation` 检查及其日志、artifact 为准。

2026-10-12 收尾修复 `c5c5d49` 的原生复验已通过：
[`38200988043`](https://github.com/we-abdn-2026/Turnnote/actions/runs/38200988043)，
测试合并快照 `4003352`，基线为 `51e5c3d`。

| 平台 | 安装与自检日志 | 安装包及报告 | 结果 |
| --- | --- | --- | --- |
| macOS arm64 | [DMG 安装 job](https://github.com/we-abdn-2026/Turnnote/actions/runs/38200988043/job/114654140055) | [DMG 与报告](https://github.com/we-abdn-2026/Turnnote/actions/runs/38200988043/artifacts/11725142598) | `darwin/arm64`，SQLite、sidecar 均 `ok` |
| Windows x64 | [NSIS 安装 job](https://github.com/we-abdn-2026/Turnnote/actions/runs/38200988043/job/114654139968) | [NSIS 与两份报告](https://github.com/we-abdn-2026/Turnnote/actions/runs/38200988043/artifacts/11725961274) | 正常 `win32/x64`、SQLite/sidecar 均 `ok`；缺失 worker 时退出码 1、SQLite `ok`、sidecar `failed` |

同 revision 的 [常规 CI](https://github.com/we-abdn-2026/Turnnote/actions/runs/38200988050)
也已通过，测试为 245 项通过、2 项跳过。原生打包使用 Python 3.12.10、
PyInstaller 6.22.3 和 Electron 44.4.5。以上链接固定对应该修复 revision；后续文档
回填不改变安装实现，但仍应确认最新 head 的全部检查通过。

验证时从 DMG 复制出 `Turnnote.app` 后运行打包自检。结果如下：

```json
{
  "platform": "darwin",
  "architecture": "arm64",
  "sqlite": "ok",
  "sidecar": "ok"
}
```

自检会加载 `better-sqlite3`、执行 `SELECT 1`，再启动安装包资源目录中的
`asr-worker` 并在 10 秒内等待 `pong`。完整日志写入 Electron 的 user data 目录下
`packaging-validation.json`。

探针严格检查响应的 job id、`type=pong` 和 `status=ok`，限制输出为 64 KiB，
并在成功或失败后等待子进程关闭；拒绝退出的 worker 在 1 秒后被强制终止。
提前退出、损坏响应、超时和缺失 sidecar 均返回失败，不输出 worker 原始错误内容。
自检模式在采集与转写服务注册前执行，避免安装验证触发采集初始化。

## 构建命令

```bash
npm run package:mac:arm64
npm run package:win:x64
```

两个命令都会先检查宿主平台和架构。PyInstaller 不支持交叉编译，因此：

- macOS arm64 必须在 Apple Silicon Mac 上构建；
- Windows x64 必须在 Windows x64 或对应原生 runner 上构建。

Pull request 中涉及打包文件的改动会触发 `Packaging validation` workflow。它在
`macos-15` 和 `windows-latest` runner 上分别构建安装包，从 DMG/NSIS 安装后运行相同
自检，并上传安装包和 `packaging-validation.json`。只有 workflow 实际通过后，才能把
CI 结果记录为“通过”。

macOS 会检查进程退出码和报告中的 `darwin`、`arm64`、SQLite、sidecar 状态。
Windows 使用 `scripts/validate-installed-package.ps1`，通过
`Start-Process -Wait -PassThru` 检查安装器和应用退出码，并断言 `win32`、`x64`、
SQLite 与 sidecar 均成功；不依赖 GUI 可执行文件的 `$LASTEXITCODE`。

Windows 先临时移走安装目录的真实 `asr-worker.exe`，调用与正常验证相同的门禁，
确认它因应用退出码 1 而拒绝失败，同时验证报告中 SQLite 成功、sidecar 失败。
`finally` 恢复 worker 后再进行正常验收。用户数据路径特意包含空格，验证参数引用。
Windows artifact 同时保留正常和负向报告；两平台即使验证失败也尝试上传已生成产物。

## 当前限制

- 本地 sidecar 使用 Python 3.14.5、PyInstaller 6.22.3 构建并验证成功；GitHub
  Actions 已按仓库指定的 Python 3.12 完成 macOS arm64 和 Windows x64 复验。
- 当前安装包未签名，使用 Electron 默认图标，只用于可行性验证。
- 本次打包自检只验证 sidecar 的 `ping`，不代表真实 faster-whisper 模型推理已经通过。
- Windows x64 不能由本机 arm64 构建后冒充已验证；Windows runner 负责构建、安装、
  启动并检查 SQLite、sidecar 和自检报告。
- macOS x64 明确不属于 Issue #14 的交付或验收范围。

## Issue #38：electron-builder 交付核对

#14 已建立 DMG/NSIS 的构建和安装自检基线；#38 复用这些安装包，核对
`electron-builder` 配置、应用入口和安装内容，不另建一套打包方案。

| #38 验收项 | 当前依据 | 尚需确认 |
| --- | --- | --- |
| DMG/NSIS、应用标识及入口 | `electron-builder.yml` 指定 `uk.ac.abdn.turnnote`、Turnnote、DMG/NSIS；`package.json` 指定 `out/main/index.js` | PR 检查通过 |
| 目标平台构建、安装、启动 | 上方 #14 的 macOS arm64 / Windows x64 原生安装与自检日志及产物 | 本 PR 的原生打包检查通过 |
| 开发依赖、私人配置不进入应用包 | `scripts/verify-package-contents.mjs` 检查 `app.asar`、解包原生模块和资源目录；macOS arm64 本地安装包检查通过 | Windows x64 由本 PR 的原生检查确认 |
| 可复现命令和产物 | 下方命令；DMG/NSIS 与验证报告由 `Packaging validation` workflow 上传 | PR 附最终 revision 的运行链接 |

检查已打包应用内容：

```bash
node scripts/verify-package-contents.mjs dist-packaging/mac-arm64/Turnnote.app
node scripts/verify-package-contents.mjs dist-packaging/win-unpacked
```

两条命令分别在对应平台执行，位于 `npm run package:mac:arm64` 或
`npm run package:win:x64` 之后。脚本检查安装包里的名称、版本、入口文件，
只允许应用代码、生产依赖和 `package.json` 进入应用归档；递归检查归档外的
sidecar 等资源目录。归档内发现开发依赖或意外顶层目录，以及任意位置发现
常见私人配置文件时，检查都会失败。它检查文件路径，不能证明编译进代码里的
内容没有秘密，因此仍须遵守仓库的凭证管理要求。

#38 的边界是 Electron 安装包配置。真实 faster-whisper 模型与 sidecar 分发由 #39
验收；#40 的资源路径、原生模块重编译和故障报告见
[安装资源与原生模块](native-packaging.md)；macOS x64 及三平台矩阵由 #41 验收。
当前包仍未签名，不作为正式 Release 发布。
