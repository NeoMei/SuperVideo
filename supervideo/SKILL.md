---
name: supervideo
description: Use when creating, revising, previewing, or delivering narrated videos from PPT/PPTX, DOC/DOCX, Markdown, illustrated PDFs, or websites, including slide explainers, illustrated stories, website tutorials, and animated lessons.
---

# SuperVideo

把资料做成有配音、字幕、背景音乐且可继续修改的讲解视频。用户用自然语言说明目标；宿主负责理解内容与展示审阅，本地引擎只接受结构化操作。

运行 `node <skill-directory>/scripts/video.mjs --help` 读取当前机器合同。项目模型与媒体操作都通过同一入口的 `--project`、`--request` 和可选 `--runtime` 完成；request 是 `{action,...fields}`。不要让用户编写 JSON，不要臆造入口参数或绕过现有引擎校验。

先读 [对话引导](references/guidance.md)。新作品先明确观众、用途和看完后应达到的结果，再展示简短制作简报；得到用户对方向的确认或明确委托后，才展开完整讲稿与制作。每轮只问一个会改变结果的关键问题，给出易选择的建议；已知信息直接复用。资料完整时直接展示简报，不机械走问卷。

已有工程先执行 `status`，读取现有制作简报与对话授权。局部修改沿用已确认方向，直接定位改动；恢复任务从当前阶段继续。只有新工程才执行 `start`。保留用户已选声音及有效语音缓存；没有声音选择的新工程使用引擎当前的百炼默认旁白。

按产出意图选择一种模式，并且本轮只加载对应指南：[PPT](references/ppt.md)、[绘本](references/book.md)、[网站操作](references/website.md)或[教学](references/lesson.md)。输入格式不决定模式，同一份 Word 或 Markdown 可以用于绘本或教学。

1. 为明确需求可先读取或导入来源、查看代表页面。按已确认制作简报形成有依据的讲稿与分镜，保留来源警告；区分原意、可核实的补充和待确认推断。`plan` 后展示易读的场景目标、讲稿、画面与动作，内部绑定当前 revision。简报确认只确认方向，不等于尚未展示的讲稿、样片或成片已获通过。
2. 把 BGM 作为成片设计的一部分：沿用用户提供或已授权导入的音乐，明确全片或场景范围、音量、循环或裁切、淡入淡出和旁白 ducking。没有音乐来源或用户未要求寻找音乐时，不擅自下载或对外请求音乐；可以明确采用无 BGM。
3. `approve` 只用于 `script/sample/final`：用户确认当前展示的该阶段内容，或已有明确覆盖该阶段的跳过审阅授权，才记录相应 approval/waiver；方向确认只记入制作简报。传入对应产物的 `expectedRevision`、实际 stage/scope/decision 与可追溯的 evidence；普通确认须绑定用户看到的版本，明确委托的 waiver 须绑定该阶段实际产物。候选摘要或 agent 判断都不是授权。沿用用户此前已授予的合并审阅或跳过中间审阅授权，并只在其实际阶段和范围内记录 waiver evidence；已有覆盖授权无需重复询问，超出覆盖范围才取得新确认。
4. 先制作覆盖主要视觉类型的代表样片，再制作完整预览。`produce` 会先检查全工程讲稿授权，再复用现有语音/录制证据并准备时间轴和渲染。展示实际 MP4，分别核对画面、动作、字幕、音乐、读音和知识含义。
5. 将自然语言修改定位到具体场景、句子或对象后执行 `revise`，配乐修改走 `music`；修改后核对当前阶段状态与原有及本次授权；授权不足时，只重新展示受影响内容并取得所缺确认。最终确认必须绑定精确完整渲染，再执行 `deliver`。

`needs_input` 时先处理宿主能解决的运行时、素材和路径问题，只向用户询问仍缺的内容选择或外部授权。说明失败动作、保留的 artifacts 和 `next-step`；不要把技术回执当成人工观感、读音或知识验收。

需要工程字段、字体/授权、录制恢复或高级 API 时再读 [工程参考](references/project.md)。机器操作字段始终以 `video.mjs --help` 为准。
