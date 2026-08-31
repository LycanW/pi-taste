# Pi Taste

[English](README.md) | **简体中文**

Pi Taste 是一个本地运行、可审核的 [Pi coding agent](https://github.com/earendil-works/pi-mono) 偏好学习扩展。它把“上一轮 Agent 行为”和“当前用户反馈”一起交给 Observer 分析，提取有证据支持的持久偏好，再由确定性程序完成校验、状态变更和保存；只有已批准的偏好才会注入未来轮次。

它**不会**训练或修改模型权重。所有学习结果都以可读、可审计、可删除的文件保存在本机。

Pi Taste 是受 Command Code 用户侧 Taste 工作流启发的独立开源实现，与 Command Code 没有关联，也未获得其官方背书。

## 1. 快速上手

直接从 GitHub 安装 Pi package：

```bash
pi install git:github.com/LycanW/pi-taste@v0.3.1
```

无需永久安装即可试用一次：

```bash
pi -e git:github.com/LycanW/pi-taste@v0.3.1
```

当前版本已使用 Pi 0.84.4 验证，并要求 Node.js 22.19 或更高版本，与 Pi 自身的运行时要求一致。

安装或更新后重新加载 Pi：

```text
/reload
```

查看当前状态：

```text
/taste status
```

默认行为：

- 自动学习已开启；
- approved Project Taste 注入已开启；
- 新初始化的项目默认开启 Global Taste 注入和自动 Global 学习，除非显式关闭；
- Observer 跟随当前 Pi 主模型；
- 自动学习会在前台 Agent 完全结束后启动，并可与后续轮次并行在后台继续；
- 基于模型的 Curator 永远不会自动运行。

常用入门命令：

```text
/taste list all
/taste remember -g 除非我要求详细说明，否则始终保持回答简洁。
/taste review
/taste model status
```

## 2. 自动学习如何工作

当 `/taste on` 开启时，普通用户轮次会执行以下流程：

```text
上一轮 Agent 行为 + 当前用户反馈
    → 当前前台 Agent 完全结束
    → 后台 Observer
    → 确定性校验与 Reducer
    → approved / pending / rejected / superseded 状态
    → 在未来轮次中仅注入 approved Taste
```

当前用户消息才是偏好证据。上一轮 Agent 回复、工具调用和修改文件仅作为“被评价的行为”，不能单独产生用户偏好。

用户在 Agent 流式工作期间插入的 steering 和 follow-up 消息也会被捕获。Taste 会快照插入发生时已经可见的 Assistant 文本、工具调用和已完成工具结果；等完整前台运行结束后，再用这段进行中行为与插入纠正进行评价。扩展自行生成的消息会被排除，因为它们不是用户证据。

扩展会先为当前轮生成注入快照，再暂存当前反馈。Taste 会等待 Pi 确认完整的前台 Agent 运行（包括重试和排队的 follow-up）已经结束，然后在后台启动 Observer。后续用户轮次不需要等待，也不会取消已经运行的 Observer。因此，新学到的偏好只能影响后续轮次，不会反过来影响提供该证据的当前轮次。

使用 `--no-session` 启动的 Pi 进程，以及带有 `PI_SUBAGENT_CHILD=1` 标记的 `pi-subagents` 子进程，可以接收 approved Taste 注入，但不会产生学习事件。`PI_TASTE_ALLOW_NO_SESSION=1` 仅供隔离测试使用，并且不能绕过 subagent 子进程保护。

自动 Scope 归类遵循最小作用域：默认使用 Project。只有当前反馈明确表达“跨项目/全局个人偏好”，并且当前项目已执行 `/taste global on` 时，才允许归入 Global。`/taste global off` 时，Observer 只查看 Project 偏好，Reducer 还会确定性地把所有新的自动提案限制为 Project。`remember -g`、`import -g` 和 `move ... global` 等显式管理命令仍属于人工覆盖。

## 3. 对话区活动卡片

每次自动 Taste 检查都会在 TUI 对话记录中写入一张持久化的工具式活动卡片。卡片可以显示：

- 新批准的偏好；
- 等待审核或重复证据的 pending 偏好；
- 对已有偏好的强化；
- 批准、拒绝、遗忘或取代；
- 已应用的 Curator 操作；
- 已检查但没有持久变化；
- 确定性低信号跳过；
- Observer 失败。

示例：

```text
✓ Taste Updated — 1 approved
+ [global/approved] Always show exact file paths. — active next turn
State [global]: /home/user/.pi/agent/taste/preferences.json
Taste [global, approved view]: /home/user/.pi/agent/taste/taste.md
```

状态含义：

- `approved`：从未来轮次开始可以注入；
- `pending`：已保存以供审核，但不会注入；
- `rejected`：保留审计记录，但不会注入；
- `superseded`：已被其他偏好取代，不再注入。

按 `Ctrl+O` 可以展开卡片。展开后可查看 Preference ID、原因、Observer 分类与模型、Event ID，以及全部审计文件路径。

活动卡片使用 Pi custom session entry，而不是模型消息。因此它们：

- 恢复会话后仍然可见；
- 永远不会进入模型上下文；
- 不消耗模型 Token；
- 不改变提示词缓存前缀。

Observer 只会在当前前台轮次完全结束后启动。活动卡片可能在下一轮开始前出现，也可能在后续某轮 Agent 回复过程中出现；后续轮次不需要等待后台学习。

## 4. 安全与持久化策略

Pi Taste 宁可漏掉证据不足的推断，也不会轻易保存错误偏好。

- 沉默、`ok`、`good`、`continue`、笼统表扬及类似确认不会产生偏好。
- 一次性约束永远不会持久化。
- 正确性修复和事实纠正不会被当作个人偏好。
- 明确的持久偏好可以直接批准。
- 隐式纠正首次进入 `pending`。
- pending 偏好可以通过人工审核或重复独立证据升级为 approved。
- `pending`、`rejected`、`superseded` 永远不会注入。
- 当前用户的明确指令始终覆盖历史 Taste。
- 同时相关时，project Taste 优先于 global Taste。
- Confidence 由程序根据证据计算，Observer 不能自行填写。
- Confidence 只是审计元数据，不是提示词权重。
- Observer 和 Curator 模型都不能直接写偏好文件。

## 5. Footer 状态

在 TUI 中，Taste 状态显示在上下文窗口占用右侧：

```text
… 12.3%/272k Taste:on/project-only            model • thinking
```

可能出现的标记：

- `Taste:on`：自动学习已开启；
- `Taste:off`：自动学习已关闭；
- `/inject-off`：approved Taste 注入已关闭；
- `/project-only`：当前项目未启用 Global Taste；
- `·N`：有 N 个 Observer 任务正在排队或运行；
- `!`：最近一次 Observer 操作失败。

Footer 仅属于 UI，不会进入模型上下文。其他扩展的状态行会被保留。Pi 只允许一个自定义 footer 所有者，因此后续调用 `setFooter()` 的其他扩展可能替换该 footer。

## 6. Taste 模型配置

默认模式为 `inherit`：Observer 使用当前 Pi 主模型。通过 `/model` 切换模型后，后续 Taste 检查也会跟随新模型。

在 TUI 中直接运行不带参数的 `/taste model`。先选择跟随主模型或使用独立模型；选择独立模型后，会打开 Pi 原生的可搜索模型选择器，也就是 `/model` 使用的同一套界面。它支持 Provider 标签、当前模型标记、模糊搜索、键盘导航、scoped models 和模型目录刷新。

```text
/taste model                    # 模式菜单，然后打开 Pi 模型选择器
/taste model select             # 直接打开 Pi 模型选择器
/taste model select qwen        # 带初始搜索打开选择器
/taste model status
/taste model inherit
/taste model set                # TUI 打开选择器；RPC 可传 provider/model
/taste model only               # TUI 打开选择器
/taste model add                # TUI 打开选择器
/taste model remove             # 从已配置的自定义模型中选择删除
/taste model list qwen
```

各操作含义：

- `status`：显示当前模式、实际模型和自定义备用顺序；
- `inherit`：跟随当前主模型；
- `select [query]`：打开 Pi 模型选择器，并且只使用选中的模型；
- `set`：进入自定义模式，把选中模型设为首选，并保留已有备用模型；
- `only`：进入自定义模式，并且只使用一个选中模型；
- `add`：添加选中的备用模型，或把已有备用模型移动到队尾；
- `remove`：选择并移除自定义候选；移除最后一个候选后返回 `inherit`；
- `list [query]`：列出与可选查询匹配的可用模型。

脚本和 RPC 仍可使用精确的 `provider/model` 参数，但日常 TUI 操作不再需要手工输入模型 ID。自定义模式绝不会偷偷回退到主模型。如果所有已配置模型都没有可用凭据，学习会明确失败，并且不会伪造任何偏好。

除非使用 `/taste curate --model provider/model` 为单次计划显式覆盖，否则 Curator 使用相同的有效 Taste 模型。

## 7. 审核和管理偏好

手工 remember/import 默认写入 **Project Taste**；使用 `-g` 写入 **Global Taste**。Project root 的判定很简单：存在 Git 根目录时使用最近的 Git 根目录，否则使用启动 Pi 时的当前工作目录；不要求存在 `.git`。

查看准确路径和当前默认 scope：

```text
/taste paths
```

列出偏好：

```text
/taste list all
/taste list approved
/taste list pending
/taste list rejected
/taste list superseded
```

记住当前项目的 approved 偏好：

```text
/taste remember 提交前始终运行本仓库的格式化工具。
```

记住 global approved 偏好：

```text
/taste remember -g 始终给出实际执行过的验证命令。
```

`--global` 是 `-g` 的别名；需要明确表达时也可使用 `--project`。

导入 Command Code 风格的 Markdown 文件（每行一条 `- preference`）：

```text
/taste import ./taste.md       # 默认导入 Project
/taste import ./taste.md -g    # 导入 Global
```

TUI 会显示有限预览并要求确认。脚本和 RPC 使用 `--yes`。确认导入属于用户明确操作，因此条目会直接 approved 并自动去重；疑似凭据的行会被跳过；导入过程不调用模型。

在不丢失历史的情况下修正 scope：

```text
/taste move <id> project
/taste move <id> global
```

旧条目会变为 `superseded`，目标 scope 中会创建或合并一条 approved 条目。

审核 pending 偏好：

```text
/taste review
/taste review <id> approve
/taste review <id> reject
```

在 TUI 中，不带 ID 的 `/taste review` 会打开交互式选择器。

遗忘偏好：

```text
/taste forget <id>
```

遗忘操作会保留审计历史：它把状态改为 `rejected`，而不是直接删除证据。

## 8. 学习与注入开关

```text
/taste on
/taste off
/taste global status
/taste global on
/taste global off
/taste inject on
/taste inject off
```

这些控制项职责不同：

- `/taste off` 停止全部新的自动学习，但不会删除或禁用已有 approved Taste；
- `/taste global on` 是新初始化项目的默认值：在 Project Taste 之后启用 Global Pi Taste 和 Global Command Code Taste 注入，并且只允许有明确跨项目证据的自动学习归入 Global；
- `/taste global off` 把注入和自动学习都限制在 Project 作用域；当前项目的自动学习不能创建或强化 Global 偏好；
- 即使 Global 已开启，作用域含糊的自动学习仍默认归入 Project；
- 项目专属设置保存在 `<project-root>/.pi/taste/config.json`，不会影响其他项目；
- 升级时保留已有项目配置；新的默认值只在项目配置首次初始化时生效；
- `/taste inject off` 停止全部提示词注入，但可以在当前项目 Global 设置允许的作用域内继续自动学习；
- 重新开启注入后，会恢复项目设置允许的 approved 快照。

Global 开关不会删除已有 Global 偏好；关闭时仍可查看、审核和管理。显式 `-g` 与 `move ... global` 命令属于人工 Scope 覆盖，不是自动学习。

## 9. 缓存稳定注入

Approved Taste 会以一个确定性快照附加到 system prompt。为保护 Provider 的前缀缓存：

- 只包含 approved statement；
- 不包含时间戳、Confidence、证据数量、队列状态、模型名称或 UI 状态；
- 如果强化证据没有改变 statement，注入字节也不会变化；
- statement 使用稳定的来源分组和创建顺序；
- 自动移除 Command Code Confidence 后缀；
- category 路径使用确定性排序；
- pending 偏好和未应用的 Curator 计划不会影响提示词；
- 只有有效 approved statement、scope、限制或注入设置发生变化时，快照才会改变；
- `/taste global on|off` 会生成新的稳定项目快照，不会加入动态元数据。

`/taste status` 会显示当前快照摘要、条目数量和字节数。

## 10. Curator

`/taste curate` 对 Pi Taste 执行显式、模型辅助的语义维护。它永远不会自动调用。

Curator 可以提出：

- `merge`：合并真正的语义重复项；
- `rewrite`：在不改变含义的情况下澄清一条偏好；
- `supersede`：在明确的变体或冲突中选择保留项；
- `flag_conflict`：记录需要人工判断的冲突；
- `move_scope`：把明显放错位置的 global/project 偏好移动到正确 scope。

命令：

```text
/taste curate                          # 生成计划，不修改偏好
/taste curate --model provider/model   # 单次计划模型覆盖
/taste curate show                     # 查看已保存计划
/taste curate apply                    # 在 TUI 中确认并应用
/taste curate apply --yes              # 非交互式应用
/taste curate discard                  # 丢弃计划，不修改偏好
/taste curate rebuild                  # 重建 taste.md，不调用模型
```

安全措施：

- 每项操作都必须引用已有 Preference ID；
- 模型不能凭空创造无关偏好；
- 生成的计划会经过严格校验和数量限制；
- 修改前先把计划保存到 `curation.json`；
- 如果计划生成后 Taste 已变化，apply 会中止；
- apply 需要单独确认；
- 适用时原条目会保留为 `superseded`；
- 证据会被保留和合并；
- 应用结果会生成活动卡片和审计事件。

Command Code Taste 导入保持只读，Curator 永远不会修改它们。

## 11. 命令总览

```text
/taste status
/taste list [approved|pending|rejected|superseded|all]
/taste paths
/taste remember [-g|--global|--project] <preference>
/taste import <markdown-file> [-g|--global|--project] [--yes]
/taste move <id> [global|project]
/taste review [<id> approve|reject]
/taste forget <id>
/taste on | off
/taste global [status|on|off]
/taste inject on | off
/taste model [status|inherit|select|set|only|add|remove|list] [provider/model|search]
/taste curate [show|apply [--yes]|discard|rebuild|--model provider/model]
/taste help
```

## 12. 存储结构

Global 状态：

```text
~/.pi/agent/taste/
├── config.json        # 扩展配置
├── events.jsonl       # 仅追加的反馈与审计事件
├── preferences.json   # 权威偏好状态
├── curation.json      # 最近一次 Curator 计划（存在时）
└── taste.md           # 自动生成、仅含 approved 的可读视图
```

Taste 为该工作区加载时，会在解析出的项目根目录下初始化 Project 状态。存在 Git 根目录时使用最近的 Git 根目录，否则使用 Pi 当前工作目录：

```text
<project-root>/.pi/taste/
├── .gitignore         # 防止意外公开私有状态
├── config.json        # 项目专属开关；Global Taste 默认开启
├── events.jsonl
├── preferences.json
└── taste.md
```

各文件职责：

- `preferences.json` 是权威状态；
- `taste.md` 是自动生成的 approved-only 视图，也是活动卡片显示的 Taste 路径；
- `events.jsonl` 是仅追加审计记录；
- 项目 `config.json` 同时控制 Global 注入，以及当前项目的自动学习能否归入 Global；
- 不支持通过直接编辑生成的 `taste.md` 来管理状态。

写入过程使用原子替换和跨进程文件锁。在平台支持时，存储文件会使用私有权限创建。

## 13. Command Code 兼容性

以下文件可以作为可选的只读 approved 来源：

```text
~/.commandcode/taste/taste.md
<project-root>/.commandcode/taste/taste.md
<project-root>/.commandcode/taste/<category>/taste.md
```

Pi Taste 会规范化这些条目，并与 Pi 偏好去重。它永远不会修改 Command Code Taste 文件。可疑或格式异常的 category 路径会被排除。Global Command Code Taste 使用相同的项目级 `/taste global on|off` 开关，并在新初始化的项目中默认开启。

## 14. 配置文件

默认 `~/.pi/agent/taste/config.json`：

```json
{
  "version": 1,
  "learningEnabled": true,
  "injectionEnabled": true,
  "observer": {
    "modelMode": "inherit",
    "models": [],
    "reasoning": "low",
    "maxOutputTokens": 2000,
    "timeoutMs": 45000,
    "maxInputChars": 24000
  },
  "injection": {
    "includeCommandCode": true,
    "maxPreferences": 80,
    "maxChars": 16000
  }
}
```

默认 `<project-root>/.pi/taste/config.json`：

```json
{
  "version": 1,
  "includeGlobalTaste": true
}
```

请使用 `/taste global on|off`，而不是手工编辑该文件。

隔离测试可以使用 `PI_TASTE_DIR=/tmp/pi-taste-test` 重定向 global Taste 存储。它不会移动或复制 Provider 凭据。

## 15. 隐私与安全

- 在交互摘录发送给 Observer 或写入审计事件前，会对常见 Token 和密钥模式进行脱敏。
- 用户消息和 Agent outcome 都有长度限制。
- 脱敏属于纵深防御，不是完整的秘密扫描器。
- `events.jsonl` 仍可能包含敏感反馈或代码片段，应当视为私有文件。
- 活动卡片包含偏好文本和绝对文件路径，但不会发送给模型。
- Provider 凭据永远不会复制到 Taste 配置或扩展源码。

## 16. 备份并在其他设备复用

扩展源码可以从 GitHub 重新安装。要完整保留学习行为，应备份私有 Taste 状态，而不是只复制生成的 `taste.md`：

```text
~/.pi/agent/taste/
<project-root>/.pi/taste/   # 需要保留 Project Taste 时
```

可以为 global 状态创建私有加密备份：

```bash
tar -C ~/.pi/agent -czf - taste \
| gpg --symmetric --cipher-algo AES256 \
  -o ~/pi-taste-backup.tar.gz.gpg
```

恢复：

```bash
mkdir -p ~/.pi/agent
gpg --decrypt ~/pi-taste-backup.tar.gz.gpg \
| tar -xzf - -C ~/.pi/agent
```

不要把 Provider auth 文件或未加密的 Taste 审计日志提交到公开仓库。也不要让两台设备同时修改同一份同步中的 `events.jsonl` 和 `preferences.json`；文件锁只保护单台设备，并不是跨设备合并协议。

## 17. 故障排查

### 没有出现活动卡片

先检查：

```text
/taste status
```

可能原因：

- learning 已关闭；
- 当前进程是 `--no-session` 或 `pi-subagents` 子进程；
- 后台 Observer 尚未完成；
- 扩展已经更新，但 Pi 尚未重新加载。

修改扩展文件后执行 `/reload`。

### 卡片显示“pending; not injected”

这是预期行为。可以手工批准：

```text
/taste review <id> approve
```

也可以等待重复的独立证据对它进行强化。

### Observer unavailable 或失败

使用：

```text
/taste model status
/taste model inherit
```

如果处于 custom 模式，请确认配置的 provider/model 存在且拥有可用凭据。Taste 不会偷偷切换到未配置模型。

Footer 中的 `!` 表示最近一次仍未恢复的 Observer 失败。成功完成一次检查、更改 Taste 模型、切换 learning 开关或执行 `/reload` 后，`!` 会清除。历史失败事件仍保留在 `events.jsonl` 中用于审计，但启动时不会重新恢复警告。

### `taste.md` 中没有 pending 偏好

`taste.md` 只包含 approved 条目。Pending 和其他非活动偏好保存在 `preferences.json`，可以通过 `/taste list all` 查看。

### Footer 消失但卡片仍可用

可能有其他扩展占用了 Pi 唯一的自定义 footer。活动卡片和学习流程不受影响。

### 重建可读视图

```text
/taste curate rebuild
```

该命令根据权威 `preferences.json` 重新生成 `taste.md`，不会调用模型。

## 18. 设计参考

Command Code 的 Taste 文档给出了以下目标函数：

```text
Meta-NeuroSymbolic Objective(φ)
= E[x~D_RL] E[y~LLM^NS_φ(x)] [
    RM_NS(x,y) - β_NS log(LLM^NS_φ(y|x) / LLM^SFT(y|x))
  ]
  + γ_NS E[x~D_pretrain] log LLM^NS_φ(x)
```

Pi Taste 并不进行在线权重训练，而是实现一个透明、可操作的对应架构：

- `RM_NS`：只接受有依据的用户证据；
- 稳定性/变化惩罚：保守更新和明确状态迁移；
- 预训练/稳定项：稳定、可读的指令和确定性注入；
- 神经符号分工：模型提出语义解释，程序负责证据校验和持久化。

## 许可证

[MIT](LICENSE) © 2026 LycanW
