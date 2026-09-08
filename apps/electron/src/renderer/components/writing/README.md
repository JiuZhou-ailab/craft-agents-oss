# Writing Editor

在通用项目文件树之上提供 Markdown 编辑、选区操作、版本历史和兼容旧写作文件的展示标签；不拥有项目创建或目录结构。

- `NovelDocumentEditorPanel.tsx`：Markdown 编辑与文件级 diff 审阅；调用方按正文读取状态控制可编辑性。
- `NovelVersionHistoryDialog.tsx`：项目本地版本列表与恢复。
- `novel-file-display.ts`：旧写作文件的兼容展示标签。
- `__tests__/`：编辑、审阅和历史布局回归。
