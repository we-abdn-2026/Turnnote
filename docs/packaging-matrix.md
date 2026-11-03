# 三平台打包矩阵

Issue #41 在 #14 的 macOS arm64、Windows x64 基线上增加 macOS Intel x64。三个目标
分别在对应原生 GitHub-hosted runner 上运行 PyInstaller 和 electron-builder，不复用其他
架构生成的 sidecar 或原生模块。当前 runner 标签以
[GitHub-hosted runners 官方列表](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
为准。

| CI job | runner | 目标 | 构建命令 | artifact |
| --- | --- | --- | --- | --- |
| `macos-arm64` | `macos-15` | macOS arm64 | `npm run package:mac:arm64` | `turnnote-macos-arm64` |
| `macos-x64` | `macos-15-intel` | macOS x64 | `npm run package:mac:x64` | `turnnote-macos-x64` |
| `windows-x64` | `windows-latest` | Windows x64 | `npm run package:win:x64` | `turnnote-windows-x64` |

安装包文件名固定为：

- `Turnnote-0.1.0-macos-arm64.dmg`
- `Turnnote-0.1.0-macos-x64.dmg`
- `Turnnote-0.1.0-windows-x64.exe`

版本号来自 `package.json`；上表展示当前 `0.1.0` 对应名称。每个 artifact 保留 14 天，
包含该平台安装包、sidecar 构建内容、正常与缺失 sidecar 的 `packaging-validation.json`
报告，以及真实小模型转写验证报告。macOS Intel 依赖 `onnxruntime 1.21.0` 的
universal2 wheel；其他目标保留 `1.30.0`，版本按平台在 `requirements.txt` 中固定。
失败时 GitHub Actions job 和具体步骤日志仍可定位；同一 PR 的新提交会取消旧的
打包运行，避免把旧 revision 的产物误当作最新结果。

## 验收边界

构建步骤只生成未签名的测试安装包。后续安装步骤从 DMG 或 NSIS 安装副本启动应用，
再验证 SQLite 和 sidecar；两类结果在 Actions 中分步骤记录。工作流只有 `contents: read`
权限，不读取 API Key，不上传用户会议数据、本地模型凭证或开发机目录，也不会创建
GitHub Release。

三目标最终验收必须引用同一 PR revision 的三个成功 job 和三个可下载 artifact。
#39 的真实 sidecar、#40 的资源与原生模块门禁，以及 #79 的固定安全错误码已经进入
`dev`。本分支在该基线上增加三平台矩阵；最终验收必须使用当前 head 的运行和产物，
不能沿用整合前 revision 的成功结果。
