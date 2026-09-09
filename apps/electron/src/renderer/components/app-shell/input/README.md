# Chat input
该目录组合聊天输入、上下文控件、执行模式与结构化请求；`ChatInputZone.tsx` 负责外层编排，`InputContainer.tsx` 在自由输入和结构化输入之间切换。

- `ChatInputZone.tsx`: 输入区外层、项目上下文、标签与队列消息
- `InputContainer.tsx`: 自由输入与结构化输入切换
- `FreeFormInput.tsx`: 文本、附件、技能、数据源、模型与发送工具栏
- `InputAddMenu.tsx`: 桌面加号菜单；技能和数据源通过可搜索的悬停子菜单选择，复用输入框的技能徽标和数据源状态
- `WorkingDirectoryBadge.tsx`: 会话工作目录选择
- `FreeFormInputContextBadge.tsx`: 输入工具栏共享按钮
- `DesktopPermissionModeSelector.tsx`, `CompactPermissionModeSelector.tsx`: 执行模式选择
- `StructuredInput.tsx`, `structured/`: 结构化请求与响应
- `InputErrorBoundary.tsx`, `ToolbarStatusSlot.tsx`, `ImageSupportWarningBanner.tsx`: 输入区状态与错误呈现
- `context-usage.ts`, `focus-input-events.ts`, `free-form-input-behavior.ts`, `input-event-guards.ts`, `structured-height.ts`, `useAutoGrow.ts`, `working-directory-history.ts`: 输入行为与纯逻辑
- `__tests__/`: 输入区回归测试
