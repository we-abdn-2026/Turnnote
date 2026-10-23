# 安装资源与原生模块

Issue #40 复用 #14、#38 和 #39 的现有打包链路，不增加第二套重编译机制。
`electron-builder.yml` 通过 `extraResources` 把 PyInstaller `onedir` 目录完整复制到
安装应用的 `resources/asr-worker/`，并显式启用 `npmRebuild: true` 和
`nativeRebuilder: sequential`。构建必须在目标 OS 和架构上运行。

## 路径边界

开发环境由 Main 从 `app.getAppPath()` 解析
`services/asr-worker/worker.py`，Python 按 `TURNNOTE_PYTHON`、项目 `.venv`、系统命令的
顺序选择。安装环境只从 `process.resourcesPath` 解析：

| 平台 | 安装资源相对路径 |
| --- | --- |
| macOS | `asr-worker/asr-worker` |
| Windows | `asr-worker/asr-worker.exe` |

正式会话和安装自检共用 `resolvePackagedSidecarPath`，Renderer 不能提供可执行文件路径。
模型与用户数据不属于 `extraResources`；模型存放在 `userData/models/<model>/`，会议数据
存放在 Electron `userData` 目录。

## 原生模块

`better-sqlite3` 是生产依赖。`electron-builder` 在每个目标 runner 上使用
`@electron/rebuild` 的顺序模式，按该构建使用的 Electron 版本和目标架构准备原生模块；
不使用宿主 Node.js 的加载结果代替安装包验收。

构建前的 `npm run test:electron` 在 Electron Node 运行时加载数据库、执行迁移并验证持久化。
安装后，应用的 `--packaging-smoke` 模式再次从安装内容加载 `better-sqlite3`、执行
`SELECT 1`，然后从 `resources/asr-worker/` 启动 sidecar 并等待严格的 `pong`。

## 诊断与报告

自检报告写入指定的 Electron `userData/packaging-validation.json`，只记录平台、架构、
Electron 版本、Node modules ABI、SQLite/sidecar 状态和 sidecar 相对资源路径。报告不记录
安装目录、用户数据目录、会议内容或子进程原始错误输出。

原生 CI 会临时移走安装后的 sidecar，确认相同门禁以退出码 1 拒绝缺失资源，同时仍能
加载 SQLite；恢复资源后再验证成功路径。macOS arm64 和 Windows x64 均上传安装包、
正常报告和负向报告。包内容检查还会拒绝开发依赖及常见私人配置文件。

## 复现命令

```bash
npm ci
npm run test:electron
npm run package:mac:arm64   # Apple Silicon macOS
npm run package:win:x64     # Windows x64
```

构建后在对应平台检查未安装目录：

```bash
node scripts/verify-package-contents.mjs dist-packaging/mac-arm64/Turnnote.app
node scripts/verify-package-contents.mjs dist-packaging/win-unpacked
```

最终证据以 PR 对应 revision 的 `Packaging validation` 日志和 artifact 为准；另一平台的
产物必须由该平台的原生 runner 构建，不能交叉复制或用 mock 代替。
