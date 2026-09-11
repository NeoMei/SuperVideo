# 工程参考

`project.json` 保存 mode、output、sources、assets、scenes、settings、approvals、jobs 和 revision。PPT/PPTX、DOC/DOCX、UTF-8 Markdown 与 URL 都是来源；模式由视频意图决定。SourceRef 绑定真实 source/node/contentHash，不能自动证明引用支持某句解释。

Scene 的稳定含义是：来源、场景目标、逐句讲稿、画面素材/组件、动作提示和首尾留白。句子 ID、scene ID 和对象 ID 用于局部修改与缓存失效。时间轴来自实际音频、录制事件和媒体测量，不按字数冒充精确时长。

新工程若未指定声音，`start` 写入当前 `BAILIAN_DEFAULT_VOICE` 作为 narrator；已有 `settings.voices`、用户选择的其他 provider/voice 和匹配的语音缓存保持不变。每句文本不超过 provider 的实际限制；局部语速使用 Sentence.audioRate，并在重新准备后试听。

## BGM

`music` action 调用引擎 `configureMusic`。一次请求用 path 或 assetId 选择音乐，可指定 sceneId、startMs、durationMs、sourceStartMs、sourceEndMs、loop、volume、fadeInMs、fadeOutMs 和 ducking；`remove:true` 只移除 BGM。新选择替换当前 BGM，不清除 SFX。范围、裁切、循环、淡入淡出和 ducking 以实际混音输出验收；没有用户提供或已授权来源时不主动下载音乐。

## 网站录制路径

成功或可恢复的 `record` 回执产生 workflow.json。入口会把它写入 `settings.preparation.workflowPaths`，同一 source/request 的恢复 workflow 只有完整覆盖旧事件时才替换旧路径；无关录制保留，事件 ID 冲突会失败。prepare/render/resume 只消费这些已保存且可验证的路径，不重放网站动作。

## 字体与授权

字体可通过 `asset` 导入，origin 必须含真实 kind/reference/version。若同时设置字体，font descriptor 要引用工程内已存在的 license 与 provenance 文件及各自真实 SHA-256；引擎再次读取并核对字节，然后设置 render.fontAssetId 与 export.fontLicense。系统字体可用于本机渲染不等于可再分发；没有真实许可证和来源记录时不声称可交付字体。

## 确认与交付

script 确认覆盖对应分镜内容；任何 `produce` 准备都会遍历全工程旁白，因此进入准备前必须有全场景当前 script 确认。完整制作还要求指定样片的当前 sample 确认。final 确认绑定完整 render manifest 的实际路径和 SHA。修改内容、素材、工作流或受审组件会按现有 API 使相关确认/任务失效。技术检查、用户看到的预览和最终交付是不同证据。
