# Changelog

本项目的显著改动都记在这里。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

> 2026-11 之前各落地批次的完整实测记录（依据、验证命令、踩坑细节）在
> [docs/LANDING-ARCHIVE-2026-11.md](docs/LANDING-ARCHIVE-2026-11.md)，
> 按日期命名的 `CHANGES-*.md` 为当时的单次会话存档，不再逐条搬进本文件。

## [2.0.0] - 2026-11-23

> 合入上游 2.0.0。`stable/` 快照退役，fork 的单端口与数据挂载保持不变。

### Added

- **README**：补充 npm 安装与前端构建说明。

### Changed

- **Windows 启动**：托盘和 `start-dev.bat` 都从 `src/` 启动，管理页面和模型 API 共用 `9080`，内部网关监听 `127.0.0.1:18081`。
- **保留 fork 部署**：`compose.yaml` 仍只发布 `9080`，挂载原 `DUMATE_DATA_DIR`（默认 `./data`）；Windows 登录助手和桌面认证文件上传保持不变。

### Removed

- **`stable/` 冻结快照退役（破坏性）**：删除 `stable/`（106 文件）——它已落后主目录 133 个文件、
  且不含管理端，无法独立成一套服务。同步删除 `scripts/snapshot-closure.js` 与
  `docs/STABLE-SNAPSHOT.md`，发布流程随之取消。
  - `src/service-identity.js` 的 `-stable` 后缀判定保留（正常检出不带该后缀），
    注释标注为历史遗留；`DUMATE_ROLE` 仍可显式指定任意 role。
  - 历史归档文档（`LANDING-ARCHIVE`、`GITHUB-*`、`FUSION-*` 等）保留原文，仅两份活指导文档
    （`LANDING-2026-11-16.md`、`DEV-CHECKLIST-2026-11-04.md`）加了退役横幅。

### Fixed

- **OpenAI Chat**：将 `max_completion_tokens` 归一为 `max_tokens`；同时传入时取较大值，再按通道预算约束处理，避免兼容客户端请求失败或预算丢失。
- **WorkBuddy 保活**：修正 `channel-pool` 模块路径，恢复账号池额度写回，并验证查询失败的账号不会写成零额度。

## [1.1.0] - 2026-11（历史）

五通道（搭子 / 千问办公 / TRAE Work / Qoder / WorkBuddy）+ 三协议网关，逐批落地记录见
[docs/LANDING-ARCHIVE-2026-11.md](docs/LANDING-ARCHIVE-2026-11.md)。

[Unreleased]: https://github.com/wearetheone777/dumate2api/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/wearetheone777/dumate2api/releases/tag/v2.0.0
