# agent-shell-chat

[![npm](https://img.shields.io/npm/v/agent-shell-chat)](https://www.npmjs.com/package/agent-shell-chat)

通过微信直接使用本地 AI Agent。

`agent-shell-chat` 使用微信 iLink Bot API 接收私聊消息，通过
Agent Client Protocol（ACP）将消息转发给本地 Agent，再把回复、图片和文件发送回微信。

```text
微信私聊  <->  agent-shell-chat  <->  ACP Agent
```

## 核心功能

- **支持主流 Agent**：内置 Copilot、Claude Code、Gemini CLI、Qwen Code、Codex、OpenCode、Kimi 等预设。
- **兼容任意 ACP Agent**：既可以使用内置预设，也可以传入自定义启动命令。
- **微信扫码登录**：登录信息保存在本地，无需每次重新扫码。
- **连续会话**：每个微信用户拥有独立的 Agent 会话和上下文。
- **文件与图片收发**：微信文件会保存到本地供 Agent 读取；Agent 可通过 `@send:` 标记发送文件。
- **后台运行**：支持守护进程、状态查询、停止和本地消息注入。
- **多账号支持**：多个微信账号可分别绑定不同 Agent 和项目目录。

> 当前只处理微信私聊消息，群聊消息会被忽略。

## 环境要求

- Node.js 20 或更高版本
- 可使用 iLink Bot API 的微信环境
- 对应 Agent 所需的账号及认证信息

## 安装

推荐直接通过 `npx` 运行，无需全局安装：

```bash
npx -y agent-shell-chat@latest --help
```

也可以全局安装：

```bash
npm install -g agent-shell-chat
agent-shell --help
```

## 快速开始

### 1. 登录微信

```bash
npx -y agent-shell-chat@latest login
```

根据终端提示添加账号名称，并使用微信扫描二维码。登录信息默认保存在
`~/.agent-shell/`。

### 2. 启动 Agent

使用内置 Agent 预设：

```bash
npx -y agent-shell-chat@latest --agent copilot
```

指定 Agent 操作的项目目录：

```bash
npx -y agent-shell-chat@latest --agent codex --cwd D:\code\my-project
```

使用自定义 ACP 启动命令：

```bash
npx -y agent-shell-chat@latest --agent "npx my-agent --acp"
```

启动后，在微信中向 Bot 发送私聊消息即可。

## 内置 Agent

查看当前版本提供的全部预设：

```bash
npx -y agent-shell-chat@latest agents
```

常用预设包括：

```text
copilot  claude  gemini  qwen  codex  opencode
openclaw  kiro  hermes  kimi  pi
```

不同 Agent 可能需要提前完成各自的登录或 API Key 配置。

## 常用操作

### 后台运行

```bash
npx -y agent-shell-chat@latest --agent codex --cwd D:\code\my-project --daemon
```

查看运行状态或停止进程：

```bash
npx -y agent-shell-chat@latest status
npx -y agent-shell-chat@latest stop
```

日志保存在对应账号的存储目录中。

### 多账号

添加并查看账号：

```bash
npx -y agent-shell-chat@latest login --account-name work
npx -y agent-shell-chat@latest accounts
```

为指定账号启动不同的 Agent：

```bash
npx -y agent-shell-chat@latest --account work --agent claude --cwd D:\code\project-a --daemon
```

### 收发文件

微信收到的文件默认保存到账号目录下的 `inbox/`，Agent 会在消息中收到文件的绝对路径。

Agent 回复时可使用以下格式把文件发送到微信：

```text
报告已生成：@send:output/report.pdf
```

`@send:` 后的文件必须位于 Agent 工作目录内。可通过
`--auto-send-media off|tagged|all` 控制自动发送策略，默认使用 `tagged`。

### 本地注入消息

向正在后台运行的实例发送一条本地消息：

```bash
npx -y agent-shell-chat@latest inject --account work --text "总结今天的代码变更"
```

也可以从文件读取消息：

```bash
npx -y agent-shell-chat@latest inject --account work --file ./prompt.txt
```

## 微信内置命令

以下命令由 bridge 直接处理，不会转发给 Agent：

```text
/acp-config                         查看当前 Agent 的会话配置
/acp-config set <配置项> <值>       修改会话配置
/acp-cancel                         取消当前任务
/acp-cancel all                     取消当前任务并清空等待队列
```

## 常用参数

| 参数 | 说明 |
| --- | --- |
| `--agent <预设或命令>` | 选择内置 Agent 或自定义 ACP 命令 |
| `--cwd <目录>` | 设置 Agent 工作目录 |
| `--account <名称>` | 选择已保存的微信账号 |
| `--daemon` | 在后台运行 |
| `--system-prompt <文本>` | 为每个新会话设置系统提示词 |
| `--inbox-dir <目录>` | 修改微信文件保存目录 |
| `--no-inbox` | 禁止保存微信收到的文件 |
| `--max-sessions <数量>` | 设置最大并发用户会话数 |
| `--idle-timeout <分钟>` | 设置会话空闲超时，`0` 表示不清理 |
| `-v, --verbose` | 输出详细日志 |

查看完整参数：

```bash
npx -y agent-shell-chat@latest --help
```

## 本地开发

```bash
npm ci
npm run build
npm test
node dist/bin/agent-shell.js --help
```

## License

[MIT](LICENSE)
