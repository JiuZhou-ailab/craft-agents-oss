# Services

RPC 与会话边界之下可复用的服务。

- `attachment-storage.ts` — 保存不可变附件原件与派生表示。
- `git-bash.ts` — 在 Windows 上解析 Git Bash。
- `image-utils.ts` / `image-utils.test.ts` — 检查并缩放图像。
- `privileged-execution-broker.ts` — 管理高权限命令执行。
- `search.ts` / `search.test.ts` — 执行有边界、可取消的 workspace 搜索；等待两路 ripgrep 子进程退出并清理监听器。
- `vcredist.ts` / `vcredist.test.ts` — 检查 Visual C++ 运行库。
- `workspace-version-control.ts` — 通过独立 index 与 `refs/storyflow/*` 提供不侵入用户 Git 状态的 workspace 版本控制。
- `views-storage.ts` / `views-storage.test.ts` — workspace `views.json` 的持久化、默认视图种子、smartLabels 迁移与 Project 路径边界验证。
