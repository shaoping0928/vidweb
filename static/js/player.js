(function () {
  "use strict";

  const Player = {
    paths: [],
    index: -1,
    mode: 0,
    markers: [],
    cues: [],
    subName: "",
    subVisible: true,
    subDelay: 0,
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
    el: {},

    init() {
      if (this.initialized) return;
      this.initialized = true;
      const ids = [
        "playerPage", "video", "subtitleOverlay", "playerOsd", "playerHeader", "playerTitle",
        "playerStage", "playerMain", "playerBody", "playerPanel", "playerPlaylistView", "playerBack",
        "progressTrack", "progressFill", "progressHandle", "progressMarkers", "progressTip",
        "timeNow", "timeTotal", "btnPrev", "btnPlay", "btnNext", "btnMode", "btnList", "btnAspect",
        "btnSnap", "btnMute", "volume", "volText", "speed", "speedText", "btnFullscreen",
        "btnLoadSub", "btnToggleSub", "btnAddComment", "btnAddCommentPanel", "btnPanelToggle",
        "subtitleFileInput", "danmakuLayer", "btnDanmaku", "playerCommentList",
      ];
      ids.forEach((id) => {
        this.el[id] = document.getElementById(id);
      });
      let defaults = {};
      try {
        defaults = JSON.parse(localStorage.getItem("mw/defaults") || "{}");
      } catch (e) {
        defaults = {};
      }
      const modeRaw = localStorage.getItem("mw/mode");
      this.mode = modeRaw !== null ? parseInt(modeRaw, 10) || 0 : parseInt(defaults.mode, 10) || 0;
      const volumeRaw = localStorage.getItem("mw/volume");
      this.el.volume.value =
        volumeRaw !== null ? volumeRaw : String(defaults.volume !== undefined ? defaults.volume : 80);
      const speedRaw = localStorage.getItem("mw/speed");
      this.el.speed.value =
        speedRaw !== null ? speedRaw : String(defaults.speed !== undefined ? defaults.speed : 10);
      const danmakuRaw = localStorage.getItem("mw/danmaku");
      this.danmakuOn = danmakuRaw !== null ? danmakuRaw === "1" : defaults.danmaku !== false;
      const danmakuSpeedRaw = localStorage.getItem("mw/danmakuSpeed");
      this.danmakuCross =
        parseInt(danmakuSpeedRaw || String(defaults.danmakuSpeed || 8000), 10) || 8000;
      this.el.btnDanmaku.textContent = this.danmakuOn ? "弹幕: 开" : "弹幕: 关";
      this.el.danmakuLayer.classList.add("dm-paused");
      this.startDanmakuLoop();
      this.applyVolume();
      this.applySpeed();
      this.updateModeButton();
      this.bind();
    },

    bind() {
      const el = this.el;
      el.btnPlay.addEventListener("click", () => this.toggle());
      el.btnPrev.addEventListener("click", () => this.playIndex(this.index - 1));
      el.btnNext.addEventListener("click", () => this.playIndex(this.index + 1));
      el.btnMode.addEventListener("click", () => this.cycleMode());
      el.btnList.addEventListener("click", () => this.togglePanel());
      el.btnPanelToggle.addEventListener("click", () => this.togglePanel());
      el.btnDanmaku.addEventListener("click", () => this.setDanmaku(!this.danmakuOn));
      el.playerBack.addEventListener("click", () => this.close());
      el.btnMute.addEventListener("click", () => this.toggleMute());
      el.btnAspect.addEventListener("click", () => this.cycleAspect());
      el.btnSnap.addEventListener("click", () => this.snapshot());
      el.btnFullscreen.addEventListener("click", () => this.toggleFullscreen());
      el.btnToggleSub.addEventListener("click", () => this.toggleSub());
      el.btnLoadSub.addEventListener("click", () => el.subtitleFileInput.click());
      el.btnAddComment.addEventListener("click", () => this.addComment());
      el.btnAddCommentPanel.addEventListener("click", () => this.addComment());
      Array.from(document.querySelectorAll(".ptab-btn")).forEach((btn) => {
        btn.addEventListener("click", () => this.switchPanelTab(btn.dataset.ptab));
      });
      el.volume.addEventListener("input", () => {
        this.applyVolume();
        localStorage.setItem("mw/volume", el.volume.value);
      });
      el.speed.addEventListener("input", () => {
        this.applySpeed();
        localStorage.setItem("mw/speed", el.speed.value);
      });
      el.subtitleFileInput.addEventListener("change", () => {
        const file = el.subtitleFileInput.files[0];
        if (file) this.uploadSubtitle(file);
        el.subtitleFileInput.value = "";
      });
      el.playerStage.addEventListener("dblclick", (e) => {
        if (e.target.closest("#controls")) return;
        this.toggleFullscreen();
      });
      el.playerPlaylistView.addEventListener("dblclick", (e) => {
        const li = e.target.closest("li");
        if (li && li.dataset.index !== undefined) this.playIndex(parseInt(li.dataset.index, 10));
      });

      const video = el.video;
      video.addEventListener("loadedmetadata", () => this.onLoadedMetadata());
      video.addEventListener("durationchange", () => this.updateProgress());
      video.addEventListener("timeupdate", () => {
        this.updateProgress();
        this.updateSubtitle();
        if (Date.now() - this.lastSaveTs > 5000) {
          this.lastSaveTs = Date.now();
          this.saveProgress();
        }
      });
      video.addEventListener("play", () => {
        el.btnPlay.textContent = "⏸";
        el.danmakuLayer.classList.remove("dm-paused");
      });
      video.addEventListener("pause", () => {
        el.btnPlay.textContent = "▶";
        el.danmakuLayer.classList.add("dm-paused");
        this.saveProgress();
      });
      video.addEventListener("seeked", () => this.resetDanmaku());
      video.addEventListener("ended", () => this.onEnded());
      video.addEventListener("error", () => {
        if (this.paths[this.index]) this.showOsd("播放失败：浏览器可能不支持该视频编码");
      });

      const track = el.progressTrack;
      track.addEventListener("pointerdown", (e) => this.onPointerDown(e));
      track.addEventListener("pointermove", (e) => this.onPointerMove(e));
      track.addEventListener("pointerup", (e) => this.onPointerUp(e));
      track.addEventListener("pointercancel", () => {
        this.dragging = false;
      });
      track.addEventListener("pointerleave", () => {
        if (!this.dragging) el.progressTip.classList.add("hidden");
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
      if (window.APP && window.APP.setTab) window.APP.setTab("player");
      this.renderPlaylistPanel();
      await this.playIndex(index || 0);
    },

    async playIndex(i) {
      if (!this.paths.length) return;
      this.saveProgress();
      const count = this.paths.length;
      this.index = ((i % count) + count) % count;
      const path = this.paths[this.index];
      const token = ++this.loadToken;
      this.resumeApplied = false;
      this.pendingResume = -1;
      this.cues = [];
      this.subName = "";
      this.subVisible = true;
      this.subDelay = 0;
      this.el.subtitleOverlay.textContent = "";
      this.markers = [];
      this.renderMarkers();
      this.clearDanmaku();
      this.lastDanmakuTime = -1;
      this.currentDetail = null;
      this.renderInfoPanel(null);
      this.el.video.src = API.streamUrl(path);
      this.el.video.play().catch(() => {});
      this.updateTitle();
      this.updatePlaylistSelection();
      API.post("/api/files/played", { path }).catch(() => {});
      this.loadComments(path, token);
      this.loadSubtitle(path, token);
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
      this.el.timeTotal.textContent = Fmt.time((video.duration || 0) * 1000);
      this.maybeResume();
      this.renderMarkers();
      const path = this.paths[this.index];
      if (path) {
        API.post("/api/files/media_info", {
          path: path,
          duration_ms: Math.round((video.duration || 0) * 1000),
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
      this.saveProgress();
      const count = this.paths.length;
      if (this.mode === 2) this.playIndex(this.index);
      else if (this.mode === 3) this.playIndex(Math.floor(Math.random() * count));
      else if (this.mode === 1) this.playIndex(this.index + 1);
      else if (this.index + 1 < count) this.playIndex(this.index + 1);
    },

    toggle() {
      if (!this.paths.length) return;
      const video = this.el.video;
      if (video.paused) video.play().catch(() => {});
      else video.pause();
    },

    seekRelative(ms) {
      const video = this.el.video;
      if (!isFinite(video.duration) || video.duration <= 0) return;
      video.currentTime = Math.min(
        Math.max(0, video.currentTime + ms / 1000),
        video.duration
      );
    },

    close() {
      this.saveProgress();
      this.el.video.pause();
      if (window.APP && window.APP.setTab) window.APP.setTab("lib");
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      if (window.APP && window.APP.onPlayerClosed) window.APP.onPlayerClosed();
    },

    saveProgress() {
      const path = this.paths[this.index];
      if (!path) return;
      const video = this.el.video;
      if (!isFinite(video.duration) || video.duration <= 0) return;
      const pos = video.currentTime * 1000;
      const duration = video.duration * 1000;
      let value = null;
      if (pos > duration - 5000) value = 0;
      else if (pos > 5000) value = Math.round(pos);
      if (value === null) return;
      API.post("/api/files/progress", { path: path, position_ms: value }).catch(() => {});
    },

    beaconProgress() {
      const path = this.paths[this.index];
      if (!path) return;
      const video = this.el.video;
      if (!isFinite(video.duration) || video.duration <= 0) return;
      const data = JSON.stringify({
        path: path,
        position_ms: Math.round(video.currentTime * 1000),
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
      this.el.playerTitle.textContent =
        this.index + 1 + "/" + this.paths.length + " - " + path.split(/[\\/]/).pop();
    },

    renderPlaylistPanel() {
      const list = this.el.playerPlaylistView;
      list.innerHTML = "";
      this.paths.forEach((path, index) => {
        const li = document.createElement("li");
        li.textContent = index + 1 + ". " + path.split(/[\\/]/).pop();
        li.title = path;
        li.dataset.index = index;
        list.appendChild(li);
      });
    },

    updatePlaylistSelection() {
      Array.from(this.el.playerPlaylistView.querySelectorAll("li")).forEach((li) => {
        li.classList.toggle("selected", parseInt(li.dataset.index, 10) === this.index);
      });
      const current = this.el.playerPlaylistView.querySelector("li.selected");
      if (current) current.scrollIntoView({ block: "center" });
    },

    togglePanel() {
      this.el.playerPanel.classList.toggle("hidden");
    },

    switchPanelTab(name) {
      Array.from(document.querySelectorAll(".ptab-btn")).forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.ptab === name);
      });
      Array.from(document.querySelectorAll(".ptab")).forEach((tab) => {
        tab.classList.toggle("active", tab.id === "ptab-" + name);
      });
      if (name === "info" && this.currentDetail) this.renderInfoPanel(this.currentDetail);
      if (name === "comments") this.refreshCommentsForCurrent();
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
            "<span class='dot' style='background:" +
            Fmt.escape(t.color || "#5c636e") +
            "'></span>" +
            Fmt.escape(t.name)
        )
        .join(" ");
      row("标签", tags || "—");
      row("评论", (detail.comment_count || 0) + " 条");
      html += "</table>";
      box.innerHTML = html;
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
          this.el.video.currentTime = comment.position_ms / 1000;
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

    cycleMode() {
      this.mode = (this.mode + 1) % 4;
      localStorage.setItem("mw/mode", String(this.mode));
      this.updateModeButton();
    },

    updateModeButton() {
      const names = ["顺序", "列表循环", "单曲循环", "随机"];
      this.el.btnMode.textContent = names[this.mode] || names[0];
    },

    applyVolume() {
      const value = Number(this.el.volume.value) || 0;
      this.el.video.volume = Math.min(1, Math.max(0, value / 100));
      this.el.volText.textContent = String(value);
    },

    setVolume(value) {
      this.el.volume.value = Math.min(100, Math.max(0, value));
      this.applyVolume();
      localStorage.setItem("mw/volume", this.el.volume.value);
    },

    toggleMute() {
      const video = this.el.video;
      video.muted = !video.muted;
      this.el.btnMute.textContent = video.muted ? "已静音" : "音量";
      this.showOsd(video.muted ? "已静音" : "音量: " + this.el.volume.value);
    },

    applySpeed() {
      const value = Number(this.el.speed.value) || 10;
      this.el.video.playbackRate = value / 10;
      this.el.speedText.textContent = (value / 10).toFixed(1) + "x";
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
      localStorage.setItem("mw/danmaku", this.danmakuOn ? "1" : "0");
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
      const now = nowMs !== undefined ? nowMs : this.el.video.currentTime * 1000;
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
      const t = this.el.video.currentTime * 1000;
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
      const nowVideo = this.el.video.currentTime * 1000;
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
      const video = this.el.video;
      const duration = isFinite(video.duration) ? video.duration : 0;
      const current = video.currentTime || 0;
      const pct = duration > 0 ? Math.min(100, (current / duration) * 100) : 0;
      this.el.progressFill.style.width = pct + "%";
      this.el.progressHandle.style.left = pct + "%";
      this.el.timeNow.textContent = Fmt.time(current * 1000);
      if (duration > 0) this.el.timeTotal.textContent = Fmt.time(duration * 1000);
    },

    renderMarkers() {
      const container = this.el.progressMarkers;
      container.innerHTML = "";
      const video = this.el.video;
      if (!this.markers.length || !isFinite(video.duration) || video.duration <= 0) return;
      for (const marker of this.markers) {
        const span = document.createElement("span");
        span.className = "marker";
        const left = Math.min(100, Math.max(0, (marker.position / (video.duration * 1000)) * 100));
        span.style.left = left + "%";
        span.title = "[" + Fmt.time(marker.position) + "] " + String(marker.text).replace(/\n/g, " ");
        container.appendChild(span);
      }
    },

    markerNear(x, width) {
      const video = this.el.video;
      if (!this.markers.length || !isFinite(video.duration) || video.duration <= 0) return null;
      let best = null;
      let bestDistance = Infinity;
      for (const marker of this.markers) {
        const pixel = (marker.position / (video.duration * 1000)) * width;
        const distance = Math.abs(pixel - x);
        if (distance <= 6 && distance < bestDistance) {
          best = marker;
          bestDistance = distance;
        }
      }
      return best;
    },

    seekFromPointer(e) {
      const video = this.el.video;
      if (!isFinite(video.duration) || video.duration <= 0) return;
      const rect = this.el.progressTrack.getBoundingClientRect();
      const x = Math.min(Math.max(e.clientX - rect.left, 0), rect.width);
      const ratio = rect.width > 0 ? x / rect.width : 0;
      let time = ratio * video.duration;
      const marker = this.markerNear(x, rect.width);
      if (marker) time = marker.position / 1000;
      video.currentTime = Math.min(time, video.duration);
      this.updateProgress();
    },

    onPointerDown(e) {
      if (!isFinite(this.el.video.duration) || this.el.video.duration <= 0) return;
      this.dragging = true;
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
      const video = this.el.video;
      const marker = this.markerNear(x, rect.width);
      let text;
      let left;
      if (marker) {
        text = "[" + Fmt.time(marker.position) + "] " + String(marker.text).replace(/\n/g, " ");
        left = (marker.position / (video.duration * 1000)) * 100;
      } else if (isFinite(video.duration) && video.duration > 0) {
        const ratio = x / rect.width;
        text = Fmt.timePrecise(ratio * video.duration * 1000);
        left = ratio * 100;
      } else {
        return;
      }
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
          this.seekRelative(-5000);
          break;
        case "ArrowRight":
          e.preventDefault();
          this.seekRelative(5000);
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
        case "s":
        case "S":
          this.toggleSub();
          break;
        case "[":
          this.adjustSubtitleDelay(-100);
          break;
        case "]":
          this.adjustSubtitleDelay(100);
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
      canvas.toBlob((blob) => {
        if (!blob) {
          this.showOsd("截图失败");
          return;
        }
        const base = (this.paths[this.index] || "snapshot")
          .split(/[\\/]/)
          .pop()
          .replace(/\.[^.]+$/, "");
        const name = base + "_" + Fmt.timestamp() + ".png";
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = name;
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 10000);
        this.showOsd("截图已保存: " + name);
      }, "image/png");
    },

    /* -------------------------------------------------------- subtitles */

    async loadSubtitle(path, token) {
      try {
        const data = await API.get("/api/subtitles", { path: path });
        if (token !== this.loadToken) return;
        if (data.cues && data.cues.length) {
          this.cues = data.cues;
          this.subName = data.name || "";
          this.subVisible = true;
          this.subDelay = 0;
          this.updateSubtitle();
        } else {
          this.cues = [];
          this.subName = "";
        }
      } catch (e) {
        this.cues = [];
      }
    },

    async uploadSubtitle(file) {
      const form = new FormData();
      form.append("file", file);
      try {
        const res = await fetch("/api/subtitles/parse", { method: "POST", body: form });
        if (!res.ok) throw new Error("parse failed");
        const data = await res.json();
        if (!data.cues || !data.cues.length) {
          this.showOsd("字幕加载失败");
          return;
        }
        this.cues = data.cues;
        this.subName = data.name || file.name;
        this.subVisible = true;
        this.subDelay = 0;
        this.updateSubtitle();
        this.showOsd("字幕已加载: " + this.subName);
      } catch (e) {
        this.showOsd("字幕加载失败");
      }
    },

    updateSubtitle() {
      const overlay = this.el.subtitleOverlay;
      if (!this.subVisible || !this.cues.length) {
        if (overlay.textContent) overlay.textContent = "";
        return;
      }
      const pos = this.el.video.currentTime * 1000 - this.subDelay;
      let text = "";
      for (const cue of this.cues) {
        if (pos >= cue.start && pos <= cue.end) {
          text = cue.text;
          break;
        }
      }
      if (overlay.textContent !== text) overlay.textContent = text;
    },

    toggleSub() {
      this.subVisible = !this.subVisible;
      if (this.subVisible) this.updateSubtitle();
      else this.el.subtitleOverlay.textContent = "";
      this.showOsd(this.subVisible ? "字幕: 开" : "字幕: 关");
    },

    adjustSubtitleDelay(delta) {
      this.subDelay += delta;
      this.updateSubtitle();
      this.showOsd("字幕延迟: " + this.subDelay + "ms");
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
      const pos = Math.round(this.el.video.currentTime * 1000);
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

  window.Player = Player;
  document.addEventListener("DOMContentLoaded", () => Player.init());
})();
