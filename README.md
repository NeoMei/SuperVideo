# SuperVideo

SuperVideo 是一个轻量级视频制作技能：提供 PPT、绘本、网页操作教程和教学动画的自然语言引导式制作。它会先确认目标、受众、画幅、声音和 BGM，再生成制作简报、讲稿、分镜、样片和最终 MP4。

正式版下载：[GitHub NeoMei/SuperVideo](https://github.com/NeoMei/SuperVideo) · [v0.1.0 Release](https://github.com/NeoMei/SuperVideo/releases/tag/v0.1.0)

## 能做什么

| 输入 | 输出与默认效果 |
| --- | --- |
| PPT/PPTX | 保留原页画面，自动生成百炼旁白、字幕和全屏讲解视频 |
| Word/DOCX、Markdown | 转为讲稿、分镜和教学动画；主体画面全屏，字幕使用半透明衬底 |
| 绘本 PDF | 宿主逐页理解并保留原页比例，生成竖屏或横屏绘本讲读视频 |
| 网站链接或网页资料 | 生成带真实操作步骤、点击高亮和动作提示的网站说明视频 |

所有模式都支持 BGM 导入、音量、循环、裁剪、淡入淡出、场景范围和旁白时自动压低音乐。修改画面或音乐时，未变化的百炼配音会复用缓存。

## 安装

### macOS / Linux

```sh
node install.mjs --skill-dir "$PWD/installed/supervideo" --engine-dir "$PWD/installed/engine"
npm ci --prefix "$PWD/installed/engine" --ignore-scripts
export SUPERVIDEO_RUNTIME_CONFIG="/绝对路径/runtime.json"
node "$PWD/installed/engine/src/cli.mjs" doctor --runtime "$SUPERVIDEO_RUNTIME_CONFIG"
node "$PWD/installed/supervideo/scripts/video.mjs" --help
```

### Windows PowerShell

```powershell
node .\install.mjs --skill-dir "$PWD\installed\supervideo" --engine-dir "$PWD\installed\engine"
npm ci --prefix "$PWD\installed\engine" --ignore-scripts
$env:SUPERVIDEO_RUNTIME_CONFIG = "C:\path\to\runtime.json"
node "$PWD\installed\engine\src\cli.mjs" doctor --runtime $env:SUPERVIDEO_RUNTIME_CONFIG
node "$PWD\installed\supervideo\scripts\video.mjs" --help
```

安装器只写入你指定的两个独立目录，不会覆盖内容不同的旧版本，也不会自动注册全局技能。升级时使用新目录验证后再切换宿主加载路径；回退时切回旧目录即可。

## 运行环境

必需或按输入准备：Node 20+、Python、FFmpeg/ffprobe、Chrome；文档和 PDF 输入还需要 LibreOffice/文档渲染器与 pdftoppm。优先复用宿主已有工具。

百炼凭据只通过环境变量提供，不要写入工程或 JSON：

```sh
export DASHSCOPE_API_KEY="你的百炼 Key"
```

运行时配置示例：

```json
{
  "python": "/绝对路径/python3",
  "ffmpeg": "/绝对路径/ffmpeg",
  "ffprobe": "/绝对路径/ffprobe",
  "browserExecutable": "/绝对路径/Chrome",
  "playwrightModule": "/绝对路径/installed/engine/node_modules/playwright-core",
  "documentRenderer": "/绝对路径/soffice",
  "pdftoppm": "/绝对路径/pdftoppm",
  "fontPaths": ["/绝对路径/字体文件"]
}
```

## 使用方式

加载 `installed/supervideo/SKILL.md` 后，直接用自然语言描述任务，例如：

```text
把 /path/to/company.pptx 做成 3 分钟中文产品解说视频，面向客户，使用百炼配音，字幕叠在画面上方，加入 /path/to/music.mp3 作为轻音乐。
```

技能会按以下顺序引导：确认目标 → 制作简报 → 讲稿和分镜 → 代表样片 → 完整预览 → 精确成片确认 → 导出 MP4、字幕和讲稿。每轮只确认一个关键问题；明确授权和已有偏好会沿用。无需另装 Superpowers。

统一入口：

```sh
node installed/supervideo/scripts/video.mjs --help
node installed/supervideo/scripts/video.mjs --project /path/to/project --request /path/to/request.json --runtime /path/to/runtime.json
```

## 依赖精简说明

安装包**不需要安装 Remotion 或 OpenMontage 插件**，也不需要 clone OpenMontage 仓库。OpenMontage 只随包提供混音、字幕和基础模块的固定来源子集；Remotion 只保留核心 renderer，并使用 esbuild 和裁剪后的无界面渲染入口。安装依赖中不包含 `@remotion/studio`、`@remotion/bundler`、Webpack 或 Rspack。

Node、Python、FFmpeg、Chrome 和文档工具仍是视频制作的真实运行依赖；这部分工具可以由宿主统一管理，并不属于 Remotion/OpenMontage 全量插件安装。

## 文件和许可证

原创源码采用 [Apache-2.0](LICENSE)。OpenMontage、Remotion 及其他第三方代码保留各自许可证，详见 `engine/THIRD_PARTY_NOTICES.md` 和 `engine/licenses/`。发布包不包含用户素材、登录状态、机器路径、API Key 或 `node_modules`。

## 当前版本验证

正式版 v0.1.0 已完成 298 项测试、全新目录安装、四类视频（PPT、绘本、网页、教学）和 BGM 混音验证；下载 ZIP 的 SHA-256 为 `08585e6a004f19a4c5207f4610117b6e8ba3030c9554f7a1a180d00a0d704278`。Windows 原生、登录网站续作以及部分主观听感审阅属于后续验收项，不影响本版本作为正式源码包发布。

接收 PPT/PPTX、DOC/DOCX、Markdown 或网站链接，制作 PPT 自动解说、绘本解说、网页操作教程和教学动画。默认百炼配音；保留全屏画面、半透字幕和真实网页动作提示。BGM 支持导入、音量、全片或场景范围、循环裁剪、淡入淡出和讲话时降低音乐。

用户用自然语言沟通。技能先确认想要的结果，再准备讲稿、分镜、预览和修改请求，用户无需填写内部 JSON。

PDF 绘本通过宿主逐页理解与原页渲染，转为带来源映射的 Markdown 和插图后制作；当前不是引擎原生 PDF 文本导入。保留原页比例和完整插图，字幕避开原文与互动提示。

## 对话引导

新作品先明确受众与观看目标，每轮只问一个关键问题；有不同讲法时给出简短比较和推荐。要求完整时直接展示制作简报，包含内容范围、表现方式、时长、声音、字幕、BGM 和验收标准。用户确认方向后，再展开讲稿/分镜、代表样片与完整视频。

已有偏好、明确委托及确认会保留；局部修改直接处理受影响部分。引导记录保存在工程的 `制作简报.md`，可以续做，不必重复回答。方向确认与讲稿/样片/成片确认分别记录。引导内置在技能中，无需额外安装 Superpowers。

## 安装

包内 `supervideo/` 是技能，`engine/` 是共享内核。安装器校验哈希，拒绝覆盖不同版本的已有目录；依赖准备单独执行。

```sh
node install.mjs --skill-dir "<技能目标目录>/supervideo" --engine-dir "<内核目标目录>"
npm ci --prefix "<内核目标目录>" --ignore-scripts
```

已有旧版时，把新版技能安装到另一个目录，再由宿主切换加载位置；安装器不会覆盖不同内容的旧技能。若 `runtime.lock.json` 的内核 SHA 相同，可直接复用原内核目录和已安装依赖。

内核可以放在技能的同级 `engine/`；也可以由宿主设置 `SUPERVIDEO_ENGINE_ROOT`。共享缓存支持 `SUPERVIDEO_ENGINE_CACHE/<runtime.lock.json 中的 engineManifestSha256>/`。技能锁定匹配的内核，多个视频工程可共用。

首次使用需要 Node 20+、Python、FFmpeg/ffprobe 和 Chrome；文档导入另需文档渲染器和 pdftoppm。具体版本和能力清单见 `engine/runtime-manifest.json`。优先复用宿主已准备的运行环境；运行时 JSON 通过 `SUPERVIDEO_RUNTIME_CONFIG` 或 `--runtime` 提供。百炼凭据只放在宿主的 `DASHSCOPE_API_KEY` 环境变量中。

浏览器、依赖目录、字体和运行时配置不包含在源码包内；宿主应根据实际任务准备所需项目，不必重复安装已有能力。字体随工程交付时需有对应许可和来源记录。

## 最小运行依赖

不需要安装 Remotion 或 OpenMontage 插件。npm 仅准备 Remotion 核心与 renderer、React、esbuild，以及文档/网页实际使用的库；没有 Studio、上游 bundler、Webpack、Rspack、模板库或插件说明大全。少量经审计的浏览器渲染入口随包提供。播放、暂停和拖动预览使用同一时间轴。

Node、FFmpeg 和 Chrome 是执行视频制作的实际运行工具；优先复用已有安装。文档导入所需 Python 库及渲染器按输入准备，不安装 OpenMontage 的 AI 模型与服务依赖。默认配音直接使用百炼；旧 ElevenLabs 配置为可选兼容路径，只在显式使用时要求其凭据与 requests。

## 使用与修改

加载技能后，直接提供资料和目标，例如“把这个 PPT 做成中文解说视频”或“加入这段音乐，讲话时压低，结尾渐弱”。素材和确认要求沿用当前对话中的有效授权；没有音乐来源时可保持无 BGM。修改配乐会复用未变化的旁白缓存。

宿主通过统一入口操作，实际接口和可定位的模式说明由当前内核提供：

```sh
node "<技能目标目录>/supervideo/scripts/video.mjs" --help
node "<技能目标目录>/supervideo/scripts/video.mjs" --project "<视频工程目录>" --request "<请求文件.json>"
```

常规交付是 MP4、字幕和讲稿。可继续编辑工程由 `deliver` 按精确成片确认导出。技术回执与用户对读音、内容和画面的审阅分别保留。


## 首次配置示例

从解压后的包根目录执行。下面的目录由你选定，均应是新目录；路径占位符必须替换为本机绝对路径。

macOS / Linux shell：

```sh
node install.mjs --skill-dir "$PWD/installed/supervideo" --engine-dir "$PWD/installed/engine"
npm ci --prefix "$PWD/installed/engine" --ignore-scripts
export SUPERVIDEO_RUNTIME_CONFIG="<runtime.json 的绝对路径>"
node "$PWD/installed/engine/src/cli.mjs" doctor --runtime "$SUPERVIDEO_RUNTIME_CONFIG"
node "$PWD/installed/supervideo/scripts/video.mjs" --help
```

Windows PowerShell（路径不含占位符后执行）：

```powershell
node .\install.mjs --skill-dir "$PWD/installed/supervideo" --engine-dir "$PWD/installed/engine"
if ($LASTEXITCODE -ne 0) { throw "安装失败" }
npm ci --prefix "$PWD/installed/engine" --ignore-scripts
if ($LASTEXITCODE -ne 0) { throw "依赖准备失败" }
$env:SUPERVIDEO_RUNTIME_CONFIG = "<runtime.json 的绝对路径>"
node "$PWD/installed/engine/src/cli.mjs" doctor --runtime $env:SUPERVIDEO_RUNTIME_CONFIG
node "$PWD/installed/supervideo/scripts/video.mjs" --help
```

成功安装后，在宿主中加载 `installed/supervideo/SKILL.md`。这组命令只创建所选独立目录，不替你注册全局技能。Windows 命令为配置说明，实际 Windows 原生验收仍待执行。

包外 `runtime.json` 可按下面的字段填写。Windows 路径可用 `C:/tools/...`，不要把任何密钥写入 JSON。

```json
{
  "python": "<Python 可执行文件绝对路径>",
  "ffmpeg": "<FFmpeg 可执行文件绝对路径>",
  "ffprobe": "<ffprobe 可执行文件绝对路径>",
  "browserExecutable": "<Chrome 可执行文件绝对路径>",
  "playwrightModule": "<已安装 engine 的绝对路径>/node_modules/playwright-core",
  "documentRenderer": "<LibreOffice soffice 可执行文件绝对路径>",
  "pdftoppm": "<pdftoppm 可执行文件绝对路径>",
  "fontPaths": ["<具有所需汉字的字体文件绝对路径>"]
}
```

Python 环境须能导入 `docx`、`pptx`、`PIL`、`lxml`、`pypdf`，对应安装包为 `python-docx python-pptx Pillow lxml pypdf`。已有合适运行环境可复用。OpenMontage 的混音、字幕及共享基类已作为固定来源的最小模块随包提供，无需 clone 仓库、安装上游插件或整份 requirements。混音与字幕只用 Python 标准库和 FFmpeg。旧工程显式指定的 openmontageRoot 仍受校验；新增工程省略该字段。Chrome、文档渲染器、FFmpeg、pdftoppm 均为外部工具，安装后将实际路径填入 JSON。

`doctor` 返回每项缺失能力与处理建议；退出码 0 为通过，1 为执行失败，2 为需要输入。百炼凭据通过宿主进程的 `DASHSCOPE_API_KEY` 提供，不打印或写入工程。凭据存在不代表服务额度和听感已验收。默认中文音色为 Cherry，模型为 `qwen3-tts-flash-2025-11-27`；用户已指定的百炼音色和模型优先。

## 升级和回退

1. 保留旧包和旧 skill/engine 目录。新版安装到新的独立目录并执行依赖准备、doctor、代表样片检查；安装器拒绝覆盖不同内容。
2. 将宿主技能加载位置切到新 `supervideo/`。使用同级 `engine/` 时无需另设内核路径；若宿主曾配置 `SUPERVIDEO_ENGINE_ROOT` 或 `SUPERVIDEO_ENGINE_CACHE`，同时指向匹配新 `runtime.lock.json` 的内核。
3. 回退时切回旧 skill 和匹配内核，并使用升级前保留的工程副本。切换程序版本不自动回退工程修改。

## 分发与验收状态

本包是 0.1.0 公开预览源码包；外部依赖需单独准备，不是全部能力开箱即用的二进制安装包。四类流程、BGM 和对话引导均保留。macOS 已用用户提供的 PPT、教学 Markdown 和 PDF 绘本完成实际成片；PDF 使用上文说明的宿主转换路径。Windows 原生、登录网站续作及部分人工发音/画面/音乐审阅仍待验证，不能据此宣称全部平台与场景均已验收。发布仓库为 [NeoMei/SuperVideo](https://github.com/NeoMei/SuperVideo)，原创源码采用 [Apache-2.0](LICENSE)。上游依赖保留各自许可，第三方媒体不包含在此授权内。

参见 [更新记录](CHANGELOG.md)、[技能入口](supervideo/SKILL.md)、[第三方说明](engine/THIRD_PARTY_NOTICES.md) 和 [内核许可证目录](engine/licenses)。本说明在仓库中的 `engine/`、`supervideo/` 链接对应解压后的包目录。
