# Pi Chat

[English](./README.en.md)

[![CI](https://github.com/bsin-ai/pi-chat/actions/workflows/ci.yml/badge.svg)](https://github.com/bsin-ai/pi-chat/actions/workflows/ci.yml)

![Pi Chat 产品封面](./docs/assets/pi-chat-cover.png)

**面向 Mac 用户的轻量级 AI 工作助手**

Pi Chat 把项目、对话、文件和 Skill 放在一个桌面应用中。配置好模型后，你可以像使用其他 Mac 应用一样，用自然语言发起任务，不必单独理解或操作 pi Agent 的命令行流程。

## 目录

- [Pi Chat 是什么](#pi-chat-是什么)
- [Pi Chat 可以做什么](#pi-chat-可以做什么)
- [下载安装](#下载安装)
- [第一次使用](#第一次使用)
- [主要功能](#主要功能)
- [隐私与安全](#隐私与安全)
- [常见问题](#常见问题)
- [当前限制](#当前限制)
- [从源码运行](#从源码运行)
- [开源许可](#开源许可)

## Pi Chat 是什么

Pi Chat 是面向 Mac 用户的轻量级 AI 工作助手，也是 [pi 编程智能体](https://github.com/earendil-works/pi) 的本地桌面界面。它把项目、对话、文件和 Skill 放在同一个应用中，让你可以选择自己的模型服务商、API Key 和模型，再用日常语言描述任务。

Pi Chat 本身不提供 AI 模型。你需要连接自己选择的模型服务商，并遵守该服务商的价格、额度和使用规则。

### 核心价值

Pi Chat 希望通过以下方式让日常工作更直接：

- 减少工具配置，让你在一个桌面应用中开始工作。
- 减少重复输入和不必要的上下文，帮助减少不必要的 Token 消耗。
- 让模型更专注于当前任务和你提供的资料。
- 用桌面界面代替复杂的命令行操作。

### 适合哪些用户

- 想在自己的 Mac 上使用 AI 助手，但不想先学习复杂命令行流程的人。
- 需要整理资料、处理文档、分析项目或持续跟进多个任务的人。
- 希望保留本地项目和对话管理方式，同时按需连接不同模型服务商的人。
- 开发者也可以从源码运行和扩展 Pi Chat，但日常使用不需要编程能力。

## Pi Chat 可以做什么

Pi Chat 适合处理需要阅读资料、整理信息或持续推进的工作，例如：

- 整理和分析会议记录、研究资料和其他文本。
- 阅读和处理 Word、PDF、Excel、PPT、Markdown 和纯文本文件。
- 协助代码和项目任务，理解项目内容并查看修改结果。
- 预览源码、Markdown、图片、音频、PDF 和 DOCX 文件。
- 查看 Git Diff，了解文件发生了哪些变化。
- 管理多个项目和历史对话，按项目继续工作。
- 继续已有对话，或从当前对话创建分支来尝试另一种方向。

![Pi Chat 工作区](./docs/assets/pi-chat-main.png)

## 下载安装

### 1. 检查 Mac 芯片

当前桌面版本主要支持 **Apple Silicon** Mac，包括 M1、M2、M3、M4 及后续型号。Intel Mac 暂不支持。

### 2. 从 GitHub Releases 下载 DMG

打开 [Pi Chat GitHub Releases](https://github.com/bsin-ai/pi-chat/releases)，在最新 Release 的 **Assets** 区域点击 `Pi-Chat-1.1.0-arm64.dmg` 下载 Apple Silicon 安装包。只从可信的 GitHub Releases 页面下载；如果文件名不同，请选择 Release 中实际提供的 `.dmg` 文件。

[直接下载 Pi-Chat-1.1.0-arm64.dmg](https://github.com/bsin-ai/pi-chat/releases/download/v1.1.0/Pi-Chat-1.1.0-arm64.dmg)

### 3. 将应用拖入“应用程序”

打开下载的 DMG，把 **Pi Chat** 拖到 **Applications（应用程序）** 文件夹，然后从“应用程序”中启动 Pi Chat。普通用户安装 DMG 不需要 Node.js。

![将 Pi Chat 拖入应用程序](./docs/assets/pi-chat-install.png)

### 4. 首次打开时处理 macOS 安全提示

当前版本尚未完成 Apple Developer 签名和公证。由于 macOS 会对从互联网下载的应用进行安全检查，首次打开 Pi Chat 时可能显示“无法验证开发者”或“应用已损坏”等提示。

请确认应用来自本项目官方 [GitHub Releases](https://github.com/bsin-ai/pi-chat/releases) 页面，并已将 **Pi Chat** 拖入“应用程序”。然后打开“终端”，粘贴并执行以下命令：

```bash
xattr -dr com.apple.quarantine "/Applications/Pi Chat.app"
```

命令执行完成后，回到“应用程序”文件夹，再次双击 **Pi Chat** 即可启动。该命令仅移除 macOS 对此应用的下载隔离标记；请勿对来源不明的应用执行此操作。

## 第一次使用

![Pi Chat 设置面板](./docs/assets/pi-chat-settings.png)

### 1. 配置模型和 API Key

打开 **Models** 面板，添加一个 Provider，填写 API Key 并选择模型；如果服务商支持，也可以使用其登录方式。发送敏感内容或大量内容前，请先确认服务商的价格、额度、账单和数据保留规则。

API Key 是敏感信息，请妥善保管，不要公开、提交到仓库或通过截图分享。

### 2. 安装常用 Skill

Skill 为特定任务增加能力。在 **Skills** 面板中按需安装，并选择作用范围：

| Skill | 适合的任务 |
| --- | --- |
| `docx` | 读取和处理 Word 文档 |
| `pdf` | 阅读和处理 PDF |
| `xlsx` | 处理 Excel 表格 |
| `pptx` | 读取和编辑演示文稿 |
| `markitdown` | 将资料转换为 Markdown |
| `tavily-search` | 搜索网页资料 |

不需要一次安装全部 Skill。可以先安装当前任务需要的能力，之后再按项目或工作内容补充。Skill 可以对所有项目生效，也可以只对当前项目生效。

### 3. 发起第一个对话

创建或选择一个项目，在聊天输入框中用自然语言描述目标，需要时附加或浏览相关文件。涉及文件修改时，先在应用中查看结果和变更，再决定是否接受。

## 主要功能

### 1. 用自然语言直接开始任务

直接描述你想完成的事情，Pi Chat 会根据当前项目和对话上下文协助你整理、分析、查找或修改内容。你不需要先记住命令或内部目录。

### 2. 用项目、标题和置顶整理工作

把对话放在对应项目中，为重要任务设置标题并置顶，方便回到正在推进的工作。项目和对话可以分别管理，适合同时处理多个主题。

### 3. 按活动记录或项目查找对话

从侧边栏查看最近活动，也可以按项目浏览历史对话。这样可以快速找到刚刚使用过的任务，或回到某个项目的长期工作记录。

### 4. 查看任务过程、结果、上下文和费用

运行任务时可以查看进度和过程；完成后可以查看结果、使用的上下文、费用和相关运行信息。Pi Chat 还支持预览文件和查看 Git Diff，便于检查模型提出的修改。

### 5. 使用聊天导航浏览长对话

对话较长时，可以使用聊天导航快速定位不同消息和任务阶段，减少在长页面中反复滚动的时间。

### 6. 继续任务、创建分支和导出对话

可以继续已有对话，也可以从较早消息创建独立分支，或在当前对话中从某个位置尝试另一种方向。需要留档或分享时，可以导出对话内容。

### 7. 自定义界面外观和语言

Pi Chat 支持英文和简体中文界面，并提供外观设置。首次打开时会参考浏览器语言，你也可以在界面中随时切换语言和外观。

## 隐私与安全

- Pi Chat 运行在你自己的 Mac 上，聊天记录和部分应用设置默认保存在本机。
- 重新安装应用通常不会删除已有聊天记录；换到另一台 Mac 时，聊天记录不会自动跟随，需要自行备份或迁移。
- 使用 AI 模型时，你输入的内容可能会发送给自己选择的模型服务商。请先查看服务商的隐私政策、数据保留规则、价格和额度。
- Skill 可能调用外部服务。处理敏感文件前，请确认对应 Skill 会使用哪些服务，以及文件是否会离开本机。
- API Key 是敏感信息，不能公开、提交到仓库，也不要通过截图分享。
- Pi Chat 本身不提供 AI 模型；模型费用和服务条款由你选择的服务商决定。
- 分享 Pi Chat 应用不会自动分享聊天记录、API Key 或个人设置。其他用户需要在自己的 Mac 上配置自己的模型服务。

## 常见问题

### 是否需要安装 Node.js？

下载 DMG 的普通用户不需要 Node.js。只有从源码运行或参与开发时，才需要 Node.js **22.19.0 或更高版本**。

### 是否需要编程能力？

日常使用不需要编程能力。你可以直接用自然语言描述任务；从源码运行和参与开发时，才需要基本的命令行知识。

### Pi Chat 是否免费？

Pi Chat 项目使用 MIT License，应用本身不收取使用费。模型服务可能需要 API Key，模型费用由你选择的服务商决定。

### 聊天记录保存在哪里？

聊天记录默认保存在你的 Mac 本机。

### 重新安装是否会删除聊天记录？

重新安装应用通常不会删除已有聊天记录。删除用户数据、手动清理数据或更换运行环境可能造成数据丢失，重要会话请提前备份。

### 如何更新 Pi Chat？

当前版本不支持自动更新。请从 [GitHub Releases](https://github.com/bsin-ai/pi-chat/releases) 下载新的 DMG，并替换“应用程序”中的旧应用。

## 当前限制

- 目前仅支持 macOS。
- 当前主要支持 Apple Silicon，暂不支持 Intel Mac。
- 暂不支持 Linux。
- 暂不提供 App Store 版本。
- 当前版本尚未完成 Apple Developer 签名和公证，首次打开可能出现 macOS 安全提示。
- 暂不支持自动更新。
- 模型服务可能需要 API Key，并可能产生费用。

## 从源码运行

本节面向开发者，普通用户使用 DMG 时可以跳过。普通用户不需要 Node.js；只有从源码运行或参与开发时才需要 Node.js **22.19.0 或更高版本**。

先检查版本：

```bash
node --version
```

安装并运行：

```bash
git clone https://github.com/bsin-ai/pi-chat.git
cd pi-chat
npm ci
npm run build
npm start
```

启动后打开 [http://127.0.0.1:30141](http://127.0.0.1:30141)，再在 **Models** 面板配置自己的 Provider、API Key 和模型。

开发模式：

```bash
npm ci
npm run dev
```

常用检查：

```bash
npm test
node_modules/.bin/tsc --noEmit
npm run lint
```

高级环境变量、HTTP 代理、远程访问和 HTTPS、Git worktree、扩展集成等内容请参阅[高级配置](./docs/advanced-configuration.md)。贡献者还可以阅读[国际化](./docs/i18n.md)、[发布流程](./docs/release.md)、[Pi Chat 里的 Worktree](./docs/worktrees.zh-CN.md)和英文版 [Worktrees in Pi Chat](./docs/worktrees.md)。

## 开源许可

Pi Chat 遵循 [MIT License](./LICENSE)。
