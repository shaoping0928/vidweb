(function () {
  "use strict";

  const Player = {
    paths: [],
    index: -1,
    markers: [],
    dragging: false,
    pendingResume: -1,
    resumeApplied: true,
    lastSaveTs: 0,
    aspectIndex: 0,
    loadToken: 0,
    osdTimer: null,
    hideTimer: null,
    initialized: false,
    danmakuOn: true,
    danmakuCross: 8000,
    danmakuRaf: null,
    lastDanmakuTime: -1,
    laneFree: [],
    panelPage: 1,
    dragIndex: null,
    arrowTimer: null,
    arrowInterval: null,
    arrowDirection: 0,
    arrowAccel: false,
    previewTimer: null,
    previewBucket: -1,
    ffmpegOn: false,
    transcodeOn: false,
    streamMode: false,
    streamOffsetMs: 0,
    streamDurationMs: 0,
    pendingSeekMs: null,
    streamEncoderLabel: "",
    streamWatchdog: null,
    streamRetries: 0,
    playbackChecked: false,
    frameSeen: false,
    panelTab: "info",
    el: {},

    async init() {
      if (this.initialized) return;
      this.initialized = true;
      if (window.Prefs && window.Prefs.load) await window.Prefs.load();
      try {
        const appConfig = await API.get("/api/config");
        this.ffmpegOn = !!appConfig.ffmpeg;
        this.transcodeOn = !!appConfig.transcode;
      } catch (e) {
        this.ffmpegOn = false;
        this.transcodeOn = false;
      }
      const ids = [
        "video", "playerOsd",
        "playerStage", "playerMain", "playerBody", "playerPanel", "playerPlaylistView",
        "progressTrack", "progressFill", "progressHandle", "progressMarkers", "progressTip",
        "progressWrap", "progressPreview", "progressPreviewImg", "progressPreviewTime",
        "playerShotList", "btnShotPanel",
        "timeNow", "timeTotal", "btnPrev", "btnPlay", "btnNext", "btnAspect",
        "btnSnap", "btnMute", "volume", "volText", "speed", "speedText", "btnFullscreen",
        "btnVolume", "btnSpeed", "volumePopover", "speedPopover",
        "btnAddCommentPanel", "btnPanelToggle",
        "danmakuLayer", "btnDanmaku", "playerCommentList",
        "playerPlaylistPager",
      ];
      ids.forEach((id) => {
        this.el[id] = document.getElementById(id);
      });
      this.el.playerPage = document.getElementById("page-player");
      const defaults = window.Prefs ? Prefs.getJSON("mw/defaults", {}) : {};
      const volumeRaw = window.Prefs ? Prefs.get("mw/volume", null) : null;
      this.el.volume.value =
        volumeRaw !== null ? volumeRaw : String(defaults.volume !== undefined ? defaults.volume : 80);
      const speedRaw = window.Prefs ? Prefs.get("mw/speed", null) : null;
      this.el.speed.value =
        speedRaw !== null ? speedRaw : String(defaults.speed !== undefined ? defaults.speed : 10);
      const danmakuRaw = window.Prefs ? Prefs.get("mw/danmaku", null) : null;
      this.danmakuOn = danmakuRaw !== null ? danmakuRaw === "1" : defaults.danmaku !== false;
      const danmakuSpeedRaw = window.Prefs ? Prefs.get("mw/danmakuSpeed", null) : null;
      this.danmakuCross =
        parseInt(danmakuSpeedRaw || String(defaults.danmakuSpeed || 8000), 10) || 8000;
      this.el.btnDanmaku.textContent = this.danmakuOn ? "弹幕: 开" : "弹幕: 关";
      this.el.danmakuLayer.classList.add("dm-paused");
      this.startDanmakuLoop();
      this.applyVolume();
      this.applySpeed();
      this.bind();
    },

    bind() {
      const el = this.el;
      el.btnPlay.addEventListener("click", () => this.toggle());
      el.btnPrev.addEventListener("click", () => this.playIndex(this.index - 1));
      el.btnNext.addEventListener("click", () => this.playIndex(this.index + 1));
      el.btnPanelToggle.addEventListener("click", () => this.togglePanel());
      el.btnDanmaku.addEventListener("click", () => this.setDanmaku(!this.danmakuOn));
      el.btnMute.addEventListener("click", () => this.toggleMute());
      el.btnAspect.addEventListener("click", () => this.cycleAspect());
      el.btnSnap.addEventListener("click", () => this.snapshot());
      el.btnFullscreen.addEventListener("click", () => this.toggleFullscreen());
      el.btnAddCommentPanel.addEventListener("click", () => this.addComment());
      el.btnShotPanel.addEventListener("click", () => this.snapshot());
      el.btnVolume.addEventListener("click", (e) => {
        e.stopPropagation();
        this.togglePopover("volumePopover");
      });
      el.btnSpeed.addEventListener("click", (e) => {
        e.stopPropagation();
        this.togglePopover("speedPopover");
      });
      document.addEventListener("click", (e) => {
        if (e.target.closest(".popover-wrap")) return;
        this.closePopovers();
      });
      Array.from(document.querySelectorAll(".ptab-btn")).forEach((btn) => {
        btn.addEventListener("click", () => this.switchPanelTab(btn.dataset.ptab));
      });
      el.volume.addEventListener("input", () => {
        this.applyVolume();
        if (window.Prefs) Prefs.set("mw/volume", el.volume.value);
      });
      el.speed.addEventListener("input", () => {
        this.applySpeed();
        if (window.Prefs) Prefs.set("mw/speed", el.speed.value);
      });
      el.playerStage.addEventListener("dblclick", (e) => {
        if (e.target.closest("#controls")) return;
        this.toggleFullscreen();
      });
      el.playerPlaylistView.addEventListener("dblclick", (e) => {
        if (e.target.closest(".pl-remove")) return;
        const li = e.target.closest("li");
        if (li && li.dataset.index !== undefined) this.playIndex(parseInt(li.dataset.index, 10));
      });
      el.playerPlaylistView.addEventListener("click", (e) => {
        const btn = e.target.closest(".pl-remove");
        if (!btn) return;
        e.stopPropagation();
        const li = btn.closest("li");
        if (li && li.dataset.index !== undefined) {
          this.removePanelItem(parseInt(li.dataset.index, 10));
        }
      });
      el.playerPlaylistView.addEventListener("dragstart", (e) => {
        const li = e.target.closest("li");
        if (!li || li.dataset.index === undefined) return;
        this.dragIndex = parseInt(li.dataset.index, 10);
        li.classList.add("dragging");
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", String(this.dragIndex));
        }
      });
      el.playerPlaylistView.addEventListener("dragover", (e) => {
        if (this.dragIndex === null) return;
        const li = e.target.closest("li");
        if (!li || li.dataset.index === undefined) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        const rect = li.getBoundingClientRect();
        const after = e.clientY - rect.top > rect.height / 2;
        Array.from(el.playerPlaylistView.querySelectorAll("li")).forEach((row) => {
          row.classList.toggle("drop-after", row === li && after);
          row.classList.toggle("drop-before", row === li && !after);
        });
      });
      el.playerPlaylistView.addEventListener("dragleave", (e) => {
        if (!el.playerPlaylistView.contains(e.relatedTarget)) this.clearDragMarks();
      });
      el.playerPlaylistView.addEventListener("drop", (e) => {
        if (this.dragIndex === null) return;
        const li = e.target.closest("li");
        if (!li || li.dataset.index === undefined) return;
        e.preventDefault();
        const rect = li.getBoundingClientRect();
        const after = e.clientY - rect.top > rect.height / 2;
        const target = parseInt(li.dataset.index, 10);
        const from = this.dragIndex;
        this.dragIndex = null;
        this.movePanelItem(from, after ? target + 1 : target);
      });
      el.playerPlaylistView.addEventListener("dragend", () => {
        this.dragIndex = null;
        this.clearDragMarks();
      });

      const video = el.video;
      video.addEventListener("loadedmetadata", () => this.onLoadedMetadata());
      video.addEventListener("durationchange", () => this.updateProgress());
      video.addEventListener("timeupdate", () => {
        this.updateProgress();
        this.checkUndecodable();
        if (this.streamRetries && this.streamMode && video.currentTime > 10) {
          this.streamRetries = 0;
        }
        if (Date.now() - this.lastSaveTs > 5000) {
          this.lastSaveTs = Date.now();
          this.saveProgress();
        }
      });
      video.addEventListener("play", () => {
        el.btnPlay.textContent = "⏸";
        el.danmakuLayer.classList.remove("dm-paused");
      });
      video.addEventListener("playing", () => this.clearStreamWatchdog());
      video.addEventListener("pause", () => {
        el.btnPlay.textContent = "▶";
        el.danmakuLayer.classList.add("dm-paused");
        this.saveProgress();
      });
      video.addEventListener("seeked", () => this.resetDanmaku());
      video.addEventListener("ended", () => this.onEnded());
      video.addEventListener("error", async () => {
        const path = this.paths[this.index];
        if (!path) return;
        if (this.streamMode) {
          if (this.trySkipBadSegment()) return;
          const gaveUp = this.streamRetries >= 4;
          this.showOsd(
            gaveUp
              ? "损坏片段过多，播放中止，可拖动进度条跳过"
              : "实时转码播放失败（文件损坏或转码设置异常），可拖动进度条重试"
          );
          return;
        }
        try {
          const cfg = await API.get("/api/config");
          this.transcodeOn = !!cfg.transcode;
        } catch (e) {}
        if (this.transcodeOn) {
          this.startTranscodeStream(path);
          return;
        }
        let detail = "";
        let playable = null;
        try {
          const info = await API.get("/api/files/probe", { path: path });
          playable = info.playable;
          const parts = [];
          if (info.video) parts.push("视频 " + info.video.toUpperCase());
          if (info.audio) parts.push("音频 " + info.audio.toUpperCase());
          if (info.container) parts.push("容器 " + info.container.split(",")[0]);
          detail = parts.join(" / ");
        } catch (e) {}
        if (playable === false) {
          this.showOsd("浏览器不支持该编码（" + detail + "），可在设置中开启服务端转码");
          return;
        }
        if (playable === null) {
          this.showOsd("播放失败：文件可能损坏或不完整");
          return;
        }
        this.showOsd("播放失败，请稍后重试" + (detail ? "（" + detail + "）" : ""));
      });

      const track = el.progressTrack;
      track.addEventListener("pointerdown", (e) => this.onPointerDown(e));
      track.addEventListener("pointermove", (e) => this.onPointerMove(e));
      track.addEventListener("pointerup", (e) => this.onPointerUp(e));
      track.addEventListener("pointercancel", () => {
        this.dragging = false;
      });
      track.addEventListener("pointerleave", () => {
        if (this.dragging) return;
        el.progressTip.classList.add("hidden");
        this.hidePreview();
      });

      el.playerMain.addEventListener("pointermove", () => {
        if (!document.fullscreenElement) return;
        el.playerMain.classList.remove("hide-controls");
        clearTimeout(this.hideTimer);
        this.hideTimer = setTimeout(() => {
          if (document.fullscreenElement) el.playerMain.classList.add("hide-controls");
        }, 2000);
      });
      document.addEventListener("fullscreenchange", () => {
        clearTimeout(this.hideTimer);
        if (document.fullscreenElement) {
          this.hideTimer = setTimeout(() => el.playerMain.classList.add("hide-controls"), 2000);
        } else {
          el.playerMain.classList.remove("hide-controls");
        }
      });
      document.addEventListener("keydown", (e) => this.onKey(e));
      document.addEventListener("keyup", (e) => {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") this.stopArrowHold();
      });
      window.addEventListener("blur", () => this.stopArrowHold());
      window.addEventListener("pagehide", () => this.beaconProgress());
    },

    /* -------------------------------------------------------- playback */

    async open(paths, index) {
      const files = (paths || []).filter(Boolean);
      if (!files.length) {
        UI.alert("播放列表为空");
        return;
      }
      this.paths = files.slice();
      this.panelPage = 1;
      if (window.APP && window.APP.setTab) window.APP.setTab("player");
      this.renderPlaylistPanel();
      await this.playIndex(index || 0);
    },

    async playIndex(i, skipSave) {
      if (!this.paths.length) return;
      if (!skipSave) this.saveProgress();
      const count = this.paths.length;
      this.index = ((i % count) + count) % count;
      const path = this.paths[this.index];
      const token = ++this.loadToken;
      this.resumeApplied = false;
      this.pendingResume = -1;
      this.streamMode = false;
      this.streamOffsetMs = 0;
      this.streamDurationMs = 0;
      this.streamRetries = 0;
      this.pendingSeekMs = null;
      this.markers = [];
      this.renderMarkers();
      this.clearDanmaku();
      this.lastDanmakuTime = -1;
      this.currentDetail = null;
      this.renderInfoPanel(null);
      this.playbackChecked = false;
      this.el.video.src = API.streamUrl(path);
      this.watchFirstFrame();
      this.el.video.play().catch(() => {});
      this.updateTitle();
      this.updatePlaylistSelection();
      API.post("/api/files/played", { path }).catch(() => {});
      this.loadComments(path, token);
      try {
        const detail = await API.get("/api/files/detail", { path });
        if (token !== this.loadToken) return;
        this.currentDetail = detail;
        this.renderInfoPanel(detail);
        if (detail.record && detail.record.last_position_ms > 0) {
          this.pendingResume = detail.record.last_position_ms;
          this.maybeResume();
        }
      } catch (e) {}
    },

    onLoadedMetadata() {
      const video = this.el.video;
      this.el.timeTotal.textContent = Fmt.time(this.videoDurationMs());
      this.maybeResume();
      this.renderMarkers();
      const path = this.paths[this.index];
      if (path) {
        API.post("/api/files/media_info", {
          path: path,
          duration_ms: Math.round(this.videoDurationMs()),
          width: video.videoWidth || 0,
          height: video.videoHeight || 0,
        }).catch(() => {});
      }
    },

    maybeResume() {
      if (this.resumeApplied || this.pendingResume <= 0) return;
      const video = this.el.video;
      if (video.readyState < 1 || !isFinite(video.duration) || video.duration <= 0) return;
      const target = this.pendingResume / 1000;
      if (target < video.duration - 1) {
        video.currentTime = target;
        this.showOsd("已从 " + Fmt.time(this.pendingResume) + " 继续播放");
      }
      this.resumeApplied = true;
      this.pendingResume = -1;
    },

    onEnded() {
      if (this.streamMode) {
        const total = this.videoDurationMs();
        const pos = this.videoPositionMs();
        if (total > 0 && pos < total - 2000 && this.trySkipBadSegment()) return;
      }
      this.saveProgress();
      this.showOsd("播放结束");
    },

    toggle() {
      if (!this.paths.length) return;
      const video = this.el.video;
      if (video.paused) video.play().catch(() => {});
      else video.pause();
    },

    transcodeStreamUrl(path, startMs) {
      return (
        "/api/transcode/stream?path=" +
        encodeURIComponent(path) +
        "&start=" +
        Math.max(0, Math.round(startMs || 0))
      );
    },

    async startTranscodeStream(path) {
      if (this.paths[this.index] !== path) return;
      const video = this.el.video;
      const posMs = Math.round((video.currentTime || 0) * 1000);
      const resumeMs = this.pendingResume > 0 ? this.pendingResume : 0;
      const startMs = posMs > 1000 ? posMs : resumeMs;
      const record = this.currentDetail && this.currentDetail.record;
      this.streamMode = true;
      this.playbackChecked = true;
      this.streamRetries = 0;
      this.streamOffsetMs = Math.max(0, startMs);
      this.streamDurationMs = (record && record.duration_ms) || 0;
      this.pendingSeekMs = null;
      this.resumeApplied = true;
      this.pendingResume = -1;
      video.src = this.transcodeStreamUrl(path, this.streamOffsetMs);
      video.play().catch(() => {});
      this.updateProgress();
      this.showOsd("已切换实时转码播放（不占用磁盘）");
      this.armStreamWatchdog(path);
      if (!this.streamDurationMs) {
        try {
          const detail = await API.get("/api/files/detail", { path: path });
          if (this.streamMode && this.paths[this.index] === path && detail.record) {
            this.currentDetail = this.currentDetail || detail;
            this.streamDurationMs = detail.record.duration_ms || 0;
            this.updateProgress();
          }
        } catch (e) {}
      }
      try {
        const plan = await API.get("/api/transcode/plan", { path: path });
        if (this.streamMode && this.paths[this.index] === path) {
          if (plan.mode === "remux") {
            this.streamEncoderLabel = plan.encoder_label || "直通";
            this.showOsd("直通播放（仅重封装，不转码）");
          } else if (plan.encoder_label) {
            this.streamEncoderLabel = plan.encoder_label;
            this.showOsd("实时转码播放：" + plan.encoder_label);
          }
        }
      } catch (e) {}
    },

    restartStreamAt(ms, keepRetries) {
      const path = this.paths[this.index];
      if (!path || !this.streamMode) return;
      if (!keepRetries) this.streamRetries = 0;
      const duration = this.videoDurationMs();
      let target = Math.max(0, Math.round(ms));
      if (duration > 0) target = Math.min(target, duration - 1000);
      this.streamOffsetMs = target;
      this.pendingSeekMs = null;
      this.el.video.src = this.transcodeStreamUrl(path, target);
      this.el.video.play().catch(() => {});
      this.updateProgress();
      this.armStreamWatchdog(path);
    },

    trySkipBadSegment() {
      if (this.streamRetries >= 4) return false;
      const video = this.el.video;
      const playedMs = Math.round((video.currentTime || 0) * 1000);
      if (playedMs < 500 && this.streamOffsetMs <= 0) return false;
      const total = this.videoDurationMs();
      const target = this.videoPositionMs() + 8000;
      if (total > 0 && target >= total - 1000) return false;
      this.streamRetries += 1;
      this.showOsd("跳过损坏片段，继续播放…");
      this.restartStreamAt(target, true);
      return true;
    },

    armStreamWatchdog(path) {
      this.clearStreamWatchdog();
      this.streamWatchdog = setTimeout(() => {
        if (!this.streamMode || this.paths[this.index] !== path) return;
        const current = this.el.video;
        if (current.readyState >= 2 || current.currentTime > 0.5) return;
        this.stopStream();
        this.showOsd("实时转码启动超时，请检查转码硬件设置");
      }, 15000);
    },

    applySeekMs(ms) {
      if (this.streamMode) {
        this.restartStreamAt(ms);
        return;
      }
      const duration = this.videoDurationMs();
      if (duration <= 0) return;
      this.el.video.currentTime = Math.min(Math.max(0, ms / 1000), duration / 1000);
      this.updateProgress();
    },

    videoDurationMs() {
      if (this.streamMode && this.streamDurationMs > 0) return this.streamDurationMs;
      const video = this.el.video;
      if (isFinite(video.duration) && video.duration > 0) return video.duration * 1000;
      return 0;
    },

    videoPositionMs() {
      const base = (this.el.video.currentTime || 0) * 1000;
      return this.streamMode ? this.streamOffsetMs + base : base;
    },

    watchFirstFrame() {
      const video = this.el.video;
      this.frameSeen = false;
      if (typeof video.requestVideoFrameCallback !== "function") {
        this.frameSeen = true;
        return;
      }
      try {
        video.requestVideoFrameCallback(() => {
          this.frameSeen = true;
        });
      } catch (e) {
        this.frameSeen = true;
      }
    },

    async checkUndecodable() {
      if (this.streamMode || this.playbackChecked) return;
      const video = this.el.video;
      if (video.paused || document.hidden) return;
      if (video.currentTime < 5) return;
      if (this.frameSeen) {
        this.playbackChecked = true;
        return;
      }
      if (typeof video.requestVideoFrameCallback !== "function") return;
      this.playbackChecked = true;
      const path = this.paths[this.index];
      if (!path) return;
      if (!this.transcodeOn) {
        try {
          const cfg = await API.get("/api/config");
          this.transcodeOn = !!cfg.transcode;
        } catch (e) {}
        if (this.paths[this.index] !== path) return;
      }
      if (this.transcodeOn) {
        this.showOsd("画面无法解码（可能是 HEVC/10bit），切换实时转码…");
        this.startTranscodeStream(path);
      } else {
        this.showOsd("画面无法解码（可能是 HEVC/10bit），可在设置中开启服务端转码");
      }
    },

    clearStreamWatchdog() {
      if (this.streamWatchdog) {
        clearTimeout(this.streamWatchdog);
        this.streamWatchdog = null;
      }
    },

    stopStream() {
      this.clearStreamWatchdog();
      if (!this.streamMode) return;
      this.streamMode = false;
      this.streamRetries = 0;
      this.streamOffsetMs = 0;
      this.pendingSeekMs = null;
      const video = this.el.video;
      video.removeAttribute("src");
      video.load();
    },

    seekRelative(ms) {
      const duration = this.videoDurationMs();
      if (duration <= 0) return;
      this.applySeekMs(this.videoPositionMs() + ms);
    },

    startArrowHold(direction) {
      if (!this.paths.length) return;
      if (this.arrowTimer || this.arrowInterval) return;
      this.arrowDirection = direction;
      this.arrowTimer = setTimeout(() => {
        this.arrowTimer = null;
        this.arrowAccel = true;
        const base = Number(this.el.speed.value) / 10 || 1;
        if (direction > 0) {
          this.el.video.playbackRate = Math.min(4, Math.max(2, base * 3));
          this.showOsd("快进 " + this.el.video.playbackRate.toFixed(1) + "x（松开恢复）");
        } else {
          this.el.video.playbackRate = base;
          if (this.streamMode) {
            this.showOsd("快退 5s（松开生效）");
            return;
          }
          this.showOsd("快退 3.0x（松开恢复）");
          this.arrowInterval = setInterval(() => {
            const video = this.el.video;
            if (this.videoDurationMs() <= 0) return;
            video.currentTime = Math.max(0, video.currentTime - 0.45);
          }, 150);
        }
      }, 350);
    },

    stopArrowHold() {
      if (!this.arrowTimer && !this.arrowInterval && !this.arrowAccel) return;
      if (this.arrowTimer) {
        clearTimeout(this.arrowTimer);
        this.arrowTimer = null;
        this.seekRelative(this.arrowDirection > 0 ? 5000 : -5000);
      }
      if (this.arrowInterval) {
        clearInterval(this.arrowInterval);
        this.arrowInterval = null;
      }
      if (this.arrowAccel) {
        this.arrowAccel = false;
        this.applySpeed();
      }
    },

    schedulePreview(seconds, leftPercent) {
      const path = this.paths[this.index];
      if (!path) return;
      const box = this.el.progressPreview;
      box.style.left = Math.min(100, Math.max(0, leftPercent)) + "%";
      const bucket = Math.floor(seconds / 10);
      if (bucket === this.previewBucket) return;
      this.previewBucket = bucket;
      clearTimeout(this.previewTimer);
      this.previewTimer = setTimeout(() => {
        const img = this.el.progressPreviewImg;
        const url =
          "/api/preview?path=" +
          encodeURIComponent(path) +
          "&t=" +
          seconds.toFixed(1);
        img.onload = () => box.classList.remove("hidden");
        img.onerror = () => box.classList.add("hidden");
        img.src = url;
        this.el.progressPreviewTime.textContent = Fmt.time(seconds * 1000);
      }, 160);
    },

    hidePreview() {
      clearTimeout(this.previewTimer);
      this.previewBucket = -1;
      if (this.el.progressPreview) this.el.progressPreview.classList.add("hidden");
    },

    pauseForLeave() {
      this.stopArrowHold();
      this.hidePreview();
      this.saveProgress();
      this.stopStream();
      this.closePopovers();
      this.el.video.pause();
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    },

    close() {
      this.pauseForLeave();
      if (window.APP && window.APP.setTab) window.APP.setTab("lib");
      if (window.APP && window.APP.onPlayerClosed) window.APP.onPlayerClosed();
    },

    saveProgress() {
      const path = this.paths[this.index];
      if (!path) return;
      const duration = this.videoDurationMs();
      if (duration <= 0) return;
      const pos = this.videoPositionMs();
      let value = null;
      if (pos > duration - 5000) value = 0;
      else if (pos > 5000) value = Math.round(pos);
      if (value === null) return;
      API.post("/api/files/progress", { path: path, position_ms: value }).catch(() => {});
    },

    beaconProgress() {
      const path = this.paths[this.index];
      if (!path) return;
      if (this.videoDurationMs() <= 0) return;
      const data = JSON.stringify({
        path: path,
        position_ms: Math.round(this.videoPositionMs()),
      });
      try {
        navigator.sendBeacon(
          "/api/files/progress",
          new Blob([data], { type: "application/json" })
        );
      } catch (e) {}
    },

    /* -------------------------------------------------------- ui */

    updateTitle() {
      const path = this.paths[this.index] || "";
      if (!path) {
        document.title = "Media Web";
        return;
      }
      const title = this.index + 1 + "/" + this.paths.length + " - " + path.split(/[\\/]/).pop();
      document.title = title;
    },

    playlistPageSize() {
      const value = parseInt(window.Prefs ? Prefs.get("mw/pageSize", "30") : "30", 10);
      return [10, 20, 30, 50, 100].includes(value) ? value : 30;
    },

    renderPlaylistPanel() {
      const list = this.el.playerPlaylistView;
      if (!list) return;
      list.innerHTML = "";
      const size = this.playlistPageSize();
      const totalPages = Math.max(1, Math.ceil(this.paths.length / size));
      this.panelPage = Math.min(Math.max(1, this.panelPage || 1), totalPages);
      const start = (this.panelPage - 1) * size;
      this.paths.slice(start, start + size).forEach((path, offset) => {
        const index = start + offset;
        const li = document.createElement("li");
        li.dataset.index = index;
        li.draggable = true;
        li.title = path;
        const name = document.createElement("span");
        name.className = "pl-title";
        name.textContent = index + 1 + ". " + path.split(/[\\/]/).pop();
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "pl-remove";
        remove.title = "从播放列表移除";
        remove.textContent = "✕";
        li.append(name, remove);
        list.appendChild(li);
      });
      this.renderPlaylistPager(size, totalPages);
    },

    renderPlaylistPager(size, totalPages) {
      const box = this.el.playerPlaylistPager;
      if (!box) return;
      box.innerHTML = "";
      if (!this.paths.length) return;
      const info = document.createElement("span");
      info.className = "pager-info";
      info.textContent = "共 " + this.paths.length + " 条";
      const prev = document.createElement("button");
      prev.textContent = "上一页";
      prev.disabled = this.panelPage <= 1;
      prev.addEventListener("click", () => {
        this.panelPage -= 1;
        this.renderPlaylistPanel();
        this.updatePlaylistSelection();
      });
      const label = document.createElement("span");
      label.textContent = this.panelPage + " / " + totalPages;
      const next = document.createElement("button");
      next.textContent = "下一页";
      next.disabled = this.panelPage >= totalPages;
      next.addEventListener("click", () => {
        this.panelPage += 1;
        this.renderPlaylistPanel();
        this.updatePlaylistSelection();
      });
      const sizeSelect = document.createElement("select");
      for (const value of [10, 20, 30, 50, 100]) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value + " / 页";
        if (value === size) option.selected = true;
        sizeSelect.appendChild(option);
      }
      sizeSelect.addEventListener("change", () => {
        if (window.Prefs) Prefs.set("mw/pageSize", sizeSelect.value);
        this.panelPage = Math.floor(this.index / this.playlistPageSize()) + 1;
        this.renderPlaylistPanel();
        this.updatePlaylistSelection();
        if (window.APP && window.APP.refreshPlaylistView) window.APP.refreshPlaylistView();
      });
      box.append(info, prev, label, next, sizeSelect);
    },

    updatePlaylistSelection() {
      const size = this.playlistPageSize();
      const targetPage = Math.floor(Math.max(0, this.index) / size) + 1;
      if (targetPage !== this.panelPage) {
        this.panelPage = targetPage;
        this.renderPlaylistPanel();
      }
      Array.from(this.el.playerPlaylistView.querySelectorAll("li")).forEach((li) => {
        li.classList.toggle("selected", parseInt(li.dataset.index, 10) === this.index);
      });
      const current = this.el.playerPlaylistView.querySelector("li.selected");
      if (current) current.scrollIntoView({ block: "center" });
    },

    removePanelItem(index) {
      if (index < 0 || index >= this.paths.length) return;
      const wasCurrent = index === this.index;
      if (wasCurrent) this.saveProgress();
      this.paths.splice(index, 1);
      if (!this.paths.length) {
        this.index = -1;
        this.pauseForLeave();
        this.el.video.removeAttribute("src");
        this.el.video.load();
        this.renderPlaylistPanel();
        this.updateTitle();
        return;
      }
      if (wasCurrent) {
        this.index = Math.min(index, this.paths.length - 1);
        this.renderPlaylistPanel();
        this.playIndex(this.index, true);
        return;
      }
      if (index < this.index) this.index -= 1;
      this.renderPlaylistPanel();
      this.updatePlaylistSelection();
      this.updateTitle();
    },

    movePanelItem(from, to) {
      const count = this.paths.length;
      if (from < 0 || from >= count) return;
      to = Math.max(0, Math.min(count, to));
      if (to === from || to === from + 1) return;
      const [item] = this.paths.splice(from, 1);
      const insert = to > from ? to - 1 : to;
      this.paths.splice(insert, 0, item);
      if (this.index === from) {
        this.index = insert;
      } else {
        let current = this.index;
        if (from < current) current -= 1;
        if (insert <= current) current += 1;
        this.index = current;
      }
      this.clearDragMarks();
      this.renderPlaylistPanel();
      this.updatePlaylistSelection();
      this.updateTitle();
    },

    clearDragMarks() {
      if (!this.el.playerPlaylistView) return;
      Array.from(this.el.playerPlaylistView.querySelectorAll("li")).forEach((row) => {
        row.classList.remove("dragging", "drop-before", "drop-after");
      });
    },

    togglePanel() {
      this.el.playerPanel.classList.toggle("hidden");
    },

    togglePopover(id) {
      const target = document.getElementById(id);
      if (!target) return;
      const wasHidden = target.classList.contains("hidden");
      this.closePopovers();
      if (wasHidden) target.classList.remove("hidden");
    },

    closePopovers() {
      ["volumePopover", "speedPopover"].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.classList.add("hidden");
      });
    },

    switchPanelTab(name) {
      this.panelTab = name;
      Array.from(document.querySelectorAll(".ptab-btn")).forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.ptab === name);
      });
      Array.from(document.querySelectorAll(".ptab")).forEach((tab) => {
        tab.classList.toggle("active", tab.id === "ptab-" + name);
      });
      if (name === "info" && this.currentDetail) this.renderInfoPanel(this.currentDetail);
      if (name === "comments") this.refreshCommentsForCurrent();
      if (name === "recent" && window.APP && window.APP.refreshRecent) {
        window.APP.refreshRecent();
      }
      if (name === "shots") this.loadScreenshots();
    },

    async loadScreenshots() {
      const list = this.el.playerShotList;
      if (!list) return;
      list.innerHTML = "";
      const path = this.paths[this.index] || "";
      let data;
      try {
        data = await API.get("/api/screenshots", { path: path });
      } catch (e) {
        list.appendChild(makeShotHint("截图加载失败：" + e.message));
        return;
      }
      const items = data.items || [];
      if (!items.length) {
        list.appendChild(makeShotHint("暂无截图，按 C 或点击上方按钮截取"));
        return;
      }
      for (const item of items) {
        const box = document.createElement("div");
        box.className = "shot-item";
        const img = document.createElement("img");
        img.loading = "lazy";
        img.src = "/api/screenshots/" + item.id + "/image";
        img.alt = "";
        const time = document.createElement("span");
        time.className = "shot-time";
        time.textContent = Fmt.time(item.position_ms || 0);
        box.append(img, time);
        box.addEventListener("click", () => this.showScreenshot(item));
        list.appendChild(box);
      }
    },

    showScreenshot(item) {
      const wrap = document.createElement("div");
      const img = document.createElement("img");
      img.src = "/api/screenshots/" + item.id + "/image";
      img.style.width = "100%";
      img.style.borderRadius = "6px";
      img.style.background = "#000";
      const info = document.createElement("div");
      info.className = "settings-hint";
      info.style.marginTop = "8px";
      const videoName = item.video_path
        ? item.video_path.split(/[\\/]/).pop() + " · "
        : "";
      info.textContent =
        videoName + Fmt.time(item.position_ms || 0) + " · " + Fmt.dateTime(item.created_at);
      wrap.append(img, info);
      let modal = null;
      modal = UI.openModal({
        title: "截图",
        body: wrap,
        width: 720,
        footer: [
          {
            label: "下载",
            keepOpen: true,
            onClick: () => {
              const link = document.createElement("a");
              link.href = "/api/screenshots/" + item.id + "/image";
              link.download = "screenshot_" + item.id + ".png";
              link.click();
            },
          },
          {
            label: "删除",
            keepOpen: true,
            onClick: async () => {
              if (!(await UI.confirm("确定删除这张截图吗？"))) return;
              try {
                await API.del("/api/screenshots/" + item.id);
                UI.close(modal.overlay);
                this.loadScreenshots();
              } catch (error) {
                UI.alert(error.message);
              }
            },
          },
          { label: "关闭", primary: true },
        ],
      });
    },

    renderInfoPanel(detail) {
      const box = document.getElementById("ptab-info");
      if (!box) return;
      if (!detail) {
        box.innerHTML = "<p class='settings-hint'>正在读取视频信息...</p>";
        return;
      }
      const rec = detail.record || {};
      let html = "";
      if (detail.thumbnail) {
        html += "<div class='info-thumb'><img src='" + API.thumbUrl(detail.path) + "' alt=''></div>";
      }
      html += "<h3>" + Fmt.escape(detail.name) + "</h3><table class='info-table'>";
      const row = (key, value) => {
        html += "<tr><td>" + key + "</td><td>" + value + "</td></tr>";
      };
      row("路径", Fmt.escape(detail.path));
      row("大小", Fmt.bytes(detail.size));
      row("修改时间", Fmt.dateTime(detail.mtime));
      if (rec.duration_ms > 0) row("时长", Fmt.time(rec.duration_ms));
      if (rec.width > 0 && rec.height > 0) row("分辨率", rec.width + " × " + rec.height);
      if (rec.title) row("标题", Fmt.escape(rec.title));
      row("播放次数", rec.play_count !== undefined ? rec.play_count : 0);
      row("上次播放", Fmt.relative(rec.last_played_at));
      if (rec.last_position_ms > 0) row("上次进度", Fmt.time(rec.last_position_ms));
      const tags = (detail.tags || [])
        .map(
          (t) =>
            "<span class='tag-chip'>" +
            "<span class='dot' style='background:" +
            Fmt.escape(t.color || "#5c636e") +
            "'></span>" +
            Fmt.escape(t.name) +
            "<button class='tag-chip-x' data-tag='" +
            Fmt.escape(t.name) +
            "' title='移除标签'>✕</button>" +
            "</span>"
        )
        .join(" ");
      row(
        "标签",
        (tags || "<span class='settings-hint'>—</span>") +
          " <button id='infoEditTags' class='mini-btn'>编辑</button>"
      );
      row("评论", (detail.comment_count || 0) + " 条");
      html += "</table>";
      box.innerHTML = html;
      const editBtn = box.querySelector("#infoEditTags");
      if (editBtn) editBtn.addEventListener("click", () => this.editTags());
      box.querySelectorAll(".tag-chip-x").forEach((btn) => {
        btn.addEventListener("click", () => this.removeTag(btn.dataset.tag));
      });
    },

    async reloadDetail() {
      const path = this.paths[this.index];
      if (!path) return;
      try {
        const detail = await API.get("/api/files/detail", { path: path });
        if (this.paths[this.index] !== path) return;
        this.currentDetail = detail;
        this.renderInfoPanel(detail);
      } catch (e) {}
    },

    async removeTag(name) {
      const detail = this.currentDetail;
      const path = this.paths[this.index];
      if (!detail || !path || !name) return;
      const remaining = (detail.tags || [])
        .filter((t) => t.name !== name)
        .map((t) => t.name);
      try {
        await API.put("/api/files/tags", { path: path, tags: remaining });
        this.showOsd("已移除标签：" + name);
        await this.reloadDetail();
        if (window.APP && window.APP.onTagsChanged) window.APP.onTagsChanged();
      } catch (e) {
        UI.alert(e.message);
      }
    },

    editTags() {
      const path = this.paths[this.index];
      if (!path || !window.APP || !window.APP.editTags) return;
      window.APP.editTags([path], () => this.reloadDetail());
    },

    renderCommentPanel(items) {
      const list = document.getElementById("playerCommentList");
      if (!list) return;
      list.innerHTML = "";
      if (!items || !items.length) {
        const empty = document.createElement("div");
        empty.className = "settings-hint";
        empty.textContent = "暂无评论";
        list.appendChild(empty);
        return;
      }
      for (const comment of items) {
        const row = document.createElement("div");
        row.className = "comment-row";
        const time = document.createElement("span");
        time.className = "comment-time";
        time.textContent = Fmt.time(comment.position_ms);
        const text = document.createElement("span");
        text.className = "comment-text";
        text.textContent = comment.text;
        const actions = document.createElement("span");
        actions.className = "comment-actions";
        const edit = document.createElement("button");
        edit.textContent = "编辑";
        edit.addEventListener("click", async (e) => {
          e.stopPropagation();
          const value = await UI.prompt("编辑评论", comment.text, { multiline: true });
          if (!value || !value.trim()) return;
          try {
            await API.put("/api/comments/" + comment.id, { text: value.trim() });
            this.refreshCommentsForCurrent();
          } catch (error) {
            UI.alert(error.message);
          }
        });
        const remove = document.createElement("button");
        remove.textContent = "删除";
        remove.addEventListener("click", async (e) => {
          e.stopPropagation();
          if (!(await UI.confirm("确定删除该评论吗？"))) return;
          try {
            await API.del("/api/comments/" + comment.id);
            this.refreshCommentsForCurrent();
          } catch (error) {
            UI.alert(error.message);
          }
        });
        actions.append(edit, remove);
        row.append(time, text, actions);
        row.addEventListener("click", () => {
          this.applySeekMs(comment.position_ms);
        });
        list.appendChild(row);
      }
    },

    applyComments(items) {
      this.markers = (items || []).map((c) => ({
        position: c.position_ms,
        text: c.text,
      }));
      this.renderMarkers();
      this.renderCommentPanel(items);
      if (this.danmakuOn) this.resetDanmaku();
    },

    async refreshCommentsForCurrent() {
      const path = this.paths[this.index];
      if (!path) return;
      try {
        const data = await API.get("/api/comments", { path: path });
        this.applyComments(data.items || []);
      } catch (e) {}
    },

    applyVolume() {
      const value = Number(this.el.volume.value) || 0;
      this.el.video.volume = Math.min(1, Math.max(0, value / 100));
      this.el.volText.textContent = String(value);
    },

    setVolume(value) {
      this.el.volume.value = Math.min(100, Math.max(0, value));
      this.applyVolume();
      if (window.Prefs) Prefs.set("mw/volume", this.el.volume.value);
    },

    toggleMute() {
      const video = this.el.video;
      video.muted = !video.muted;
      this.el.btnMute.textContent = video.muted ? "取消静音" : "静音";
      if (this.el.btnVolume) this.el.btnVolume.classList.toggle("muted", video.muted);
      this.showOsd(video.muted ? "已静音" : "音量: " + this.el.volume.value);
    },

    applySpeed() {
      const value = Number(this.el.speed.value) || 10;
      this.el.video.playbackRate = value / 10;
      const text = (value / 10).toFixed(1) + "x";
      this.el.speedText.textContent = text;
      if (this.el.btnSpeed) this.el.btnSpeed.textContent = text;
    },

    cycleAspect() {
      const modes = ["contain", "cover", "fill"];
      const names = ["适应窗口", "裁剪填满", "拉伸"];
      this.aspectIndex = (this.aspectIndex + 1) % modes.length;
      this.el.video.style.objectFit = modes[this.aspectIndex];
      this.el.btnAspect.textContent = names[this.aspectIndex];
      this.showOsd("画面比例: " + names[this.aspectIndex]);
    },

    toggleFullscreen() {
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      } else {
        this.el.playerMain.requestFullscreen().catch(() => this.showOsd("全屏失败"));
      }
    },

    showOsd(text) {
      if (!text) return;
      this.el.playerOsd.textContent = text;
      this.el.playerOsd.classList.remove("hidden");
      clearTimeout(this.osdTimer);
      this.osdTimer = setTimeout(() => this.el.playerOsd.classList.add("hidden"), 1500);
    },

    /* -------------------------------------------------------- danmaku */

    danmakuCrossMs() {
      return this.danmakuCross || 8000;
    },

    setDanmaku(on) {
      this.danmakuOn = !!on;
      if (window.Prefs) Prefs.set("mw/danmaku", this.danmakuOn ? "1" : "0");
      this.el.btnDanmaku.textContent = this.danmakuOn ? "弹幕: 开" : "弹幕: 关";
      if (this.danmakuOn) this.resetDanmaku();
      else this.clearDanmaku();
      this.showOsd(this.danmakuOn ? "弹幕: 开" : "弹幕: 关");
    },

    toggleDanmaku() {
      this.setDanmaku(!this.danmakuOn);
    },

    clearDanmaku() {
      this.el.danmakuLayer.innerHTML = "";
      this.laneFree = [];
    },

    resetDanmaku(nowMs) {
      const now = nowMs !== undefined ? nowMs : this.videoPositionMs();
      this.clearDanmaku();
      this.lastDanmakuTime = now;
      if (!this.danmakuOn) return;
      const cross = this.danmakuCrossMs();
      for (const marker of this.markers) {
        const elapsed = now - marker.position;
        if (elapsed >= 0 && elapsed < cross * 0.9) this.spawnDanmaku(marker, elapsed);
      }
    },

    startDanmakuLoop() {
      if (this.danmakuRaf) return;
      const tick = () => {
        this.danmakuRaf = requestAnimationFrame(tick);
        this.danmakuStep();
      };
      this.danmakuRaf = requestAnimationFrame(tick);
    },

    danmakuStep() {
      if (!this.danmakuOn) return;
      if (!this.el.playerPage.classList.contains("active")) return;
      const t = this.videoPositionMs();
      const last = this.lastDanmakuTime;
      if (last < 0) {
        this.lastDanmakuTime = t;
        return;
      }
      if (t < last - 500 || t > last + 1500) {
        this.resetDanmaku(t);
        return;
      }
      if (t <= last) return;
      for (const marker of this.markers) {
        if (marker.position > last && marker.position <= t) this.spawnDanmaku(marker, 0);
      }
      this.lastDanmakuTime = t;
    },

    pickLane(nowVideoMs) {
      const lanes = Math.max(1, Math.floor(this.el.danmakuLayer.clientHeight / 30));
      if (!this.laneFree || this.laneFree.length !== lanes) {
        this.laneFree = new Array(lanes).fill(-Infinity);
      }
      for (let i = 0; i < lanes; i++) {
        if (this.laneFree[i] <= nowVideoMs) return i;
      }
      let best = 0;
      for (let i = 1; i < lanes; i++) {
        if (this.laneFree[i] < this.laneFree[best]) best = i;
      }
      return best;
    },

    spawnDanmaku(marker, elapsedMs) {
      if (!this.danmakuOn) return;
      const layer = this.el.danmakuLayer;
      const width = layer.clientWidth;
      if (!width) return;
      const nowVideo = this.videoPositionMs();
      const cross = this.danmakuCrossMs();
      const lane = this.pickLane(nowVideo);
      this.laneFree[lane] = nowVideo + cross * 0.6;
      const item = document.createElement("div");
      item.className = "danmaku-item";
      item.textContent = String(marker.text).replace(/\n/g, " ");
      const rate = this.el.video.playbackRate || 1;
      item.style.top = lane * 30 + "px";
      item.style.animationDuration = cross / rate + "ms";
      item.style.setProperty("--dm-width", width + "px");
      if (elapsedMs > 0) item.style.animationDelay = -(elapsedMs / rate) + "ms";
      item.addEventListener("animationend", () => item.remove());
      layer.appendChild(item);
    },

    updateProgress() {
      const duration = this.videoDurationMs();
      let current = this.videoPositionMs();
      if (this.streamMode && this.pendingSeekMs !== null) current = this.pendingSeekMs;
      const pct = duration > 0 ? Math.min(100, (current / duration) * 100) : 0;
      this.el.progressFill.style.width = pct + "%";
      this.el.progressHandle.style.left = pct + "%";
      this.el.timeNow.textContent = Fmt.time(current);
      if (duration > 0) this.el.timeTotal.textContent = Fmt.time(duration);
    },

    renderMarkers() {
      const container = this.el.progressMarkers;
      container.innerHTML = "";
      const duration = this.videoDurationMs();
      if (!this.markers.length || duration <= 0) return;
      for (const marker of this.markers) {
        const span = document.createElement("span");
        span.className = "marker";
        const left = Math.min(100, Math.max(0, (marker.position / duration) * 100));
        span.style.left = left + "%";
        span.title = "[" + Fmt.time(marker.position) + "] " + String(marker.text).replace(/\n/g, " ");
        container.appendChild(span);
      }
    },

    markerNear(x, width) {
      const duration = this.videoDurationMs();
      if (!this.markers.length || duration <= 0) return null;
      let best = null;
      let bestDistance = Infinity;
      for (const marker of this.markers) {
        const pixel = (marker.position / duration) * width;
        const distance = Math.abs(pixel - x);
        if (distance <= 6 && distance < bestDistance) {
          best = marker;
          bestDistance = distance;
        }
      }
      return best;
    },

    seekFromPointer(e) {
      const duration = this.videoDurationMs();
      if (duration <= 0) return;
      const rect = this.el.progressTrack.getBoundingClientRect();
      const x = Math.min(Math.max(e.clientX - rect.left, 0), rect.width);
      const ratio = rect.width > 0 ? x / rect.width : 0;
      let timeMs = ratio * duration;
      const marker = this.markerNear(x, rect.width);
      if (marker) timeMs = marker.position;
      if (this.streamMode) {
        this.pendingSeekMs = Math.min(timeMs, duration);
        this.updateProgress();
        return;
      }
      this.el.video.currentTime = Math.min(timeMs / 1000, duration / 1000);
      this.updateProgress();
    },

    onPointerDown(e) {
      if (this.videoDurationMs() <= 0) return;
      this.dragging = true;
      this.hidePreview();
      this.el.progressTrack.setPointerCapture(e.pointerId);
      this.seekFromPointer(e);
    },

    onPointerMove(e) {
      const track = this.el.progressTrack;
      const rect = track.getBoundingClientRect();
      const x = Math.min(Math.max(e.clientX - rect.left, 0), rect.width);
      if (this.dragging) {
        this.seekFromPointer(e);
        return;
      }
      const duration = this.videoDurationMs();
      const marker = this.markerNear(x, rect.width);
      let text;
      let left;
      if (marker) {
        text = "[" + Fmt.time(marker.position) + "] " + String(marker.text).replace(/\n/g, " ");
        left = (marker.position / duration) * 100;
      } else if (duration > 0) {
        const ratio = x / rect.width;
        const seconds = (ratio * duration) / 1000;
        left = ratio * 100;
        if (this.ffmpegOn) {
          this.el.progressTip.classList.add("hidden");
          this.schedulePreview(seconds, left);
          return;
        }
        text = Fmt.timePrecise(seconds * 1000);
      } else {
        return;
      }
      this.hidePreview();
      const tip = this.el.progressTip;
      tip.textContent = text;
      tip.style.left = Math.min(100, Math.max(0, left)) + "%";
      tip.classList.remove("hidden");
    },

    onPointerUp(e) {
      if (!this.dragging) return;
      this.dragging = false;
      try {
        this.el.progressTrack.releasePointerCapture(e.pointerId);
      } catch (error) {}
      this.el.progressTip.classList.add("hidden");
      this.hidePreview();
      if (this.streamMode && this.pendingSeekMs !== null) {
        this.restartStreamAt(this.pendingSeekMs);
      }
    },

    onKey(e) {
      if (!this.el.playerPage.classList.contains("active")) return;
      const target = e.target;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.ctrlKey && e.key.toLowerCase() === "q") {
        e.preventDefault();
        this.close();
        return;
      }
      if (e.ctrlKey && e.key.toLowerCase() === "l") {
        e.preventDefault();
        this.showComments();
        return;
      }
      switch (e.key) {
        case " ":
          e.preventDefault();
          this.toggle();
          break;
        case "ArrowLeft":
          e.preventDefault();
          if (!e.repeat) this.startArrowHold(-1);
          break;
        case "ArrowRight":
          e.preventDefault();
          if (!e.repeat) this.startArrowHold(1);
          break;
        case "ArrowUp":
          e.preventDefault();
          this.setVolume(Number(this.el.volume.value) + 5);
          break;
        case "ArrowDown":
          e.preventDefault();
          this.setVolume(Number(this.el.volume.value) - 5);
          break;
        case "f":
        case "F":
          this.toggleFullscreen();
          break;
        case "m":
        case "M":
          this.toggleMute();
          break;
        case "l":
        case "L":
          this.togglePanel();
          break;
        case "d":
        case "D":
          this.toggleDanmaku();
          break;
        case "n":
        case "N":
          this.addComment();
          break;
        case "c":
        case "C":
          this.snapshot();
          break;
        case "a":
        case "A":
          this.cycleAspect();
          break;
      }
    },

    snapshot() {
      const video = this.el.video;
      if (!video.videoWidth) {
        this.showOsd("截图失败：无画面");
        return;
      }
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(async (blob) => {
        if (!blob) {
          this.showOsd("截图失败");
          return;
        }
        const base = (this.paths[this.index] || "snapshot")
          .split(/[\\/]/)
          .pop()
          .replace(/\.[^.]+$/, "");
        const name = base + "_" + Fmt.timestamp() + ".png";
        try {
          const form = new FormData();
          form.append("file", blob, name);
          form.append("path", this.paths[this.index] || "");
          form.append("position_ms", Math.round(this.videoPositionMs()));
          const res = await fetch("/api/screenshots", { method: "POST", body: form });
          if (!res.ok) throw new Error("upload failed");
          this.showOsd("截图已保存: " + name);
          if (this.panelTab === "shots") this.loadScreenshots();
        } catch (error) {
          this.showOsd("截图保存失败");
        }
      }, "image/png");
    },

    /* -------------------------------------------------------- comments */

    async loadComments(path, token) {
      try {
        const data = await API.get("/api/comments", { path: path });
        if (token !== this.loadToken) return;
        this.applyComments(data.items || []);
      } catch (e) {
        this.applyComments([]);
      }
    },

    async addComment() {
      const path = this.paths[this.index];
      if (!path) {
        this.showOsd("请先播放视频");
        return;
      }
      if (!this.el.video.paused) this.el.video.pause();
      const pos = Math.round(this.videoPositionMs());
      const text = await UI.prompt("在 " + Fmt.time(pos) + " 处添加评论：", "", {
        multiline: true,
      });
      if (!text || !text.trim()) return;
      try {
        await API.post("/api/comments", { path: path, position_ms: pos, text: text.trim() });
        await this.refreshCommentsForCurrent();
        this.showOsd("评论已添加（共 " + this.markers.length + " 条）");
      } catch (e) {
        UI.alert(e.message);
      }
    },

    showComments() {
      this.el.playerPanel.classList.remove("hidden");
      this.switchPanelTab("comments");
    },
  };

  function makeShotHint(text) {
    const box = document.createElement("div");
    box.className = "shot-empty";
    box.textContent = text;
    return box;
  }

  window.Player = Player;
  document.addEventListener("DOMContentLoaded", () => Player.init());
})();
