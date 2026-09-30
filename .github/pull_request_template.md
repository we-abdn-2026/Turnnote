## 关联 Issue

Closes #

## 改动内容

<!-- 做了什么、为什么这样做。只写审阅者需要知道的内容。 -->

## 所属分组

- [ ] 前端
- [ ] 后端
- [ ] 测试
- [ ] 部署

## 契约影响

- [ ] 无契约变更
- [ ] `packages/contracts` 类型变更，已同步所有调用方
- [ ] Sidecar 协议变更，已同步 `docs/sidecar-protocol.md` 和测试
- [ ] 数据库 schema 变更，已新增 migration 并同步 `docs/database-schema.md`
- [ ] IPC 通道变更，已同步 Main 和 Preload

## 验证

- [ ] `npm run typecheck`
- [ ] `npm run test`
- [ ] `npm run build`
- [ ] macOS 手动验证
- [ ] Windows 手动验证

<!-- 写明手动验证的步骤和结果；未验证的平台说明原因。 -->

## 安全检查

- [ ] 未提交 API Key、`.env` 或本地数据库
- [ ] 日志不输出凭证、完整转写和完整纪要正文
- [ ] Renderer 未直接访问 Node.js、文件系统或网络

## 截图

<!-- 界面改动附截图，无则删除本节。 -->
