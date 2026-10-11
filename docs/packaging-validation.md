# 打包可行性验证

本文记录 Issue #14 的空壳打包验证。它不是正式发布说明；正式打包配置仍由后续
`electron-builder`、PyInstaller 和 CI 任务完善。

## 本地验证结果

| 日期 | 平台 | 安装包 | 启动 | SQLite | Sidecar ping |
|---|---|---|---|---|---|
| 2026-10-11 | macOS 26.6.2 arm64 | 通过 | 通过 | 通过 | 通过 |
| 待验证 | Windows x64 | 待在 Windows x64/runner 构建 | 待验证 | 待验证 | 待验证 |

macOS arm64 产物：`dist-packaging/Turnnote-0.1.0-arm64.dmg`（约 143 MB）。
可提交的详细验证记录见
[`packaging-validation/macos-arm64-2026-10-11.json`](packaging-validation/macos-arm64-2026-10-11.json)。

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

## 当前限制

- 本地 sidecar 使用 Python 3.14.5、PyInstaller 6.22.3 构建并验证成功；仓库指定
  Python 3.12，CI/正式打包仍应在 3.12 上复验。
- 当前安装包未签名，使用 Electron 默认图标，只用于可行性验证。
- 当前 `worker.py` 只验证协议和 `ping`；它尚未包含正式 faster-whisper 推理实现。
- Windows x64 不能由本机 arm64 构建后冒充已验证，必须由 Windows runner 补齐安装、
  启动、SQLite 和 sidecar 日志。
- macOS x64 明确不属于 Issue #14 的交付或验收范围。
