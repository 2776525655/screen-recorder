<div align="center">

# ⏺️ 屏刻 ScreenRec

**深色专业风桌面录屏工具 · Manual Screen Recording + Xbox-style Instant Replay**

一个对标 Xbox Game Bar 的 Windows 录屏工具：**手动录屏** + **记忆回放**（自动后台缓冲，随时保存最近 N 分钟）。基于 Electron + Vue 3 + WebCodecs + DXGI 构建，不闪鼠标、低占用、便携免安装。

[![GitHub stars](https://img.shields.io/github/stars/2776525655/screen-recorder?style=flat-square&label=GitHub%20%E2%AD%90&color=red)](https://github.com/2776525655/screen-recorder)
[![Gitee stars](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fgitee.com%2Fapi%2Fv5%2Frepos%2Fchenshusen%2Fscreen-recorder&query=stargazers_count&label=Gitee%20%E2%AD%90&color=orange)](https://gitee.com/chenshusen/screen-recorder)
![Version](https://img.shields.io/badge/version-0.6.0-2b7fff?style=flat-square)
![Platform](https://img.shields.io/badge/platform-Windows-0078d6?style=flat-square)
![Tech](https://img.shields.io/badge/Electron%20%2B%20Vue3%20%2B%20WebCodecs-8A2BE2?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)

**如果这个工具帮到了你，欢迎点个 ⭐ Star，你的鼓励是我更新的动力！**

[功能特性](#-功能特性) · [快速开始](#-快速开始) · [记忆回放](#-记忆回放) · [技术亮点](#-技术亮点) · [开发构建](#-开发构建) · [常见问题](#-常见问题)

</div>

---

## ✨ 功能特性

| 功能 | 说明 |
| --- | --- |
| 🎬 **手动录屏** | 点「录屏」→ 选择**整个屏幕或某个窗口** → 立即开录 |
| 🎞️ **记忆回放** | 开软件即自动后台缓冲最近 1/3/5 分钟，随时把刚才的精彩瞬间导出 MP4 |
| 📼 **录制悬浮条** | 录制中自动收起为迷你条：暂停 / 结束并保存，实时显示 `时长 · 文件大小` |
| 🎙️ **声音录制** | 自动录麦克风；开启 Windows「立体声混音」后自动混入系统声音（导出时合成） |
| 🖱️ **鼠标指针** | 可开关（默认开），录屏/回放画面均含鼠标箭头，不闪屏 |
| 🚀 **开机自启** | 登录后隐藏后台运行（仅托盘），自动开始记忆回放 |
| ⌨️ **全局快捷键** | `Ctrl+Alt+G` 唤出/隐藏 · `Ctrl+Alt+R` 开/停录屏 · `Ctrl+Alt+P` 暂停/继续 |

## 🚀 快速开始

### 方式一：直接使用（推荐体验）
从 **Releases** 下载 `ScreenRec-x.y.z-portable.exe`，**双击即用，无需安装、无需联网**。

> 便携版首次运行会在临时目录解压运行时，用户设置保存在 `%APPDATA%\屏刻 ScreenRec`。

### 方式二：从源码运行

```bash
git clone https://github.com/2776525655/screen-recorder.git
cd screen-recorder
npm install        # 安装依赖（koffi、mp4-muxer、vue 等）
npm run start      # 启动开发版
```

> ⚠️ **ffmpeg 依赖**：运行 / 打包前需自行下载 `ffmpeg.exe` 放入 `bin/` 目录（仓库为避免体积未包含）：
> 1. 下载 [ffmpeg-release-essentials.zip](https://www.gyan.dev/ffmpeg/builds/)（或任意 FFmpeg 构建）
> 2. 解压后把 `bin/ffmpeg.exe` 放到本项目的 `bin/` 目录下

### 录制系统声音（立体声混音）
右键任务栏喇叭 → 声音设置 → 更多声音设置 → 「录制」页 → 空白处右键勾选 **显示禁用的设备** → 启用「立体声混音」并设为默认。未开启时自动只录麦克风。

## 🎞️ 记忆回放

> 类似 NVIDIA ShadowPlay / Xbox Game Bar「录制最后 30 秒」——**错过就再也录不到的画面，它帮你提前录好了。**

1. 打开软件约 2 秒后自动开始后台缓冲（状态栏显示 `缓冲 xx / 03:00`）
2. 想保存时点蓝色 **「保存片段」** → 最近 N 分钟导出为 MP4，自动保存到视频目录
3. 时长 / 画质 / 帧率 / 系统声音均可在「设置」中调整（建议 12fps / 3 分钟，内存占用约 150MB 起）

## 🔧 技术亮点

- **鼠标不闪烁**：画面采集走 Chromium 桌面流（DXGI），而非 ffmpeg `gdigrab`，不碰 GDI 光标，录像过程鼠标平滑不闪
- **记忆回放零磁盘碎片**：H.264 帧存内存环形缓冲，点「保存」才合成 MP4，不产生临时分段文件
- **MP4 完整性**：基于 mp4-muxer 回写文件头（随机 offset 写盘），保证 moov 索引完整、成片任何播放器可播
- **DPI 自适应**：Windows 125%/150% 缩放下按物理像素采集编码，不出现只录左上角的问题
- **低占用**：UI + 后台合计约 150MB 内存起步，录制过程轻量高效

## 🗂️ 目录结构

```
screen-recorder/
├─ electron/                主进程（菜单/托盘/窗口/记忆回放控制）
│  ├─ main.js               应用主入口与状态机
│  ├─ ipc.js                录制临时文件 / 保存目录等 IPC
│  ├─ cursor.js             koffi 读取系统光标坐标
│  └─ engine/               记忆回放引擎控制器等
├─ src/                     渲染层（Vue 面板 + 后台采集页）
│  ├─ App.vue               捕获面板 UI（录制迷你条/选源/麦克风）
│  ├─ bgCapture.js          后台记忆回放引擎（DXGI → 内存环形缓冲）
│  ├─ lib/                  录制内核、音频混音、光标状态等
│  └─ composables/          手动录制编排
├─ capture.html / index.html / settings.html   Vite 多页入口
├─ bin/ffmpeg.exe           系统声旁路工具链（自行下载，~80MB）
├─ electron-builder.yml     便携单 exe 打包配置
└─ 录屏工具设计文档.md        完整设计 / 使用 / 构建文档
```

## 💻 开发构建

```bash
npm install            # 安装依赖
npm run build          # 构建渲染层 + 主进程（输出 dist/、dist-electron/）
npm run start          # 本地运行
npm run dist:portable  # 打包单文件便携版 → release/ScreenRec-<版本>-portable.exe
```

## ❓ 常见问题

| 现象 | 处理 |
| --- | --- |
| 保存的片段没有系统声音 | 到 Windows「录制」设备里启用「立体声混音」 |
| 录像里没有鼠标指针 | 设置 → 打开「录制鼠标指针」 |
| 鼠标偶尔闪烁 | 本版已用 DXGI 引擎；若仍偶发，托盘停止记忆回放对比确认 |
| 录出的视频播放器打不开 | 升级到新版本（采用 offset 写盘，保证 moov 完整） |

## 🤝 贡献与支持

- 发现 Bug / 有新想法？欢迎提 [Issue](https://github.com/2776525655/screen-recorder/issues) 或 [Pull Request](https://github.com/2776525655/screen-recorder/pulls)
- 觉得好用？**点个 ⭐ Star** 支持一下，也欢迎分享给需要的朋友
- 完整设计文档见仓库内 [`录屏工具设计文档.md`](录屏工具设计文档.md)

## 📄 License

[MIT](LICENSE) © 2026 陈书森 (Chen Shusen)
