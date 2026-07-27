# Codeg

[![Release](https://img.shields.io/github/v/release/xintaofei/codeg)](https://github.com/xintaofei/codeg/releases)
[![Docs](https://img.shields.io/badge/docs-docs.codeg.app-3451b2)](https://docs.codeg.app)
[![License](https://img.shields.io/github/license/xintaofei/codeg)](./LICENSE)

<p>
  <strong>English</strong> |
  <a href="./docs/readme/README.zh-CN.md">简体中文</a> |
  <a href="./docs/readme/README.zh-TW.md">繁體中文</a> |
  <a href="./docs/readme/README.ja.md">日本語</a> |
  <a href="./docs/readme/README.ko.md">한국어</a> |
  <a href="./docs/readme/README.es.md">Español</a> |
  <a href="./docs/readme/README.de.md">Deutsch</a> |
  <a href="./docs/readme/README.fr.md">Français</a> |
  <a href="./docs/readme/README.pt.md">Português</a> |
  <a href="./docs/readme/README.ar.md">العربية</a>
</p>

Codeg (Code Generation) is a multi-agent coding workspace: run every AI coding agent in one place — and let them work together.

It aggregates your sessions from every supported agent CLI into one searchable workspace, lets a main agent delegate to sub-agents of other types within a single task, and runs as a desktop app, a standalone server, or a Docker container.

![workspace](./docs/images/workspace-light.png#gh-light-mode-only)
![workspace](./docs/images/workspace-dark.png#gh-dark-mode-only)

## 📖 Documentation

**Full documentation lives at [docs.codeg.app](https://docs.codeg.app)** — [Getting Started](https://docs.codeg.app/getting-started/) · [Guide](https://docs.codeg.app/guide/) · [Reference](https://docs.codeg.app/reference/)

## 💖 Sponsors

<table>
  <tr>
    <td align="center" width="220">
      <a href="https://www.compshare.cn/?ytag=GPU_YY_git_codeg" target="_blank"><img src="./docs/images/compshare.png" alt="Compshare" width="160" /></a><br/>
      <strong><a href="https://www.compshare.cn/?ytag=GPU_YY_git_codeg">Compshare (UCloud)</a></strong>
    </td>
    <td>Thanks to Compshare for sponsoring this project! Compshare is UCloud's AI cloud platform, offering cost-effective monthly and pay-as-you-go agent Plan subscriptions for Chinese models, starting at just ¥49/month. It also provides stable officially-proxied access to overseas models. Supports Claude Code, Codex, and API integrations. Enterprise-ready with high concurrency, 24/7 technical support, and self-service invoicing. Users who sign up via <a href="https://www.compshare.cn/?ytag=GPU_YY_git_codeg">this link</a> receive ¥5 in free platform credits!</td>
  </tr>
  <tr>
    <td align="center" width="220">
      <a href="https://sui-xiang.com/register?aff=JPFCRHHBE8HE" target="_blank"><img src="./docs/images/sui-xiang.jpg" alt="随想AI中转站" width="200" /></a><br/>
      <strong><a href="https://sui-xiang.com/register?aff=JPFCRHHBE8HE">随想AI中转站</a></strong>
    </td>
    <td>Thanks to 随想AI中转站 for sponsoring this project! 随想AI中转站 is a reliable and efficient API relay provider, offering relay services for Claude, Codex, Gemini, and more. New accounts earn ¥0.5 in test credit with each daily check-in after <a href="https://sui-xiang.com/register?aff=JPFCRHHBE8HE">signing up</a>; top-ups are credited 1:1 — no subscription, pay as you go. Multi-route redundancy, cross-region disaster recovery, and automatic failover keep long-lived SSE connections uninterrupted.</td>
  </tr>
  <tr>
    <td align="center" width="220">
      <a href="https://hezu.ink/sign-up?aff=0wVz" target="_blank"><img src="./docs/images/hezu-ink.jpg" alt="合租巴士" width="200" /></a><br/>
      <strong><a href="https://hezu.ink/sign-up?aff=0wVz">合租巴士</a></strong>
    </td>
    <td>Thanks to 合租巴士 for sponsoring this project! 合租巴士 is a reliable and efficient AI relay platform, offering highly stable relay for mainstream models such as Codex and Claude Code. Top-ups are credited at a transparent 1:1 ratio, with Codex rate subsidies as low as 0.08. <a href="https://hezu.ink/sign-up?aff=0wVz">Join the group via the official website to get $5 in trial credit</a>.</td>
  </tr>
  <tr>
    <td align="center" width="220">
      <a href="https://onehop.ai/platform/login?ref=CODEG&utm_source=github&utm_medium=readme_sponsor&utm_campaign=codeg&utm_content=sponsor_cta" target="_blank"><img src="./docs/images/onehop.jpg" alt="OneHop" width="120" /></a><br/>
      <strong><a href="https://onehop.ai/platform/login?ref=CODEG&utm_source=github&utm_medium=readme_sponsor&utm_campaign=codeg&utm_content=sponsor_cta">OneHop</a></strong>
    </td>
    <td>Thanks to OneHop for sponsoring this project! OneHop gives Codeg users one OpenAI-compatible API key for hundreds of leading models, including GPT, Claude, Gemini, DeepSeek, Kimi, and Qwen. Switch models without managing multiple provider accounts or repeatedly changing your code, and pay only for what you use. <a href="https://onehop.ai/platform/login?ref=CODEG&utm_source=github&utm_medium=readme_sponsor&utm_campaign=codeg&utm_content=sponsor_cta">Sign up through Codeg</a> to receive $1 in credit, then join the OneHop community and participate in the welcome activity for an additional $5 — up to $6 in test credit in total.</td>
  </tr>
</table>

> Want to become a Codeg sponsor? [Reach out to us by email.](mailto:itpkcn@gmail.com)

## 🤖 Supported Agents

Claude Code · Codex · Gemini · OpenClaw · OpenCode · Cline · Hermes · CodeBuddy · Kimi Code · Pi · Grok · Cursor

Codeg installs, pins, and updates most of them for you. See [Supported Agents](https://docs.codeg.app/guide/supported-agents) for the full roster, each agent's runtime requirements, and where it keeps its sessions on disk.

## 🤝 Multi-Agent Collaboration

Multi-agent collaboration, reduced to a single keystroke: type `@`, pick an agent, hit send. Codeg handles the scheduling — it launches each mentioned agent as its own session, hands over the task, and streams the work back into the thread you're already in. Mention two and they run side by side: Claude Code drafting while Codex reviews. No context switching, no copy-pasting between terminals.

![Delegating a task to sub-agents from a single Codeg conversation](./docs/images/collaboration-light.gif#gh-light-mode-only)
![Delegating a task to sub-agents from a single Codeg conversation](./docs/images/collaboration-dark.gif#gh-dark-mode-only)

## 📄 Office Documents

Ask for a deck, a report, or a workbook and the agent builds a real `.pptx` / `.docx` / `.xlsx` — while the pane on the right renders it live. Every edit lands in the preview on its own: slides fill in, tables take shape, numbers land in cells. Don't like slide 4? Say so in the next message — the agent edits the same file in place and the preview catches up. No export step, no external Office app, no leaving Codeg.

![An agent editing an Office document beside its live in-tab preview](./docs/images/office-light.png#gh-light-mode-only)
![An agent editing an Office document beside its live in-tab preview](./docs/images/office-dark.png#gh-dark-mode-only)

## 💻 Workspace

One workspace, every agent. Whichever one is driving — Claude Code, Codex, Cursor — it works in the same editor, the same live diffs, the same git client, and what it produces is real files in your repo, changing while you watch.

**Sessions.** Pull in the history you already have: past sessions from every installed agent, imported in one click and resumable where you left them. Once they're in, they stop being separate silos — `@`-mention an old session and the agent you're talking to can read it, even when a different agent wrote it, so today's Codex run picks up where last week's Claude Code session ended.

**Files.** The agent's edits show up as diffs beside the conversation as they land. Open any file in a real editor with syntax highlighting, send a file — or just a selection — straight to the agent with `⌘L`, and preview Markdown, HTML, images, and Office documents in the same pane.

**Git.** A full client, not a status readout: commit and push, browse history with per-commit push state, and branch, merge, rebase, stash, reset, or diff against another branch. Conflicts open a three-pane merge editor where you accept hunk by hunk or type the fix yourself. And worktrees make parallel work one action — a new branch, its own directory, and a fresh conversation rooted in it, so a fleet of agents build different features at once without touching each other's files.

## ✨ Highlights

- **[Conversation Aggregation](https://docs.codeg.app/guide/aggregation)** — import sessions from every supported agent into one unified, searchable workspace, and pick any of them up where you left off
- **[Multi-Agent Collaboration](https://docs.codeg.app/guide/multi-agent)** — `@`-mention any agent to delegate: sub-agents of different types run as their own sessions, in parallel, inside a single task
- **[The Workspace](https://docs.codeg.app/guide/workspace)** — the full engineering loop next to the agent: file tree, editor and diff, git changes, commit, and an embedded terminal
- **[Git & Worktrees](https://docs.codeg.app/guide/git)** — review and commit changes, manage Git remote accounts, and run work in parallel with built-in `git worktree` flows
- **[Chat Channels](https://docs.codeg.app/guide/chat-channels)** — drive your agents from Telegram, Lark (Feishu), and iLink (Weixin): create tasks, approve permissions, and get live updates
- **[Automations](https://docs.codeg.app/guide/automations)** — save a fully-configured composer as a reusable automation that runs headlessly, on a cron schedule or on demand
- **[Office Documents](https://docs.codeg.app/guide/office)** — create, analyze, proofread, and edit `.docx` / `.xlsx` / `.pptx` through the bundled `officecli`, with live in-tab preview
- **[Scientific Research](https://docs.codeg.app/guide/research)** — bundled research skills (hypothesis generation, experimental design, statistics, visualization, critical appraisal, literature search) any agent can invoke
- **[Project Boot](https://docs.codeg.app/guide/project-boot)** — scaffold new projects visually, with live preview, then open them straight in the workspace
- **[MCP](https://docs.codeg.app/guide/mcp) & [Skills](https://docs.codeg.app/guide/skills)** — local server scan plus registry search/install, and skills managed at global or project scope
- **[Desktop, Server & Docker](https://docs.codeg.app/getting-started/deployment)** — a native desktop app, a standalone `codeg-server` you reach from any browser, or `docker compose up`

## 📦 Install & Run

**Desktop** — download the installer for macOS, Windows, or Linux from [Releases](https://github.com/xintaofei/codeg/releases), then follow [Installation](https://docs.codeg.app/getting-started/installation).

**Server** — run Codeg headless and reach it from any browser:

```bash
curl -fsSL https://raw.githubusercontent.com/xintaofei/codeg/main/install.sh | bash
codeg-server
```

**Docker** — the same server, in one container:

```bash
docker run -d -p 3080:3080 -v codeg-data:/data ghcr.io/xintaofei/codeg:latest
```

Compose, prebuilt binaries, source builds, and in-place updates are covered in [Deployment](https://docs.codeg.app/getting-started/deployment); environment variables in [Configuration](https://docs.codeg.app/getting-started/configuration). Building Codeg itself: [Development](https://docs.codeg.app/reference/development) and [Architecture](https://docs.codeg.app/reference/architecture).

## 🔒 Privacy & Security

- Local-first by default for parsing, storage, and project operations — network access happens only on user-triggered actions
- Web and server modes are guarded by token-based authentication
- System proxy support for enterprise environments

Details in [Privacy & Security](https://docs.codeg.app/reference/privacy).

## 👥 Community

- Scan the QR code below to join our WeChat group for discussions, feedback, and updates

<img src="./docs/images/weixin-light.jpg#gh-light-mode-only" alt="WeChat" width="240" />
<img src="./docs/images/weixin-dark.jpg#gh-dark-mode-only" alt="WeChat" width="240" />

- Thanks to the [LinuxDO](https://linux.do) community for their support

## 🙏 Acknowledgments

- [Agent Client Protocol](https://agentclientprotocol.com) — the foundation that lets Codeg connect to every agent it supports
- [Superpowers](https://github.com/obra/superpowers) — powers Codeg's expert skills module
- [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI) — powers Codeg's Office documents workflow
- [scientific-agent-skills](https://github.com/K-Dense-AI/scientific-agent-skills) — powers Codeg's Scientific Research skills (MIT-licensed subset)

## 📜 License

Apache-2.0. See [LICENSE](./LICENSE).
