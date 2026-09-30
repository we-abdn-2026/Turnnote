# Turnnote 工程说明

## 目录结构

```text
Turnnote/
├── apps/
│   └── desktop/
│       ├── main/           # Electron Main / Node.js
│       ├── preload/        # 安全 IPC bridge
│       └── renderer/       # React + TypeScript
├── packages/
│   └── contracts/          # 跨进程共享类型和 schema
├── services/
│   └── asr-worker/         # Python faster-whisper sidecar
├── tests/                  # Node/Python 协议、单元和集成测试
├── docs/                   # 技术文档
├── package.json
├── tsconfig.json
└── requirements.txt
```

## 环境要求

- Node.js 22 或更高版本；
- npm 11 或更高版本；
- Python 3.12 或更高版本；
- macOS 或 Windows 的平台音频开发环境；
- Python `faster-whisper` 及其运行时依赖。

## 初始化

```bash
npm install
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Windows 使用 `.venv\\Scripts\\activate` 激活 Python 环境。

## 工程命令

```bash
npm run typecheck
npm run test
npm run build
```

## 实现约束

1. UI 通过 Preload IPC 调用 Main，不直接使用 Node.js 能力。
2. Main 负责本地副作用和状态迁移，Renderer 不拥有业务状态真相。
3. Python sidecar 只通过 JSON Lines 处理转写，不访问数据库、凭证和 DeepSeek。
4. 共享类型和 schema 放在 `packages/contracts`，禁止在多个进程重复定义协议。
5. 失败任务必须保留可恢复数据，不得用静默清理掩盖错误。
