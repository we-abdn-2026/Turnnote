# Sidecar 打包与真实模型验证

Issue #39 在 #14 的 PyInstaller `onedir` 基线上交付真实 ASR 运行时。`requirements.txt`
锁定 `faster-whisper`、PyAV、CTranslate2、ONNX Runtime 等运行依赖；打包前同时安装
`requirements.txt` 和 `requirements-dev.txt`。`scripts/build-sidecar.mjs` 在缺少运行依赖时
直接失败，并收集 `faster_whisper` 的数据文件。PyInstaller 必须在目标 OS 和架构上运行，
不能用 macOS 的二进制代替 Windows 产物。

## 构建与启动路径

```bash
python3.12 -m venv .venv
# macOS: source .venv/bin/activate；Windows: .venv\Scripts\activate
pip install -r requirements.txt -r requirements-dev.txt
npm run build:sidecar
```

产物在 `build/sidecar/asr-worker/`：macOS 入口为 `asr-worker`，Windows 入口为
`asr-worker.exe`，相邻 `_internal/` 保存冻结运行时和原生库。`electron-builder.yml` 把整个
目录复制到安装应用的 `resources/asr-worker/`；Main 通过
`process.resourcesPath/asr-worker/asr-worker[.exe]` 启动，不调用系统 Python。
若显式设置 `PYINSTALLER` 使用其他环境的 PyInstaller，也须用
`TURNNOTE_PACKAGING_PYTHON` 指向同一环境的 Python。

## 模型边界与验收

模型**不放入 PyInstaller 产物或安装包**。正式运行时，Main 将设置中的模型名称解析为
`userData/models/<model>/`，把绝对目录传给 sidecar；sidecar 要求本地目录至少含
`model.bin`、`config.json`、`tokenizer.json`，并以 `local_files_only=True` 加载。
当前 Main 尚无模型下载实现，因此真实运行前必须单独准备该目录；fake 模式仍可用于
不需要模型的 CI 和开发验证。

原生打包 CI 使用单独下载的
[`Systran/faster-whisper-tiny`](https://huggingface.co/Systran/faster-whisper-tiny/tree/d90ca5fe260221311c53c58e660288d3deb8d356)
固定 revision `d90ca5fe260221311c53c58e660288d3deb8d356`。下载仅供验收，不复制到
安装包或上传为产物。安装后，验证脚本把 worker 放在不含 Python 的 `PATH` 下运行，
检查 ping、fake 转写，以及用 `tests/fixtures/sample-en.wav` 和本地 tiny 模型完成真实
转写。报告只记录平台、成功状态、语言、时长和片段数，不保存音频或转写文本。

本机复现：

```bash
python scripts/prepare-asr-validation-model.py build/validation-model
python scripts/validate-bundled-sidecar.py \
  --worker build/sidecar/asr-worker/asr-worker \
  --model build/validation-model \
  --audio tests/fixtures/sample-en.wav \
  --report build/sidecar-validation.json
```

Windows 将 `--worker` 改为 `build/sidecar/asr-worker/asr-worker.exe`。需要网络的只有
事先下载模型的步骤；sidecar 的真实推理仅使用本地模型。CI 在 macOS arm64 和 Windows
x64 原生 runner 构建安装包、从安装副本运行验证，并上传安装包、独立 onedir worker、
安装自检报告和 ASR 验证报告。macOS x64、模型自动下载、签名和正式发布不属于本任务。
