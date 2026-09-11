# 网站操作说明

先确定用户任务与可观察成功结果。URL 导入只记录页面来源、文字、截图和 DOM；`record` 才执行已获授权的步骤。登录凭据由用户在宿主浏览器处理，工程只引用外部 storage state，不保存密码或 cookie。

每一步必须使用实际观察到的唯一 accessibility role/name，并声明动作后的可见 expected condition；整体 success 也必须可观察。LOGIN_REQUIRED 时保留 checkpoint 等用户完成登录。UNCERTAIN_ACTION 时先核对后置状态；不要重复点击。恢复只修复已有录制媒体和证据。

录制会测量真实 click/input/keydown 的控件边界、点击位置和时点，保留动作前提示、动作当帧和结果停留。导航发生时结束旧页面提示。只有经过验证的 interaction 才生成鼠标/光圈/焦点提示；旧素材没有 interaction 时不能猜坐标，可人工添加有证据的语义标注或重新录制已授权流程。

分镜需要保留真实 requiredEvents 与 recording cuts：captureId、sourceId、videoAssetId、sourceStartMs/sourceEndMs、sceneStartMs 和 playbackRate 必须来自同一录制证据。讲稿节拍按实际音频安排，避免短操作在长旁白中提前展示后续结果。

样片检查动作前、动作当帧、提示消失和结果画面，并核对字幕/讲述同步。`measured-action-hints` 未通过时列出缺少位置证据的事件，不把普通录屏说成完成的操作教学。
