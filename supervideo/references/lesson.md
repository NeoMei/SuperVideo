# 教学动画

每个知识判断都记录：来源主张、对应原文或图示、新增解释的独立来源或待验证状态，以及要展示的变化关系。SourceRef 只提供定位；原文支持“A 时做 B”并不自动支持其他条件。源文知识核验、组件模型检查和视频解码是三类独立证据。

动画应表现实际关系变化，并先声明必须保持的事实、几何量或合法状态。每个教学场景都要有学习目标。实际必需的 `settings.lesson` 元数据：

```text
objectives:[{id,text,sceneIds}]
invariants:[{id,component,check,evidence}]
```

复杂或领域特定关系使用受审项目组件。`settings.components` 中每个描述符需要 id、entry、model、files、checks 和 review；invariant.component 必须指向描述符，invariant.check 必须是其真实 named check。model.mjs 提供 `modelAt(props,progress)` 与 checks 中的函数，view.tsx 根据场景和时间槽显示状态。

组件文件作为 host asset 登记实际路径与 SHA；独立看过源码后，用当前组件 digest 和真实 evidence 写 review。代码改变后重新登记并审阅。内置 text/steps/comparison 可辅助讲解，但不能冒充需要领域 invariant 的模型。

后续教学动画沿用用户已确认的全屏排版，默认使用 `visual` 布局；仅在用户明确要求其他布局时更改，不自动切回 `narrated` 分栏。画面铺满画布，不套外层标题或装饰边框。受审项目组件自行绘制唯一标题；白色字幕使用黑色半透明衬底（不透明度 58%，即 `rgba(0,0,0,0.58)`），直接悬浮在完整画面上。组件按目标画幅安排内容，下方约 20% 留给最多两行字幕，关键文字、节点与结论放在其上方；保留全屏背景，不缩成字幕上方的小窗。字幕较长时缩短单条字幕或调整构图，并逐场景检查重叠；此约定不等于引擎自动识别文字避让。强调具体对象，不用整幅 visual 的 highlight 充当教学动作。

样片覆盖关键动作和状态变化。数学符号保留在画面，旁白改成正确口语。完整预览分别核对知识、模型关系、动作、字幕和读音，再确认精确输出。
