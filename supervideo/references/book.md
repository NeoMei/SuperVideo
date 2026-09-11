# 绘本讲述

用于有旁白或角色对话的故事视频。Word、Markdown 或页面都可以是来源。按正文顺序组织讲述，每个 spoken sentence 对应一条有序文本 SourceRef；多句可引用同一段，但不能改变来源顺序或补造情节。

实际必需的 `settings.book` 元数据：

```text
cast:[{id,name,referenceAssetIds,voiceId}]
turns:[{sentenceId,speakerId}]
continuity:[{sceneId,characterIds,propAssetIds,review?}]
review:{assetIds,referenceAssetIds,evidence,conflicts}
```

每句只有一个 turn，顺序与全局句子一致，speaker 的 voiceId 与 Sentence.voiceId 一致。画面中出现的角色必须有 referenceAssetIds；旁白若不出镜可以无视觉参考。每场 continuity 绑定出镜角色和道具。

来源自带插图可直接复用。宿主新增的插图要用 review 对比本场图、角色和道具参考，记录实际 evidence，先解决 conflicts。文件 SHA 只证明字节，不证明人物一致性。

PDF 绘本先由宿主读取并渲染原页，逐页核对文字与插图，再导入明确标记为派生稿的 Markdown 和原页图片；当前引擎不直接接收 PDF。保留原 PDF 哈希、物理页码与场景映射，说明省略的序言或重复页。图像页没有可提取文字时，不把空提取结果当正文；看不清的字保留不确定性，不补造。原页偏竖时，结合用户偏好选接近原页比例的竖屏。

画面默认全屏完整显示插图，无外框与重复标题，白字字幕叠加黑色 58% 不透明度衬底；用同图柔化背景填满不同比例，不裁人物或图内文字。逐页避开对话、原文和互动提示，为字幕选择空白或背景区域，实际抽帧核对字幕不出界、不遮挡；不要照搬某个样片的位移参数。point/highlight 需实际对象区域。样片要覆盖主要角色对话与视觉变化，以及封面和互动页等不同排版。
