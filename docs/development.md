# Turnnote 工程说明

## 目录结构

```text
Turnnote/
├── .github/                # CI、issue 和 PR 模板、CODEOWNERS
├── apps/
│   └── desktop/
│       ├── main/           # Electron Main / Node.js
│       ├── preload/        # 安全 IPC bridge
│       └── renderer/       # React + TypeScript
│           └── mock/       # dev:web 使用的内存 API
├── packages/
│   └── contracts/          # 跨进程共享类型和 IPC 通道
├── services/
│   └── asr-worker/         # Python faster-whisper sidecar
├── tests/                  # Node 测试；support/ 为测试工具
├── docs/                   # 技术文档
├── requirements.in         # Python 直接依赖
├── requirements.txt        # Python 锁定依赖（生成文件）
└── requirements-dev.txt    # Python 开发工具
```

## 环境要求

| 工具 | 版本 | 来源 |
|---|---|---|
| Node.js | 24 | `.nvmrc` |
| npm | 11 | 随 Node.js |
| Python | 3.12 | `.python-version` |

## 初始化

```bash
nvm use
npm install
python3.12 -m venv .venv
source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt -r requirements-dev.txt
```

`npm install` 会下载 Electron 二进制。下载失败时 `npm run dev` 无法启动，重新执行 `node node_modules/electron/install.js`。

## 命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | 启动 Electron 应用 |
| `npm run dev:web` | 浏览器中运行 Renderer，使用 mock API，不需要 Electron 和 Python |
| `npm run lint` | ESLint、Prettier、ruff 检查 |
| `npm run format` | 自动修复格式 |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm run test` | Node 测试 |
| `npm run build` | 构建到 `out/` |

`npm run lint` 和 `npm run format` 需要先激活 `.venv`。

测试中的 Python 解释器按顺序选择：环境变量 `TURNNOTE_PYTHON`、`.venv`、系统 `python3`。

## 更新依赖

- npm：`npm install --save-exact <package>@<version>`
- Python：修改 `requirements.in`，然后重新生成锁定文件：

```bash
uv pip compile requirements.in --universal --python-version 3.12 -o requirements.txt
```

## 协作流程

1. 用 issue 模板创建任务，设置 Milestone。
2. 从 `dev` 创建分支：`feat/*`、`fix/*`、`docs/*`、`chore/*`、`test/*`。
3. Commit 格式：`type(scope): 描述`，如 `feat(storage): 新增会议表迁移`。
4. PR 目标分支为 `dev`，关联 issue，按模板填写。
5. 合并条件：CI `check` 通过、至少 1 人批准、所有 Code Owner 批准。
6. `feature → dev` 使用 squash 合并；`dev → main` 使用 merge commit，只在里程碑发布时进行。

`main` 和 `dev` 禁止直接推送和强制推送。

## 实现约束

1. UI 通过 Preload IPC 调用 Main，不直接使用 Node.js 能力。
2. Main 负责本地副作用和状态迁移，Renderer 不拥有业务状态真相。
3. Python sidecar 只通过 JSON Lines 处理转写，不访问数据库、凭证和 DeepSeek。
4. 共享类型和 schema 放在 `packages/contracts`，禁止在多个进程重复定义协议。
5. 失败任务必须保留可恢复数据，不得用静默清理掩盖错误。
6. 新增 IPC 方法：在 `packages/contracts` 添加类型和 `invokeChannels`，Main 通过 `registerIpc` 实现，同步更新 `renderer/mock/mock-api.ts`。Preload 自动暴露。
