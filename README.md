# Media Web

个人本地媒体库 Web 应用：扫描磁盘上的视频，提供浏览、搜索、标签、合集、播放列表、播放、截图与转码播放。原为 Qt 媒体播放器的 Python Web 移植版，现为 FastAPI + SQLite + 原生 JS（无构建步骤）。

## 功能概览

| 模块 | 说明 |
| --- | --- |
| 媒体库 | 目录扫描入库、卡片网格 / 树形两种视图、按目录 / 标签 / 状态 / 时长 / 分辨率筛选、排序与分页 |
| 树形浏览 | 从盘符根开始懒加载，只显示含库内视频的目录链（纯 DB 查询，秒开） |
| 搜索 / 最近 | 按名称搜索；最近播放记录，可清空 |
| 标签 | 层级标签树（默认根标签「全部标签」，父标签包含子标签）、标签颜色、批量打标、按标签筛选 |
| 损坏检测 | ffprobe 全库检测无有效视频流的文件并标记，可按状态筛出 / 排除；生成缩略图失败也会被动标记 |
| 智能合集 | Plex Collections 风格：保存当前筛选条件为合集，侧栏一键应用 / 重命名 / 更新 / 删除 |
| 播放列表 | 全局播放列表（按目录 + 相对路径存储），多入口加入 / 移除，支持保存 / 加载 m3u |
| 播放器 | PotPlayer 风格控制栏：进度条悬停缩略图预览、续播、倍速、音量悬浮气泡、信息面板、截图、弹幕开关、全屏；播放队列支持删除与拖动排序 |
| 转码播放 | 直连 / Direct Stream 直通重封装 / 零磁盘 fMP4 实时转码三级策略，硬件编码器可选，坏片段自动跳过 |
| 截图库 | 播放中一键截图，服务端保存，独立页面浏览 / 删除 |
| 任务中心 | 扫描 / 缩略图 / 损坏检测 / 转码等后台任务进度，历史记录 |
| 设置 | 媒体目录管理、ffmpeg / ffprobe 路径、转码开关与硬件编码器探测、访问日志开关、工具测试 |

## 快速开始

```powershell
pip install -r requirements.txt
copy config.example.json config.json   # 按需修改
python run.py
```

启动后访问 <http://127.0.0.1:8765>（端口可在 config.json 修改）。

- 需要在 `config.json` 中配置 `ffmpeg` / `ffprobe` 路径（留空则从 PATH 查找），缩略图、媒体信息、转码依赖它们。
- `allowed_roots` 为空时自动枚举本机盘符作为可浏览根。
- 首次使用到「设置 → 媒体目录」添加目录，然后在「视频库」执行扫描。

## 配置说明（config.json）

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `host` | `127.0.0.1` | 监听地址 |
| `port` | `8765` | 监听端口 |
| `allowed_roots` | `[]` | 允许浏览的根路径，空 = 自动检测盘符 |
| `library_dirs` | `[]` | 媒体库目录（也可在设置页管理） |
| `ffmpeg` / `ffprobe` | `""` | 可执行文件或所在目录，空 = PATH 查找 |
| `transcode` | `false` | 是否启用服务端转码 |
| `transcode_encoder` | `auto` | 硬件编码器：`auto` / `nvenc` / `qsv` / `amf` / `cpu` |
| `access_log` | `false` | 是否在控制台输出访问日志（每个请求一行），设置页可即时开关 |

## 目录结构

```
app/
  main.py            FastAPI 应用装配、静态资源挂载、/api/config
  config.py          配置加载、路径与工具探测、扩展名/MIME 表
  db.py              SQLite 连接与全部 DAO、迁移 v1–v9
  schema.sql         初始表结构
  security.py        路径安全校验（限定 allowed_roots）
  routers/           各 API 路由（见下表）
  services/
    scanner.py       目录扫描入库
    scanjobs.py      扫描任务与取消
    thumbs.py        缩略图生成与缓存
    media_info.py    ffprobe 媒体信息
    transcode.py     Direct Stream 计划与 fMP4 直推流、编码器探测
    subtitles.py     字幕解析（接口保留，前端未使用）
static/
  index.html         应用壳：左侧导航 + 各页面
  css/theme.css      设计系统（token、按钮、卡片、模态、播放器等）
  js/api.js          fetch 封装
  js/app.js          媒体库 / 设置 / 合集 / 任务等页面逻辑
  js/player.js       播放器全部逻辑
  js/tasks.js        右下角任务窗组件
data/                运行时生成（gitignore）：media.db、thumbs、screenshots、playlists
```

## 数据库

SQLite（WAL），`data/media.db`，通过 `PRAGMA user_version` 迁移，当前 v10：

| 版本 | 内容 |
| --- | --- |
| v1 | `files`、`tags`、`file_tags`、`comments` |
| v2 | `files.thumbnail` |
| v3 | `tags.parent_id`（层级标签） |
| v4 | `tasks`（任务历史） |
| v5 | `app_state`（前端偏好键值） |
| v6 | `dirs`、`playlist`（目录 + 相对路径），迁移旧播放列表 |
| v7 | `screenshots` |
| v8 | `collections`（智能合集） |
| v9 | 默认根标签「全部标签」，现有顶层标签迁移到其下；新建标签默认挂到根标签 |
| v10 | `files.broken`（损坏标记，ffprobe 检测 / 缩略图失败时写入） |

## API 一览

所有接口以 `/api` 为前缀。

| 分组 | 主要接口 |
| --- | --- |
| 浏览 | `GET /browse`、`GET /drives`、`POST /explore` |
| 扫描 | `POST /scan`、`GET /scan/status`、`POST /scan/cancel` |
| 视频库 | `POST /playlist/query`（flat / folder / tree / paths_only，`status`/`statuses`、`duration`/`durations` 多选并集；tree 忽略筛选、folder 应用筛选）、`GET|PUT|DELETE /playlist`、`POST /playlist/add|remove|clean|restore`、`POST /playlist/filter` |
| 文件 | `GET /files/detail|probe|all`、`POST /files/info|progress|played|media_info|detect_broken`、`POST /playlist/save|load` |
| 标签 | `GET|POST /tags`、`PUT|DELETE /tags/{id}`、`GET /tags/{id}/files`、`GET|PUT /files/tags`、`POST /files/tags/common|batch` |
| 合集 | `GET|POST /collections`、`GET /collections/counts`、`PUT|DELETE /collections/{id}` |
| 评论 | `GET|POST /comments`、`PUT|DELETE /comments/{id}` |
| 搜索 / 最近 | `GET /search`、`GET /recent`、`POST /recent/clear` |
| 缩略图 | `GET /thumbnail|preview`、`POST /thumbs`、`GET /thumbs/status` |
| 截图 | `POST|GET /screenshots`、`GET /screenshots/{id}/image`、`DELETE /screenshots/{id}` |
| 转码 | `GET /transcode/info|plan|stream` |
| 任务 | `GET /tasks`、`DELETE /tasks/{id}` |
| 设置 | `GET|PUT /settings`、`POST /settings/test-tool` |
| 状态 | `GET|PUT /state`、`DELETE /state/{key}` |
| 目录 | `GET|POST /dirs`、`PUT|DELETE /dirs/{id}` |
| 字幕（保留） | `GET /subtitles`、`POST /subtitles/parse` |

## 播放与转码

播放请求先向 `GET /api/transcode/plan` 取策略，返回 `X-Transcode-Mode`：

1. **direct**：浏览器可直接播放（H.264/VP9/AV1 + AAC/MP3 等），直接返回原文件（支持 Range）。
2. **remux**：编码兼容但容器/音轨不合适，用 ffmpeg `-c:v copy` 重封装为 fMP4 直推流。
3. **transcode**：视频编码不兼容（如 HEVC/10bit 且浏览器不支持）或用户强制开启时，零磁盘 fMP4 实时转码（`GET /api/transcode/stream?path=&start=`），`-g 48` 保证 seek 快速起播；客户端断开即终止 ffmpeg 进程。

- 编码器探测：`GET /api/transcode/info` 检测可用的 nvenc / qsv / amf，设置页提供下拉选择与测试。
- 坏片段容错：ffmpeg 以 `-err_detect ignore_err` + `-fflags +discardcorrupt` 丢弃损坏包继续转码；若仍中断，播放器自动从当前位置 +8s 跳过损坏片段（最多 4 次），流被提前截断同样触发；多次失败后保留流模式，拖动进度条即可从新位置重试。
- 无帧看门狗：播放 5 秒仍无 `requestVideoFrameCallback` 帧（黑屏但不报错）时，自动切实时转码或提示开启转码；后台标签页不检测。
- 进度：播放中定时 `POST /files/progress`，`POST /files/played` 记录播放次数；续播从 `last_position_ms` 开始。

## 前端说明

- 无打包、无依赖，浏览器直接加载 ES 模块脚本；静态资源响应 `Cache-Control: no-cache`，改完刷新即可生效。
- 左侧导航栏可收起为图标模式（偏好存 `app_state`，键 `mw/railCollapsed`）。
- 播放页控制栏（从左到右）：时间 / 上一个 / 播放暂停 / 下一个 / 总时长 / 弹幕 / 适应窗口 / 截图 / 音量气泡 / 倍速气泡 / 信息面板 / 全屏；播放结束仅暂停，离开页面自动暂停并保存进度。
- 播放列表面板：悬停行显示 ✕ 从当前播放队列移除；整行可拖动排序；仅作用于本次会话队列，不影响全局播放列表。
- 前端偏好统一存 `app_state`（`GET|PUT /api/state`），如音量、倍速、视图模式、筛选条件。

## Android 客户端

Kotlin + Jetpack Compose + Media3 原生客户端（独立仓库 `../vidweb-android`），对接同一后端，**无需后端改动**：

- 路径库 / 视频库 / 搜索 / 标签 / 任务 / 设置、播放列表、评论弹幕、截图、续播与转码回退等与 Web 对齐
- 移动端增强：手势（左右滑动调进度、长按倍速、双击快进、左亮度 / 右音量、双指缩放、锁屏）、进度预览图、评论标记点、横屏侧边栏、R8 压缩包约 2.8 MB
- 对接与接口说明见 [ANDROID.md](ANDROID.md)，客户端功能与构建见 `../vidweb-android/README.md`

## 更新记录

| 提交 | 内容 |
| --- | --- |
| 23618d5 | 损坏检测与状态多选筛选（迁移 v10） |
| 2157c7a | 标签改为默认根标签「全部标签」结构（迁移 v9） |
| 2235f15 | 新增 Android 客户端功能总结文档 |
| 1e106e7 | 修复新扫描视频缩略图不显示与播放页切回卡死 |
| 0427404 | README 更新 |
| 41d5ebc | 访问日志开关：默认关闭，设置页可即时切换 |
| 5db1853 | 播放页播放列表支持删除与拖动排序 |
| cbb227f | 损坏片段容错播放与项目 README |
| 3e51e57 | 播放器页面精简：PotPlayer 风格控制栏，移除顶栏 / 字幕 / 播放顺序 |
| 798aed0 | 界面重构：左侧导航栏、卡片网格与设计系统 |
| 81e8a56 | 播放列表增删入口、播放页标签编辑与无帧自动转码 |
| a99ddda | Direct Stream 直通重封装与智能合集 |
| 41086ee | 树形显示从盘符根开始，仅保留含库内视频的目录链 |
| 50f8b13 | 视频库树形懒加载与转码播放修复 |
| 5bf31ca | 转码改为零磁盘 fMP4 直推流，新增硬件编码器选择 |
| 8616c23 | 修复转码开关热更新 |
| d6cd5c3 | 服务端转码：设置开关与按需转码缓存播放 |
| f653cff | 截图库：服务端保存与播放器截图 Tab |
| 704957c | 进度条悬停缩略图预览与方向键长按加速 |
| fd071f6 | 任务系统、目录相对路径与服务端状态 / 分页 |
| 9e1e341 | 面板拖拽调宽、列表分页与界面精简 |
| 8152d83 | 标签树：父标签囊括所有子标签 |
| 4ef276c | 标签与播放器独立 Tab，精简视频库页面 |
| 4c8848f | 添加设置页、视频库筛选与 B 站式播放器布局 |
| 2e5aad1 | 初始提交：Qt 媒体播放器的 Python Web 移植版 |
