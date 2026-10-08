<div align="center">
  <img src="docs/images/readme/icon.png" alt="SayForge 临时图标" width="96" height="96">

  # SayForge

  **适用于 Windows 的开源语音输入工具。**

  [English](README.md) · [版本发布](https://github.com/Akilaydin/OriApps.SayForge/releases) · [Issues](https://github.com/Akilaydin/OriApps.SayForge/issues)
</div>

## 项目介绍

SayForge 由 **OriApps** 独立维护：按下快捷键说话，使用本地模型或自定义云端
ASR API 转写，将文本插入当前输入框，可选用 AI 进行整理。

**来源说明：本项目基于** [SayIt](https://github.com/crosswk/SayIt)
（作者：**Liu Qianglong / crosswk** 及贡献者）的源代码开发，
并非仅仅受到其启发。保留原 Git 历史和版权署名，继续遵守
[AGPL-3.0](LICENSE) 许可证。本项目与原作者没有隶属或授权关系。

## 功能

- 全局快捷键、免提模式、Windows 文本粘贴、转写历史和热词。
- 本地识别、云端识别、OpenAI-compatible 音频 API。
- 标准 OpenAI `input_audio` 格式，可选择 WAV 或 MP3（64 kbps 单声道）。
- 独立的 System Instruction 和 User Prompt，可指定语言和技术术语。
- 可选 AI 文本整理。

## 安装与升级

独立构建版本将发布在 [GitHub Releases](https://github.com/Akilaydin/OriApps.SayForge/releases)。
目前不自动下载和安装更新，也不会从原 SayIt 的服务器更新。尚未发布经过签名验证的正式安装包。

默认服务器模式地址是 `http://127.0.0.1:8000`，需要自己部署服务器；
SayForge 没有公共语音试用服务器。也可以直接配置云端模型或使用本地模型。

## 从 SayIt 迁移

SayForge 使用独立的应用标识 `com.oriapps.sayforge` 和用户数据目录
`%LOCALAPPDATA%\com.oriapps.sayforge`。不会修改或自动复制原 SayIt 数据。
需要迁移时，可在原 SayIt 中导出配置，然后在 SayForge 中导入。
历史记录和音频不会随仅配置的导出自动迁移。

## 开发与贡献

客户端由 Rust、Tauri、React 和 TypeScript 开发。构建方法参见
[英文 README](README.md#development)，服务器说明参见 [server/README.md](server/README.md)。
欢迎在本仓库提交 Issues 和 Pull Requests。

## 许可证

SayForge 和基于原 SayIt 的修改部分继续采用 **GNU AGPL-3.0**。
MP3 编码器使用的 LAME 组件还受 **LGPL-3.0** 约束（见
[第三方声明](THIRD_PARTY_NOTICES.md)）；发布 Windows 安装包前必须完成相应合规检查。
