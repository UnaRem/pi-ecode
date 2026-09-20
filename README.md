# pi ecode

**简体中文** | [English](README.en.md)

一个简洁、本地优先的 [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) Electron 桌面界面。它专注于个人开发工作流：选择项目、继续 pi 会话、实时查看工作过程、检查工具活动，以及停止或纠正智能体。

## 当前 MVP

- 选择本地项目目录
- 按项目持久化会话
- 新建和恢复会话
- 流式显示助手回复
- 折叠或展开工具活动与输出
- 智能体工作期间停止任务或发送纠偏消息
- 选择可用模型和思考等级
- 项目专属的影子 Git 检查点，以及与会话关联的撤销/重做
- 由宿主运行固定的 `typecheck → test → build` 验证流程，支持实时日志、取消和结果过期标记
- 自动识别 pi-ecode 源码工作区为可自托管项目
- 查看当前任务的变更文件、行数统计和统一补丁，并可按文件拒绝变更
- 持久化更新记录，保留启用、失败和丢弃结果，以及最多三个候选产物
- 在隔离目录准备候选版本，并冻结当前运行版本作为回退
- 通过渲染端和运行时健康确认安全重启，失败时自动回退
- 恢复上次打开的项目

应用会直接使用 `~/.pi/agent` 中已有的 pi 配置和凭据。打开桌面应用前，请先通过 pi CLI 配置可用模型。

## 本地运行

要求：Node.js 24+，并已完成 pi 配置。

```bash
npm install
npm run dev
```

`npm run preview` 会自动识别当前源码目录，并在窗口出现前将其作为活动的自托管项目打开。候选运行时和回退运行时会根据暂存元数据恢复相同的源码根目录。

如果使用的 npm 版本会延迟下载 Electron 二进制文件，请在安装依赖后执行一次：

```bash
npm exec electron -- --version
```

## 验证与构建

```bash
npm run typecheck
npm test
npm run build
```

未打包的生产构建输出到 `out/`。在 Windows x64 上运行 `npm run package:win` 会在 `release/` 中生成免安装的 `PiECode-<version>-win-x64.exe`。应用内验证面板只运行已配置的 `typecheck`、`test` 和 `build` package scripts，不接受渲染端传入的任意命令。

## 发布

每次向 `main` 推送提交时，GitHub Actions 都会安装依赖、运行测试并构建 Windows x64 免安装程序。全部成功后，以 `package.json` 的主、次版本和本次 Actions 运行编号创建**独立 Release**，例如基础版本为 `0.1.0`、运行编号为 `42` 时：

```text
Release / 标签：v0.1.42
下载文件：PiECode-v0.1.42-win-x64.exe
```

CI 只在构建工作区临时更新包版本，应用内部版本与文件名相同，不向 `main` 提交版本变更。失败的运行不会发布，编号可能跳号；重新运行同一次工作流仍使用原编号，若同名标签已存在则会拒绝覆盖。为确保连续推送各自构建，不再取消先前运行。原有 **Continuous build** Release 和 `continuous` 标签保留作为历史记录，不再移动或更新；新 Release 会由 GitHub 自动生成更新说明。

如需手动发布指定版本，将 `package.json` 的版本提交到 `main`，然后推送同版本的 `v*` 标签：

```bash
npm version 0.2.0
git push origin main
git push origin v0.2.0
```

手动标签 Release 的产物名称沿用 `PiECode-0.2.0-win-x64.exe`。所有发布产物当前均不含 Windows 代码签名，首次下载运行时可能出现 Microsoft Defender SmartScreen 提示。

拒绝某个已审查文件时，只会将该路径恢复到任务开始前的状态，然后为结果创建检查点，并使之前的验证结果和候选版本失效。默认行为是保留文件；准备候选版本时会采用其余已审查的变更。

对于已识别的 pi-ecode 源码项目，通过验证后可以将候选版本暂存到 `~/.pi/agent/state/pi-ecode-self-update`。应用会冻结当前运行产物作为上一版本，在独立位置暂存候选版本，再通过外部监督进程启动。候选版本必须在 25 秒内恢复渲染端和初始 pi 项目运行时；否则监督进程会终止候选版本并启动冻结的上一版本。监督结果会同步到 `ledger.json`；旧产物目录被清理后，其丢弃记录仍会保留。目前这条启用流程只面向未打包的开发运行时；在实现可感知安装包的外部启动器前，打包版本的安装程序替换功能保持禁用。

## 架构

```text
React 渲染进程
     │ 类型安全、范围受限的 contextBridge API
Electron 预加载脚本
     │ 具名 IPC 通道
Electron 主进程 ── @earendil-works/pi-coding-agent SDK
```

渲染进程不能访问 Node.js。主进程负责活动 pi 运行时、会话生命周期、模型状态、文件系统操作和工作区历史。历史记录存放在项目目录之外的 `~/.pi/agent/state/pi-ecode-workspace-history`，不会向项目 Git 仓库添加提交。项目规则、源码结构和 MVP 边界见 [AGENTS.md](AGENTS.md)。

仓库中的 `docs/` 和 `examples/` 目录是随项目保存的上游 pi 参考资料，不属于应用源码。
