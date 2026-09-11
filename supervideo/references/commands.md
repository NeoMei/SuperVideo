# 运行入口

实际动作、请求字段、退出码和高级 API 指针由当前引擎提供：

```sh
node <skill-directory>/scripts/video.mjs --help
```

宿主把一次语义请求写入临时 JSON，再调用同一入口：

```sh
node <skill-directory>/scripts/video.mjs --project <工程目录> --request <请求文件> [--runtime <运行时文件>]
```

stdout 只有一份 Receipt：`status` 为 `succeeded`、`failed` 或 `needs_input`；`artifacts` 是已生成或仍可复用的文件；`checks` 包含事实证据和 `next-step`。退出码分别是 0、1、2。先解释真实 status，再展示 artifacts；不能把部分 artifact 当成动作整体成功。

`status` 返回当前 revision 和下一步。`plan`、`revise` 默认采用调用时的当前 revision；并发编辑需要显式传入调用者已读取的 revision。`approve` 必须传用户看到并确认的 `expectedRevision`，引擎先比对 revision，再从当前工程计算 digest，因此不接收由宿主伪造的 digest 或 consent。

`--runtime` 只引用工程外的操作依赖，不保存密钥、登录态或创意设置。缺什么能力由具体动作在其真实边界报告；开发者需要综合诊断时按 `--help` 中的 doctor API 指针调用。
