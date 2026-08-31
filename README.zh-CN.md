# Pi Taste

[English](README.md) | **简体中文**

Pi Taste 是为 [Pi coding agent](https://github.com/earendil-works/pi-mono) 打造的本地 Taste 学习扩展。其学习管线采用与 [Command Code](https://commandcode.ai) Taste 相同的做法（不含云同步），因此完全本地化，并支持任意模型（包括你的 ChatGPT/Codex 账号）。

它**不会**训练或修改模型权重。学到的偏好落在单个可读的 `taste.md` 文件中。

Pi Taste 是一个以 Command Code 的 Taste 工作流为灵感编写的独立开源项目。

## 1. 快速上手

直接从 GitHub 安装 Pi 包：

```bash
pi install git:github.com/LycanW/pi-taste@v0.5.2
```

不安装试运行：

```bash
pi -e git:github.com/LycanW/pi-taste@v0.5.2
```

本版本基于 Pi 0.84.4 测试，要求 Node.js 22.19 或更高版本（与 Pi 运行时要求一致）。

安装或更新后重新加载 Pi：

```text
/reload
```

查看当前状态：

```text
/taste status
```

默认行为：

- Taste 开启：自动学习与 Taste 注入同时启用；
- Learner 跟随当前主模型（用 `/taste model` 可设置独立模型）；
- 自动学习在前台 Agent 完全结束后启动，可继续在后台与后续轮次并行。

常用命令：

```text
/taste list
/taste remember -g 以后回复尽量简洁，除非我要求详细。
/taste model status
```

## 2. 学习如何工作

当 `/taste on` 开启时，普通用户轮次会执行以下流程：

```text
用户可见消息 + Assistant 可见文本
    → 当前前台 Agent 完全结束
    → 后台 Learner（可调用工具的模型代理）
    → 模型自行读/写 taste.md
        read_taste_file / write_taste_file / edit_taste_file
    → 自动分类重组（>5 条学习 → {category}/taste.md）
    → 未来轮次通过 <taste> 注入完整 taste.md
```

Learner 获得与 Command Code 相同类型的上下文：

- **NEW 消息**：当前轮的用户/Assistant 可见文本（thinking、工具结果和元数据会被去除）；
- **之前分析窗口**：最近的周边上下文，仅用于解析引用，绝不重复学习；
- **当前 taste 结构**：taste 文件树及学习数量。

模型语义判断是否暴露了持久、可泛化的偏好：编码风格、工具链、工作流、沟通方式。每条记录为：

```text
- Prefers tabs over spaces. Confidence: 0.9
```

**没有状态机。**模型写入的任何内容都会被注入——与 Command Code 完全一致，包括低置信度条目。沉默反馈、一次性约束和事实性纠正由模型判断过滤，而非关键词规则。

用户在 Agent 流式期间插入的 steering 和 follow-up 也会被捕获，并与插入点的 Assistant 可见文本一起评估。

扩展会先为当前轮生成注入快照，再暂存当前反馈，因此新学到的偏好只能影响后续轮次。

使用 `--no-session` 启动的 Pi 进程，以及带有 `PI_SUBAGENT_CHILD=1` 标记的 `pi-subagents` 子进程，可以接收 Taste 注入，但不会产生学习事件。`PI_TASTE_ALLOW_NO_SESSION=1` 仅供隔离测试使用，且不能绕过 subagent 子进程保护。

## 3. 对话区活动卡片

Taste 记录以活动卡片形式出现在对话中，方便查看学习内容。卡片显示内容与路径；仅 TUI 可见，绝不进入模型上下文。

```text
✓ Taste Updated — 1 learned: Prefer tabs over spaces. (90%) → taste.md
State [global]: /home/user/.pi/agent/taste/taste.md
```

卡片覆盖：

- 学到的偏好（写入/编辑）；
- 分类重组；
- Learner 失败。

按 `Ctrl+O` 展开。展开后包含模型、事件 ID 和路径。

## 4. 安全

- 学习在 `agent_settled` 后启动；后续轮次不会等待或取消正在运行的 Learner（单并发队列）。
- 路径受限：模型只能操作 taste 目录内的 `taste.md` 或 `{category}/taste.md`。拒绝 `..`、绝对路径和其他名称。
- 反馈与 Assistant 文本会被限长并在发给 Learner 前脱敏（Token/密钥）。
- Provider 凭据从不进入 Taste 配置或源码。

## 5. Footer 状态

Taste 激活时，模型 Footer 会显示：

- `Taste:on` 或 `Taste:off`；
- `·N`：N 个 Learner 任务排队或运行中；
- `!`：最近一次 Learner 操作失败。

## 6. Taste 模型配置

默认模式为 `inherit`：Learner 使用当前主模型。切换 `/model` 会改变后续学习的模型。

```text
/taste model status       # 显示模式和当前模型
/taste model inherit      # 跟随当前主模型
/taste model select       # 打开 Pi 模型选择器（TUI）
/taste model set provider/model
/taste model only provider/model
/taste model add provider/model
/taste model remove provider/model
/taste model list [query]
```

## 7. 管理偏好

Taste 状态是单个可编辑的 `taste.md`。也可以用命令管理：

```text
/taste list [id|all]                 # 显示所有学习
/taste remember [-g] <preference>    # 手动记录（显式用户动作）
/taste move <id> [global|project]    # 作用域间移动
/taste forget <id>                   # 移除一条学习
/taste import <file> [-g] [--yes]    # 从 markdown 文件导入
```

- 默认作用域为 `project`；`-g` 指向全局存储。
- `import` 会去重并跳过疑似凭据的行；不调用模型。
- `forget` 删除该行。

## 8. Taste 开关

```text
/taste on | off
```

- `/taste on` 同时启用自动学习与注入；
- `/taste off` 同时禁用自动学习与全部 Taste 注入；存储状态保留。

没有独立注入开关，也没有项目级 Global 开关：与 Command Code 一致，Learner 写入项目存储（全局存储供显式 `-g` 管理）。旧版本的 `[pending]` 标记已不存在。

## 9. 存储结构

全局：

```text
~/.pi/agent/taste/taste.md
```

项目（最近的 Git 根，否则 Pi 工作目录）：

```text
<project-root>/.pi/taste/
├── .gitignore         # 防止意外公开私有状态
└── taste.md           # 单一权威偏好文件
```

`taste.md` 格式：

```text
- Prefers tabs over spaces. Confidence: 0.9
- Avoid worktrees. Confidence: 0.4
```

分类（>5 条）自动变为：

```text
<project-root>/.pi/taste/<category>/taste.md
```

根 `taste.md` 保留 `See [<category>/taste.md](<category>/taste.md)`。

写入使用原子替换和跨进程文件锁。平台支持时以私有权限创建文件。

## 10. Command Code 兼容性

Pi Taste 将现有 Command Code Taste 文件作为只读注入来源：

```text
~/.commandcode/taste/taste.md
<project-root>/.commandcode/taste/taste.md
<project-root>/.commandcode/taste/<category>/taste.md
```

它绝不修改这些文件，并与 Pi Taste 去重。自 v0.5.0 起，格式与学习行为遵循 Command Code，因此你可以让两个工具指向兼容文件。

## 11. 配置文件

默认 `~/.pi/agent/taste/config.json`：

```json
{
  "version": 3,
  "learningEnabled": true,
  "observer": {
    "modelMode": "inherit",
    "models": [],
    "reasoning": "low",
    "maxOutputTokens": 6000,
    "timeoutMs": 90000,
    "maxInputChars": 30000
  },
  "injection": {
    "maxChars": 16000
  }
}
```

`learningEnabled` 是总开关，同时控制自动学习与注入。

隔离测试可用 `PI_TASTE_DIR=/tmp/pi-taste-test` 重定向全局 Taste 存储。它不会移动或复制 Provider 凭据。

## 12. 隐私与安全

- 交互摘录发送给 Learner 前会脱敏常见 Token 和密钥模式。
- 用户消息与 Assistant 文本有长度限制。
- 脱敏是纵深防御，不是完整的密钥扫描器。
- `taste.md` 可能包含偏好文本，请视为私密。
- 活动卡片包含偏好文本与绝对路径，但不发送给模型。
- Provider 凭据从不进入 Taste 配置或源码。

## 13. 备份并在其他设备复用

扩展源码可从 GitHub 重新安装。要保留学到的行为，请备份私有 Taste 状态：

```text
~/.pi/agent/taste/
<project-root>/.pi/taste/
```

加密备份全局状态：

```bash
tar -C ~/.pi/agent -czf - taste \
| gpg --symmetric --cipher-algo AES256 \
  -o ~/pi-taste-backup.tar.gz.gpg
```

## 14. 故障排查

**什么都没学到。**

- 检查 `/taste status` —— `Taste: on` 且 footer 无 `!`。
- Learner 需要当前模型有可用的 Token/API。`/taste model status` 显示当前模型。
- 反馈必须包含真实偏好；沉默确认由模型判断忽略。

**Learner 失败（footer 显示 `!`）。**

- 运行 `/taste status` 查看最后错误。
- 常见原因：模型过载、超时、认证不可用。

**学到了意外内容。**

- 直接编辑 `taste.md`（人类可读），或 `/taste forget <id>`。

## 许可证

MIT
