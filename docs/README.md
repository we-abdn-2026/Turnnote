# Turnnote 技术文档

文档按职责拆分，避免产品提案、系统架构和开发操作互相替代。

## 产品和架构

- [项目 Proposal](../proposal.md)：产品目标、MVP 范围、时间线和行动计划
- [技术方案](technical-solution.md)：技术选型、职责边界、数据、安全、降级和验证范围
- [系统架构图](architecture.md)：系统组件和数据流示意图
- [开发路线图](roadmap.md)：Phase 3–6 开发计划、模块分工，按前端、后端、测试、部署分类

## 实现契约

- [W1 IPC 契约基线](ipc-contract.md)：接口冻结候选、状态与取消、任务身份、事务边界、当前实现范围
- [数据库 Schema](database-schema.md)：表结构、索引、状态机、崩溃恢复
- [Sidecar 协议](sidecar-protocol.md)：Python 转写进程通信协议
- [Platform Audio 接口](platform-audio.md)：跨平台音频采集统一接口
- [纪要生成](note-generation.md)：DeepSeek 请求、prompt 与输出校验、长转写分段合并、关键词引导和来源时间

## 工程操作

- [工程说明](development.md)：目录结构、环境要求、命令和实现约束
- [打包验证与 electron-builder 交付核对](packaging-validation.md)：#14 的安装证据、#38 的内容检查和剩余平台任务
- [三平台打包矩阵](packaging-matrix.md)：#41 的 macOS arm64、macOS x64、Windows x64 原生 CI 和产物保留规则
- [安全诊断日志](safe-logging.md)：日志位置、可分享字段和凭证、路径、会议正文的隐私边界
- [安装资源与原生模块](native-packaging.md)：#40 的 `extraResources` 路径、Electron 原生模块重编译和故障诊断
- [Sidecar 打包与真实模型验证](sidecar-packaging.md)：#39 的 onedir 依赖、模型边界和原生平台验收
