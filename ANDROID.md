# Media Web Android 客户端功能总结

> 基于当前 Web 前端（commit `0427404`）整理。目标：Android 原生客户端尽可能对齐 Web 功能，**后端无需改动**，仅需在客户端配置服务器地址。
>
> 实现状态：Android 客户端 1.1.2 已实现 P0/P1 全部功能，并额外实现移动端增强（手势调进度/亮度/音量/缩放、长按倍速、双击快进、锁屏、进度预览图、评论标记点、横屏侧边栏）。

## 1. 总体对接

- 后端为 FastAPI 本地服务（默认 `http://127.0.0.1:8765`），客户端与服务器在同一局域网时改为服务器内网 IP 即可。
- 无鉴权、无会话，所有接口均为 JSON（`{detail: "..."}` 为错误信息），流媒体接口除外。
- 开发期可直接用 FastAPI 自带文档：`GET /docs`、`GET /openapi.json`。
- 启动时先调 `GET /api/config` 探测能力：`ffmpeg` / `ffprobe` 是否存在、`transcode` 是否开启、可浏览根目录 `roots`、支持的扩展名 `video_exts`、版本号。
- 服务器时间与客户端可能有偏差，时间字段均为 Unix 秒。

## 2. 页面与功能清单（对齐 Web）

### 2.1 路径库

- 驱动器下拉（`GET /api/drives`）、路径输入跳转、上一级、刷新。
- 目录浏览：`GET /api/browse?path=` 返回当前目录条目（文件夹/视频/其他，含大小与修改时间）。
- 文件名过滤、仅视频开关、排序（名称/大小/时间，升降序）。
- 左侧「路径库」目录列表（`GET /api/dirs`）：添加 / 移除 / **扫描入库**（`POST /api/scan`，传 `dir_id` 或 `path`）。
- 文件列表分页；条目操作：双击/单击播放、加入播放列表、编辑标签、查看详情（Web 为右键菜单，Android 用长按菜单）。
- 记住上次路径（`mw/lastPath`）。

### 2.2 视频库

- 筛选条件（服务端 `POST /api/playlist/query` 统一处理）：
  - 文件名关键字、状态（全部/未播放/有进度/已播放/失效/损坏，可多选并集；不选=全部但排除失效）、时长（≤10min / 10–30min / >30min / 未知，可多选并集）
  - 标签多选 + 任一/全部匹配、排序（名称↑↓、最近播放、播放次数、时长、大小、修改时间）
  - 树形模式（`tree: true`，按文件夹层级懒加载，不分页）：树结构与数量**不受筛选影响**（文件夹始终显示），打开文件夹（`folder: "路径"`）时才对其中视频应用筛选；客户端可开关「打开文件夹时应用筛选」
- 智能合集侧栏（`GET /api/collections`）：应用筛选、重命名、用当前筛选更新、删除；保存当前筛选（`POST /api/collections`）。
- 多选模式：全选当前显示、批量移除播放列表、批量打标签。
- 卡片网格：16:9 缩略图（`GET /api/thumbnail?path=`）、悬停/长按显示播放按钮、多选圈、续播进度条（`last_position_ms / duration_ms`）、失效标记。
- 「重置筛选」「从媒体库恢复」（`POST /api/playlist/restore` 把全部入库视频加入播放列表）。

### 2.3 搜索

- `GET /api/search?q=&limit=`：匹配文件名、标签、评论；结果含 `exists`、`has_thumb`。
- 支持直接播放、加入播放列表、打开详情。

### 2.4 标签

- 层级标签树（父标签包含所有子标签，`tags.parent_id`），展开状态存 `mw/tagExpanded`。
- 默认根标签「全部标签」（数据库迁移 v9）：现有顶层标签迁移到其下，新建标签（含批量打标时自动创建）默认挂到根标签；客户端可将其作为普通根节点渲染。
- 新建子标签（指定 `parent_id`）、重命名、删除、颜色。
- 点击标签查看其文件（`GET /tags/{id}/files`）；批量打标（`POST /files/tags/batch`）；公共标签查询（`POST /files/tags/common`）。
- 视频库按标签筛选（`tag_ids` + `tag_match_all`）。

### 2.5 任务中心

- 任务列表 `GET /api/tasks`：类型（扫描/缩略图/损坏检测/转码等）、状态、进度（processed/total/added）、错误、起止时间；支持删除历史 `DELETE /api/tasks/{id}`。
- 扫描期间轮询 `GET /api/scan/status`（`job_id`），可取消 `POST /api/scan/cancel`。
- 缩略图批量生成 `POST /api/thumbs` + 进度 `GET /api/thumbs/status?path=`。

### 2.6 设置

- 服务器：监听地址/端口（改动需重启）、允许访问的根目录列表。
- ffmpeg / ffprobe 路径与「检测」按钮（`POST /api/settings/test-tool`）。
- 服务端转码开关、硬件编码器（auto/nvenc/qsv/amf/cpu，`GET /api/transcode/info` 探测可用项）。
- 访问日志开关（即时生效）。
- 播放器默认值：默认音量、默认倍速、弹幕开关与滚动速度（客户端本地或复用 `mw/defaults`）。
- 列表每页条数 `mw/pageSize`（10/20/30/50/100）。
- 关于：版本、数据目录、配置文件路径。

### 2.7 播放器

见下节详细规格。

## 3. 播放器详细规格

### 3.1 播放策略（与 Web 一致）

1. 先调 `GET /api/files/probe?path=` 或直接尝试直连 `GET /api/stream?path=`（支持 Range，可原生 seek）。
2. 浏览器不支持时 Web 会走 `GET /api/transcode/plan?path=` 取策略，返回 `mode: remux | transcode`、`video/audio` 编码、`encoder_label`：
   - `remux`：视频编码兼容（H.264/VP9/AV1），服务端 `-c:v copy` 重封装 fMP4；
   - `transcode`：服务端实时转码为 H.264 + AAC。
   - 播放地址统一为 `GET /api/transcode/stream?path=&start=毫秒`，响应头 `X-Transcode-Mode`，**无 Range、无时长**。
3. **Android 差异建议**：MediaCodec 对 HEVC/AV1 的支持比浏览器好，客户端应查询本机解码能力（`MediaCodecList`）再决定：
   - 本机可解 → 直接 `/api/stream`（体验最好，可任意 seek）；
   - 仅容器/音轨问题 → 可考虑本地直接播，或仍用服务端 remux；
   - 不可解或损坏 → 用 `/api/transcode/stream`。
4. 流式转码模式的 seek = 重新请求 `&start=目标毫秒`（Web 即如此）；时长取本地记录的 `duration_ms`，进度 = `start + 播放器内相对位置`。
5. **音频兼容性**：服务端转码流统一输出 AAC（源为 AAC 时直接 copy，否则转码）；客户端直连前应检查设备音频解码能力（`MediaCodecList` 按 MIME 查询），AC3/DTS/TrueHD 等不支持时直接走转码流，避免 ExoPlayer 静默丢弃音频轨导致「有画面没声音」。Android 1.1.7 已实现。

### 3.2 控制栏

从左到右：当前时间 / 上一个 / 播放暂停 / 下一个 / 总时长 / 弹幕开关 / 画面比例（适应窗口/拉伸/裁剪等） / 截图 / 音量（点击弹悬浮滑块 + 静音） / 倍速（0.5–4.0x，悬浮滑块） / 信息面板开关 / 全屏。

- 播放结束：**仅暂停并提示「播放结束」**，不自动下一个。
- 离开播放页/退到后台：暂停并保存进度。
- Android 实现按横竖屏分级：竖屏为 B 站式页面（上方 16:9 播放器，下方 5 Tab 内容区：详情/播放列表/评论/截图/最近）；竖屏控制栏为 顶栏（返回/标题/弹幕/倍速）+ 底栏（上一个/播放暂停/下一个/进度/时间/全屏）；横屏为 弹幕/音量/倍速/画面/更多/全屏 + 右侧竖排「截图/锁定」，「更多」打开右侧面板（同一套 5 Tab）。
- 返回逻辑：全屏（横屏）时返回键/左上角返回先退出全屏回竖屏，再按退出播放页；横屏面板打开时返回先关面板。

### 3.3 进度条

- 拖动预览、悬停/长按显示时间气泡；Web 用 `GET /api/preview?path=&t=秒` 取该时间点缩略图（可复用）。Android 已实现：拖动时显示预览缩略图与时间气泡。
- 进度条上显示评论标记点（`comments` 的 `position_ms`），点击跳转。Android 已实现。
- 键盘快捷键（Android 可映射为手势/遥控器）：空格播放暂停、←/→ 5s、长按连续快退/快进、↑/↓ 音量、M 静音、F 全屏、D 弹幕、C 截图、N 添加评论、L 面板、A 画面比例、Ctrl+L 打开评论、Ctrl+Q 退出播放页。

### 3.4 右侧信息面板（5 个 Tab）

| Tab | 内容与操作 |
| --- | --- |
| 详情 | 文件名、时长、分辨率、大小、编码（`POST /api/files/info`）、播放次数/上次播放、标签 chips（可删除、编辑）、加入/移除播放列表、评论数 |
| 播放列表 | 当前播放队列分页列表；**悬停/长按出现 ✕ 移除**；**拖动排序**；双击/单击切换播放；仅作用于本次会话队列 |
| 评论 | 当前视频评论列表（按时间点），点击跳转；添加（当前位置）、编辑、删除 |
| 截图 | 「截取当前画面」；已截图片网格（`GET /screenshots?path=`），点击查看大图、删除 |
| 最近播放 | 最近记录列表（`GET /api/recent`）、刷新、清空（`POST /recent/clear`）、点击播放 |

### 3.5 弹幕（评论弹幕）

- 播放中把评论按 `position_ms` 从右向左滚动显示，开关状态 `mw/danmaku`，滚动速度 `mw/danmakuSpeed`（默认 8000ms 横穿）。
- 暂停时弹幕冻结。

### 3.6 截图

- Web 从 `<canvas>` 抓帧后 **multipart 上传**：`POST /api/screenshots`（`file` + `path` + `position_ms`，PNG ≤ 上限）。
- Android 用 `PixelCopy` / `TextureView.getBitmap()` 抓帧后同样上传即可复用；列表 `GET /screenshots?path=`，原图 `GET /screenshots/{id}/image`。

### 3.7 进度与播放记录

- 开始播放：`POST /api/files/played {path}`（播放次数 +1、更新最近播放）。
- 播放中每 5 秒、暂停时、离开时：`POST /api/files/progress {path, position_ms}`。
- 续播：`GET /api/files/detail` 返回 `record.last_position_ms`，加载后跳转并提示「已从 xx 继续播放」。
- 播完（接近片尾）上报 `position_ms=0` 清除续播点。

### 3.8 容错（服务端已实现，客户端配合）

- 服务端 ffmpeg 已加 `-err_detect ignore_err` + `-fflags +discardcorrupt+genpts`，坏包丢弃继续。
- 若流仍中断：客户端应自动 **从当前位置 +8s 重新请求转码流**（最多 4 次），提示「跳过损坏片段」；流被提前截断（播放器 EOF 但未到片尾）同样处理；多次失败后保留流模式，允许拖动进度条从新位置重试。
- 无帧看门狗：Web 播放 5 秒无新帧则判定黑屏（HEVC/10bit），自动切实时转码；Android 可做类似「首帧超时/解码器报错」回退。

### 3.9 手势与移动端增强（Android 已实现，Web 没有）

| 手势 | 行为 | 设置项（`mw/gestures`） |
| --- | --- | --- |
| 左右滑动 | 全屏调进度，中央显示目标时间 | 开关 + 灵敏度 0.3–3.0x |
| 长按 | 加速播放（默认 2.0x，松手恢复） | 开关 + 倍速 1.5–4.0x |
| 双击 | 左 35% 快退 / 右 35% 快进（默认 10s）、中间播放/暂停 | 开关 + 步长 5–30s |
| 左半屏上下滑 | 亮度（实时生效并显示 OSD） | 开关 |
| 右半屏上下滑 | 音量（实时生效并显示 OSD） | 开关 |
| 双指 | 缩放/平移画面 | 开关 |
| 锁定屏幕 | 屏蔽手势与控制，左上角锁图标解锁 | 播放页按钮 |

- 控制栏显示时，顶部 56dp / 底部 150dp 区域不响应手势，避免误触；单击呼出/隐藏控制栏。
- 其余增强：进度预览缩略图、评论标记点、横屏侧边栏（截图/锁定）、断流重连（5 次）、提前 ENDED 自动跳过、弹幕、PixelCopy 截图上传。

## 4. API 速查

统一前缀 `/api`，除注明外均为 JSON。

| 分组 | 接口 |
| --- | --- |
| 能力 | `GET /config` |
| 浏览 | `GET /browse?path=`、`GET /drives`、`POST /explore` |
| 目录库 | `GET /dirs`、`POST /dirs {path}`、`PUT /dirs/{id} {path}`、`DELETE /dirs/{id}` |
| 扫描 | `POST /scan {path\|dir_id}`、`GET /scan/status?job_id=`、`POST /scan/cancel {job_id}` |
| 视频库 | `POST /playlist/query`（字段见下）、`GET|PUT|DELETE /playlist`、`POST /playlist/add|remove {paths}`、`/clean`、`/restore`、`/filter {paths,tag_ids,match_all}` |
| 文件 | `GET /files/detail?path=`、`GET /files/probe?path=`、`GET /files/all`、`POST /files/info {paths}`、`POST /files/progress {path,position_ms}`、`POST /files/played {path}`、`POST /files/media_info {path,duration_ms,width,height,title}`、`POST /files/detect_broken`（启动全库 ffprobe 检测任务，返回 `job_id`） |
| m3u | `POST /playlist/save {file,paths}`、`POST /playlist/load {file}` |
| 标签 | `GET|POST /tags`、`PUT|DELETE /tags/{id}`、`GET /tags/{id}/files`、`GET /files/tags?path=`、`PUT /files/tags {path,tags}`、`POST /files/tags/common {paths}`、`POST /files/tags/batch {paths,tags}` |
| 合集 | `GET|POST /collections`、`GET /collections/counts`、`PUT|DELETE /collections/{id}` |
| 评论 | `GET /comments?path=`、`POST /comments {path,position_ms,text}`、`PUT|DELETE /comments/{id}` |
| 搜索/最近 | `GET /search?q=&limit=`、`GET /recent?limit=`、`POST /recent/clear` |
| 缩略图 | `GET /thumbnail?path=`、`GET /preview?path=&t=`、`POST /thumbs {paths}`、`GET /thumbs/status?path=` |
| 截图 | `POST /screenshots`（multipart：`file`,`path`,`position_ms`）、`GET /screenshots?path=`、`GET /screenshots/{id}/image`、`DELETE /screenshots/{id}` |
| 转码 | `GET /transcode/info`、`GET /transcode/plan?path=`、`GET /transcode/stream?path=&start=` |
| 任务 | `GET /tasks`、`DELETE /tasks/{id}` |
| 设置 | `GET|PUT /settings`、`POST /settings/test-tool {path,tool}` |
| 状态 | `GET /state`、`PUT /state {key,value}` 或 `{items}`、`DELETE /state/{key}` |
| 媒体流 | `GET /stream?path=`（原文件，支持 Range） |
| 字幕（保留未用） | `GET /subtitles?path=`、`POST /subtitles/parse` |

`POST /playlist/query` 请求体：

```json
{
  "offset": 0, "limit": 30,
  "search": "", "status": "all", "statuses": null, "duration": "all", "durations": null,
  "tag_ids": [], "tag_match_all": false,
  "sort": "name",
  "paths_only": false, "tree": false, "folder": null
}
```

- `status`：`all|new|progress|played|missing|broken`（兼容旧客户端，单值）
- `statuses`：数组，多选并集（如 `["progress","played"]` 只显示看过的可播放视频）；空/缺省时回退到 `status`；含 `missing` 时走磁盘存在性检查
- `durations`：数组，多选并集（如 `["short","long"]`）；空/缺省时回退到 `duration`
- `tree: true` 时忽略所有筛选，返回完整目录树（结构与数量不受筛选影响）；筛选在 `folder` 查询（打开文件夹）时应用
- 条目字段含 `exists`（磁盘存在）与 `broken`（ffprobe 判定无有效视频流 / 缩略图生成失败）
- `duration`：`all|short|medium|long|unknown`
- `sort`：`name|name_desc|recent|plays|duration|size|mtime`
- `paths_only: true` 只返回路径数组（用于全选/批量操作）；`tree: true` 返回目录树；`folder` 指定某层。

## 5. 客户端偏好（app_state）

Web 前端偏好存在服务端 `app_state`（`GET|PUT|DELETE /api/state`），Android 建议继续复用，实现多端同步：

| 键 | 用途 |
| --- | --- |
| `mw/volume` / `mw/speed` | 音量 / 倍速 |
| `mw/danmaku` / `mw/danmakuSpeed` | 弹幕开关 / 滚动速度 |
| `mw/pageSize` | 每页条数 |
| `mw/libFilters` | 视频库筛选条件（JSON） |
| `mw/sort` / `mw/onlyVideo` / `mw/lastPath` | 路径库排序 / 仅视频 / 上次路径 |
| `mw/tagExpanded` | 标签树展开状态 |
| `mw/defaults` | 播放器默认值（音量/倍速/弹幕） |
| `mw/gestures` | 播放器手势配置（JSON：开关/长按倍速/双击步长/灵敏度），Android 写入并读取 |
| `mw/railCollapsed` | 侧栏收起（Android 可忽略） |
| `mw/split/*` | 面板宽度（Android 可忽略） |

服务器地址等设备本地配置建议用 DataStore，不要存服务端。

## 6. Android 实现建议

- **技术栈**：Kotlin + Jetpack Compose + Media3 ExoPlayer；Retrofit/OkHttp + kotlinx.serialization；Coil 加载缩略图/预览；DataStore 存服务器地址。
- **网络**：明文 HTTP 需 `networkSecurityConfig` 放行（局域网）；OkHttp 默认支持 Range；转码流为 chunked fMP4（无 Content-Length），ExoPlayer 以 ProgressiveMediaSource 可播，但 **seek 需重启请求**。
- **播放能力判断**：用 `MediaCodecList` / `MediaExtractor` 检测编码后再决定直连或转码；HEVC 常见可硬解，可显著减少转码。
- **弹幕**：Compose Canvas 按评论时间轴绘制，简单动画即可。
- **截图**：`PixelCopy`（SurfaceView）或 `TextureView.getBitmap()`，压缩 PNG 后 multipart 上传。
- **任务轮询**：任务页可见时每 1–2 秒轮询 `/tasks` 或 `/scan/status`，不可见时停止。
- **交互映射**：右键菜单 → 长按 BottomSheet；拖拽调宽 → 抽屉/底部面板；悬停 → 长按。
- **可选增强**（Web 没有）：画中画、后台音频、手势调亮度/音量、投屏。

## 7. 建议优先级（初版规划，均已实现）

| 优先级 | 内容 |
| --- | --- |
| P0 | 路径库 / 视频库浏览、搜索、直连播放 + 转码回退、进度与续播、播放列表（含加入/移除） |
| P1 | 标签、智能合集、评论/弹幕、截图、任务中心、最近播放、设置（服务器地址、转码开关） |
| P2 | 播放器默认值同步、路径库扫描管理、m3u 保存/加载、画面比例、预览缩略图 |

## 8. 与 Web 的差异 / 可省略

- 字幕功能已从 Web 移除，客户端不实现（后端接口保留但不用）。
- 播放顺序/循环/随机不存在：结束仅暂停，下一个/上一个手动切换。
- 拖拽调整面板宽度、键盘快捷键、浏览器标签标题等浏览器特性不迁移。
- 树形/网格等布局按移动端习惯可调整（如树形改全屏列表）。

## 9. 注意事项

- 转码为实时 CPU/GPU 负载，移动端播放同一服务器时注意并发；服务端断开连接即终止 ffmpeg。
- 所有路径均为**服务器本地路径**，客户端只传字符串，不访问本地文件系统。
- 进度/播放次数写入服务器数据库，多端会互相影响（预期行为）。
- 失效文件（`missing`）仅在树形模式回退磁盘检查；普通列表以 DB 状态为准。
