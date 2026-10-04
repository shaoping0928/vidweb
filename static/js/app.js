(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const state = {
    tab: "path",
    path: localStorage.getItem("mw/lastPath") || "",
    onlyVideo: localStorage.getItem("mw/onlyVideo") === "true",
    sort: parseInt(localStorage.getItem("mw/sort") || "0", 10) || 0,
    dirs: [],
    entries: [],
    playlist: JSON.parse(localStorage.getItem("mw/playlist") || "[]"),
    playlistInfo: {},
    visiblePaths: [],
    activeTagIds: [],
    tagMatchAll: false,
    tags: [],
    config: {},
    detailPath: "",
    searchItems: [],
    recentItems: [],
    selectedPaths: [],
    lastSelIndex: -1,
    selListEl: null,
  };

  function basename(path) {
    return String(path || "").split(/[\\/]/).pop() || "";
  }

  function setStatus(text) {
    $("#statusText").textContent = text || "";
  }

  function setTab(name) {
    state.tab = name;
    $$("#tabs .tab").forEach((btn) => btn.classList.toggle("active", btn.dataset.tab === name));
    $$(".page").forEach((page) => page.classList.toggle("active", page.id === "page-" + name));
    if (name === "recent") refreshRecent();
  }

  /* ------------------------------------------------------------ UI */

  const UI = {
    _stack: [],
    openModal(options) {
      const opts = options || {};
      const overlay = document.createElement("div");
      overlay.className = "modal-overlay";
      const box = document.createElement("div");
      box.className = "modal";
      if (opts.width) box.style.width = opts.width + "px";
      const head = document.createElement("div");
      head.className = "modal-head";
      const title = document.createElement("span");
      title.textContent = opts.title || "";
      const closeBtn = document.createElement("button");
      closeBtn.textContent = "✕";
      closeBtn.style.padding = "2px 8px";
      closeBtn.addEventListener("click", () => UI.close(overlay));
      head.append(title, closeBtn);
      const body = document.createElement("div");
      body.className = "modal-body";
      if (typeof opts.body === "string") body.innerHTML = opts.body;
      else if (opts.body) body.appendChild(opts.body);
      const foot = document.createElement("div");
      foot.className = "modal-foot";
      (opts.footer || []).forEach((spec) => {
        const btn = document.createElement("button");
        btn.textContent = spec.label;
        if (spec.primary) btn.classList.add("primary");
        btn.addEventListener("click", () => {
          const result = spec.onClick ? spec.onClick() : undefined;
          if (!spec.keepOpen) UI.close(overlay);
          return result;
        });
        foot.appendChild(btn);
      });
      if ((opts.footer || []).length) box.append(head, body, foot);
      else box.append(head, body);
      overlay.appendChild(box);
      if (!opts.persistent) {
        overlay.addEventListener("mousedown", (e) => {
          if (e.target === overlay) UI.close(overlay);
        });
      }
      $("#modalRoot").appendChild(overlay);
      UI._stack.push(overlay);
      return { overlay, box, body, foot };
    },
    close(overlay) {
      const target = overlay || UI._stack[UI._stack.length - 1];
      if (!target) return;
      target.remove();
      UI._stack = UI._stack.filter((o) => o !== target);
    },
    prompt(title, defaultValue, options) {
      const opts = options || {};
      return new Promise((resolve) => {
        const wrap = document.createElement("div");
        const label = document.createElement("div");
        label.className = "modal-label";
        label.textContent = title;
        const input = opts.multiline ? document.createElement("textarea") : document.createElement("input");
        input.className = "modal-input";
        input.value = defaultValue || "";
        if (opts.placeholder) input.placeholder = opts.placeholder;
        if (opts.multiline) input.rows = 5;
        wrap.append(label, input);
        let done = false;
        const finish = (value) => {
          if (done) return;
          done = true;
          UI.close(modal.overlay);
          resolve(value);
        };
        const modal = UI.openModal({
          title: opts.windowTitle || "输入",
          body: wrap,
          width: 440,
          persistent: true,
          footer: [
            { label: "取消", onClick: () => finish(null) },
            { label: "确定", primary: true, onClick: () => finish(input.value) },
          ],
        });
        setTimeout(() => input.focus(), 0);
        input.addEventListener("keydown", (e) => {
          if (!opts.multiline && e.key === "Enter") {
            e.preventDefault();
            finish(input.value);
          }
          if (e.key === "Escape") finish(null);
        });
      });
    },
    confirm(message, options) {
      const opts = options || {};
      return new Promise((resolve) => {
        const body = document.createElement("div");
        body.className = "modal-text";
        body.textContent = message;
        let done = false;
        const finish = (value) => {
          if (done) return;
          done = true;
          UI.close(modal.overlay);
          resolve(value);
        };
        const modal = UI.openModal({
          title: opts.title || "确认",
          body,
          width: 380,
          persistent: true,
          footer: [
            { label: "取消", onClick: () => finish(false) },
            { label: opts.okLabel || "确定", primary: true, onClick: () => finish(true) },
          ],
        });
      });
    },
    alert(message, title) {
      const body = document.createElement("div");
      body.className = "modal-text";
      body.textContent = message;
      UI.openModal({
        title: title || "提示",
        body,
        width: 420,
        footer: [{ label: "确定", primary: true }],
      });
    },
    toast(text) {
      setStatus(text);
    },
  };
  window.UI = UI;

  /* ------------------------------------------------------------ context menu */

  function closeMenu() {
    const menu = document.getElementById("ctxMenu");
    if (menu) menu.remove();
  }

  function showMenu(x, y, items) {
    closeMenu();
    const menu = document.createElement("div");
    menu.className = "ctx-menu";
    menu.id = "ctxMenu";
    for (const item of items) {
      if (item === "-") {
        const sep = document.createElement("div");
        sep.className = "ctx-sep";
        menu.appendChild(sep);
        continue;
      }
      const btn = document.createElement("button");
      btn.className = "ctx-item";
      btn.textContent = item.label;
      btn.disabled = item.enabled === false;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        closeMenu();
        if (item.onClick) item.onClick();
      });
      menu.appendChild(btn);
    }
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = Math.min(x, window.innerWidth - rect.width - 8) + "px";
    menu.style.top = Math.min(y, window.innerHeight - rect.height - 8) + "px";
  }

  document.addEventListener("click", closeMenu);
  window.addEventListener("blur", closeMenu);

  /* ------------------------------------------------------------ selection */

  function updateSelectionStyles() {
    $$(".list li").forEach((li) => {
      li.classList.toggle("selected", state.selectedPaths.includes(li.dataset.path));
    });
  }

  function handleItemClick(e, listEl, paths, li) {
    const path = li.dataset.path;
    const idx = paths.indexOf(path);
    if (e.shiftKey && state.lastSelIndex >= 0 && state.selListEl === listEl) {
      const a = Math.min(state.lastSelIndex, idx);
      const b = Math.max(state.lastSelIndex, idx);
      state.selectedPaths = paths.slice(a, b + 1);
    } else if (e.ctrlKey) {
      const pos = state.selectedPaths.indexOf(path);
      if (pos >= 0) state.selectedPaths.splice(pos, 1);
      else state.selectedPaths.push(path);
      state.lastSelIndex = idx;
    } else {
      state.selectedPaths = [path];
      state.lastSelIndex = idx;
    }
    state.selListEl = listEl;
    updateSelectionStyles();
  }

  function selectedOr(path) {
    return state.selectedPaths.includes(path) ? state.selectedPaths.slice() : [path];
  }

  /* ------------------------------------------------------------ thumbnails */

  function bindThumb(container, path, hasThumb) {
    const img = container.querySelector("img.thumb-img");
    if (!img) return;
    const available = hasThumb || state.config.ffmpeg;
    if (!available) return;
    let tries = 0;
    const attempt = () => {
      img.src = API.thumbUrl(path, tries ? Date.now() : 0);
    };
    img.onload = () => container.classList.add("has-thumb");
    img.onerror = () => {
      if (!hasThumb && state.config.ffmpeg && tries++ < 15) {
        setTimeout(attempt, 2000);
      }
    };
    attempt();
  }

  function makeMediaItem(options) {
    const li = document.createElement("li");
    li.className = "media-item" + (options.missing ? " missing" : "");
    li.dataset.path = options.path;
    const thumb = document.createElement("div");
    thumb.className = "thumb";
    const img = document.createElement("img");
    img.className = "thumb-img";
    img.alt = "";
    const placeholder = document.createElement("div");
    placeholder.className = "thumb-ph";
    placeholder.textContent = "无缩略图";
    thumb.append(img, placeholder);
    const meta = document.createElement("div");
    meta.className = "meta";
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = options.name || basename(options.path);
    name.title = options.path;
    const sub = document.createElement("div");
    sub.className = "sub";
    sub.textContent = options.subtitle || "";
    if (options.missing) {
      const badge = document.createElement("span");
      badge.className = "badge missing";
      badge.textContent = "文件不存在";
      badge.style.marginRight = "6px";
      sub.prepend(badge);
    }
    meta.append(name, sub);
    li.append(thumb, meta);
    li.title = options.path + (options.missing ? "\n文件不存在" : "");
    bindThumb(thumb, options.path, !!options.hasThumb);
    return li;
  }

  /* ------------------------------------------------------------ path browser */

  let filterTimer = null;

  async function browse(path) {
    try {
      const data = await API.get("/api/browse", {
        path: path || "",
        filter: $("#pathFilter").value.trim(),
        only_video: state.onlyVideo,
        sort: state.sort,
      });
      state.path = data.path;
      state.entries = data.entries;
      $("#pathInput").value = data.path;
      localStorage.setItem("mw/lastPath", data.path);
      renderFileList();
    } catch (e) {
      UI.toast("打开目录失败: " + e.message);
    }
  }

  function renderFileList() {
    const list = $("#fileList");
    list.innerHTML = "";
    for (const entry of state.entries) {
      const li = document.createElement("li");
      li.className = "entry" + (entry.isdir ? " dir" : entry.is_video ? " video" : "");
      li.dataset.path = entry.path;
      li.dataset.isdir = entry.isdir ? "true" : "false";
      const name = document.createElement("span");
      name.className = "entry-name";
      name.textContent = entry.name;
      const badge = document.createElement("span");
      badge.className = "badge" + (entry.is_video ? " video" : "");
      badge.textContent = entry.isdir ? "目录" : entry.is_video ? "视频" : "";
      badge.style.visibility = entry.isdir || entry.is_video ? "visible" : "hidden";
      const meta = document.createElement("span");
      meta.className = "entry-meta";
      meta.textContent = entry.isdir ? "" : Fmt.bytes(entry.size);
      li.append(name, badge, meta);
      list.appendChild(li);
    }
  }

  async function openVideosInDir(dirPath, startPath) {
    try {
      const data = await API.get("/api/browse", { path: dirPath, sort: 0 });
      const files = data.entries.filter((e) => e.is_video).map((e) => e.path);
      if (!files.length) return;
      let index = files.indexOf(startPath);
      if (index < 0) index = 0;
      Player.open(files, index);
    } catch (e) {
      UI.alert(e.message);
    }
  }

  async function explore(path) {
    try {
      await API.post("/api/explore", { path });
    } catch (e) {
      UI.toast("无法打开: " + e.message);
    }
  }

  /* ------------------------------------------------------------ library dirs */

  async function loadLibraryDirs() {
    try {
      const data = await API.get("/api/library/dirs");
      state.dirs = data.items;
      renderDirList();
    } catch (e) {
      UI.toast(e.message);
    }
  }

  function renderDirList() {
    const list = $("#dirList");
    list.innerHTML = "";
    for (const item of state.dirs) {
      const li = document.createElement("li");
      li.className = "entry" + (item.exists ? "" : " missing");
      li.dataset.path = item.path;
      li.title = item.path + (item.exists ? "" : "\n目录不存在");
      const name = document.createElement("span");
      name.className = "entry-name";
      name.textContent = item.path;
      li.appendChild(name);
      list.appendChild(li);
    }
  }

  async function addLibraryDir(path) {
    try {
      const data = await API.post("/api/library/dirs", { path });
      state.dirs = data.items;
      renderDirList();
    } catch (e) {
      UI.alert(e.message);
    }
  }

  async function removeLibraryDir() {
    const selected = state.selectedPaths.filter((p) => state.dirs.some((d) => d.path === p));
    const target = selected.length ? selected[0] : null;
    if (!target) {
      UI.alert("请先在路径库列表中选择要移除的目录");
      return;
    }
    try {
      const data = await API.post("/api/library/dirs/remove", { path: target });
      state.dirs = data.items;
      renderDirList();
    } catch (e) {
      UI.alert(e.message);
    }
  }

  async function scanDir(path) {
    if (!path) {
      UI.alert("请先在路径库列表中选择目录");
      return;
    }
    try {
      UI.toast("正在扫描...");
      const data = await API.post("/api/scan", { path });
      state.playlist = data.files.slice();
      savePlaylistLocal();
      await refreshPlaylistView();
      setTab("lib");
      UI.toast("扫描到视频 " + data.count + " 个");
    } catch (e) {
      UI.alert(e.message);
    }
  }

  /* ------------------------------------------------------------ playlist */

  function savePlaylistLocal() {
    localStorage.setItem("mw/playlist", JSON.stringify(state.playlist));
  }

  async function addFilesToPlaylist(paths) {
    const existing = new Set(state.playlist);
    let changed = false;
    for (const path of paths || []) {
      if (!path || existing.has(path)) continue;
      existing.add(path);
      state.playlist.push(path);
      changed = true;
    }
    if (changed) {
      savePlaylistLocal();
      await refreshPlaylistView();
    }
  }

  async function refreshPlaylistView() {
    if (!state.playlist.length) {
      state.visiblePaths = [];
      state.playlistInfo = {};
      renderPlaylist();
      return;
    }
    try {
      const info = await API.post("/api/files/info", { paths: state.playlist });
      state.playlistInfo = {};
      info.items.forEach((item) => {
        state.playlistInfo[item.path] = item;
      });
      if (state.activeTagIds.length) {
        const filtered = await API.post("/api/playlist/filter", {
          paths: state.playlist,
          tag_ids: state.activeTagIds,
          match_all: state.tagMatchAll,
        });
        state.visiblePaths = filtered.items;
      } else {
        state.visiblePaths = state.playlist.slice();
      }
      renderPlaylist();
    } catch (e) {
      UI.toast("播放列表刷新失败: " + e.message);
    }
  }

  function renderPlaylist() {
    const list = $("#playlistView");
    list.innerHTML = "";
    state.visiblePaths.forEach((path, index) => {
      const info = state.playlistInfo[path] || {};
      const tags = info.tags || [];
      let subtitle = tags.length ? "标签: " + tags.join(", ") : path;
      if (info.last_position_ms > 0) {
        subtitle += " · 上次进度 " + Fmt.time(info.last_position_ms);
      }
      const li = makeMediaItem({
        path,
        name: info.name || basename(path),
        subtitle,
        missing: info.exists === false,
        hasThumb: info.has_thumb,
      });
      li.dataset.index = index;
      list.appendChild(li);
    });
  }

  async function removeFromPlaylist(paths) {
    const remove = new Set(paths);
    state.playlist = state.playlist.filter((p) => !remove.has(p));
    savePlaylistLocal();
    await refreshPlaylistView();
  }

  async function cleanPlaylist() {
    try {
      const info = await API.post("/api/files/info", { paths: state.playlist });
      const existing = new Set(info.items.filter((i) => i.exists).map((i) => i.path));
      state.playlist = state.playlist.filter((p) => existing.has(p));
      savePlaylistLocal();
      await refreshPlaylistView();
      UI.toast("已移除失效项");
    } catch (e) {
      UI.alert(e.message);
    }
  }

  async function requestThumbs(paths) {
    const targets = (paths || []).filter(Boolean);
    if (!targets.length) {
      UI.alert("没有可生成缩略图的项目");
      return;
    }
    try {
      const res = await API.post("/api/thumbs", { paths: targets });
      UI.toast("已加入缩略图队列（" + res.queued + " 个）");
    } catch (e) {
      UI.alert(e.message);
    }
    await refreshPlaylistView();
  }

  /* ------------------------------------------------------------ tags */

  async function refreshTagFilter() {
    try {
      const data = await API.get("/api/tags");
      state.tags = data.items;
    } catch (e) {
      state.tags = [];
    }
    const select = $("#tagFilter");
    const current = select.value;
    select.innerHTML = "";
    const all = document.createElement("option");
    all.value = "";
    all.textContent = "全部（当前列表）";
    select.appendChild(all);
    for (const tag of state.tags) {
      const option = document.createElement("option");
      option.value = tag.id;
      option.textContent = tag.name;
      select.appendChild(option);
    }
    const valid = new Set(state.tags.map((t) => t.id));
    state.activeTagIds = state.activeTagIds.filter((id) => valid.has(id));
    if (current && valid.has(Number(current))) select.value = current;
    else select.value = "";
    updateTagMultiButton();
  }

  function updateTagMultiButton() {
    $("#tagMulti").textContent =
      state.activeTagIds.length > 1 ? "多标签(" + state.activeTagIds.length + ")" : "多标签";
  }

  async function editTags(paths) {
    paths = (paths || []).filter(Boolean);
    if (!paths.length) return;
    let data;
    try {
      data = await API.post("/api/files/tags/common", { paths });
    } catch (e) {
      UI.alert(e.message);
      return;
    }
    const counts = data.counts || {};
    const batch = paths.length > 1;
    const infos = [];
    const body = document.createElement("div");
    if (batch) {
      const hint = document.createElement("div");
      hint.className = "modal-label";
      hint.textContent =
        "批量编辑（" + paths.length + " 个文件）：勾选 = 添加到所有文件；取消勾选 = 从所有文件移除（仅对全部文件共有的标签生效）";
      body.appendChild(hint);
    }
    const listWrap = document.createElement("div");
    listWrap.className = "check-list";
    const addRow = (name, color, checked, count) => {
      const row = document.createElement("label");
      row.className = "check-row";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = checked;
      cb.dataset.name = name;
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.style.background = color || "#5c636e";
      const label = document.createElement("span");
      label.textContent = name;
      row.append(cb, dot, label);
      if (batch && count !== undefined) {
        const counter = document.createElement("span");
        counter.className = "count";
        counter.textContent = count + "/" + paths.length;
        row.appendChild(counter);
      }
      listWrap.appendChild(row);
      infos.push({ name, cb });
    };
    for (const tag of data.tags || []) {
      const count = counts[tag.name] || 0;
      const checked = batch ? count === paths.length : count > 0;
      addRow(tag.name, tag.color, checked, count);
    }
    body.appendChild(listWrap);
    const newInput = document.createElement("input");
    newInput.placeholder = "输入新标签后回车";
    newInput.style.marginTop = "8px";
    body.appendChild(newInput);
    newInput.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const name = newInput.value.trim();
      if (!name) return;
      const found = infos.find((i) => i.name.toLowerCase() === name.toLowerCase());
      if (found) found.cb.checked = true;
      else addRow(name, "#3d8bfd", true, batch ? 0 : undefined);
      newInput.value = "";
    });

    UI.openModal({
      title: batch ? "批量编辑标签（" + paths.length + " 个文件）" : "编辑标签 - " + basename(paths[0]),
      body,
      width: 460,
      footer: [
        { label: "取消" },
        {
          label: "确定",
          primary: true,
          onClick: async () => {
            const checked = infos.filter((i) => i.cb.checked).map((i) => i.name);
            try {
              if (batch) {
                await API.post("/api/files/tags/batch", { paths: paths, tags: checked });
              } else {
                await API.put("/api/files/tags", { path: paths[0], tags: checked });
              }
              await refreshTagFilter();
              await refreshPlaylistView();
              if (state.detailPath) showDetailsFor(state.detailPath);
              UI.toast("标签已保存");
            } catch (e) {
              UI.alert(e.message);
            }
          },
        },
      ],
    });
  }

  async function multiTagFilter() {
    let data;
    try {
      data = await API.get("/api/tags");
    } catch (e) {
      UI.alert(e.message);
      return;
    }
    const body = document.createElement("div");
    const listWrap = document.createElement("div");
    listWrap.className = "check-list";
    const checkboxes = new Map();
    for (const tag of data.items) {
      const row = document.createElement("label");
      row.className = "check-row";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = state.activeTagIds.includes(tag.id);
      checkboxes.set(tag.id, cb);
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.style.background = tag.color || "#5c636e";
      const label = document.createElement("span");
      label.textContent = tag.name;
      row.append(cb, dot, label);
      listWrap.appendChild(row);
    }
    body.appendChild(listWrap);
    const radios = document.createElement("div");
    radios.className = "radio-row";
    const anyRadio = document.createElement("input");
    anyRadio.type = "radio";
    anyRadio.name = "tagMatch";
    anyRadio.checked = !state.tagMatchAll;
    const allRadio = document.createElement("input");
    allRadio.type = "radio";
    allRadio.name = "tagMatch";
    allRadio.checked = state.tagMatchAll;
    const anyLabel = document.createElement("label");
    anyLabel.append(anyRadio, document.createTextNode("匹配任一标签"));
    const allLabel = document.createElement("label");
    allLabel.append(allRadio, document.createTextNode("匹配全部标签"));
    radios.append(anyLabel, allLabel);
    body.appendChild(radios);
    UI.openModal({
      title: "多标签筛选",
      body,
      width: 360,
      footer: [
        { label: "取消" },
        {
          label: "确定",
          primary: true,
          onClick: async () => {
            state.activeTagIds = Array.from(checkboxes.entries())
              .filter(([, cb]) => cb.checked)
              .map(([id]) => id);
            state.tagMatchAll = allRadio.checked;
            $("#tagFilter").value = "";
            updateTagMultiButton();
            await refreshPlaylistView();
          },
        },
      ],
    });
  }

  async function manageTags() {
    const body = document.createElement("div");
    const list = document.createElement("div");
    list.className = "check-list";
    list.style.minHeight = "220px";
    body.appendChild(list);
    let selectedId = null;
    const load = async () => {
      const data = await API.get("/api/tags");
      list.innerHTML = "";
      for (const tag of data.items) {
        const row = document.createElement("div");
        row.className = "check-row";
        row.dataset.id = tag.id;
        const dot = document.createElement("span");
        dot.className = "dot";
        dot.style.background = tag.color || "#5c636e";
        const name = document.createElement("span");
        name.textContent = tag.name;
        const count = document.createElement("span");
        count.className = "count";
        count.textContent = tag.file_count + " 个文件";
        row.append(dot, name, count);
        row.addEventListener("click", () => {
          selectedId = tag.id;
          $$(".check-row", list).forEach((r) => r.classList.toggle("selected", r === row));
        });
        list.appendChild(row);
      }
    };
    await load();
    const afterChange = async () => {
      await load();
      await refreshTagFilter();
      await refreshPlaylistView();
    };
    UI.openModal({
      title: "标签管理",
      body,
      width: 420,
      footer: [
        {
          label: "重命名",
          keepOpen: true,
          onClick: async () => {
            if (!selectedId) return;
            const name = await UI.prompt("新名称");
            if (!name) return;
            try {
              await API.put("/api/tags/" + selectedId, { name });
              await afterChange();
            } catch (e) {
              UI.alert(e.message);
            }
          },
        },
        {
          label: "颜色",
          keepOpen: true,
          onClick: () => {
            if (!selectedId) return;
            const input = document.createElement("input");
            input.type = "color";
            input.value = "#3d8bfd";
            input.style.position = "fixed";
            input.style.left = "-100px";
            document.body.appendChild(input);
            input.addEventListener("input", async () => {
              try {
                await API.put("/api/tags/" + selectedId, { color: input.value });
                await afterChange();
              } catch (e) {
                UI.alert(e.message);
              }
            });
            input.addEventListener("change", () => input.remove());
            input.click();
          },
        },
        {
          label: "删除",
          keepOpen: true,
          onClick: async () => {
            if (!selectedId) return;
            if (!(await UI.confirm("确定删除该标签吗？所有文件上的该标签都会被移除。"))) return;
            try {
              await API.del("/api/tags/" + selectedId);
              selectedId = null;
              await afterChange();
            } catch (e) {
              UI.alert(e.message);
            }
          },
        },
        { label: "关闭", primary: true },
      ],
    });
  }

  /* ------------------------------------------------------------ detail */

  async function showDetailsFor(path) {
    state.detailPath = path || "";
    const content = $("#detailContent");
    if (!path) {
      content.innerHTML = "<p style='color:#9aa3af'>未选择文件</p>";
      return;
    }
    let data;
    try {
      data = await API.get("/api/files/detail", { path });
    } catch (e) {
      content.innerHTML = "<p style='color:#9aa3af'>" + Fmt.escape(e.message) + "</p>";
      return;
    }
    const record = data.record;
    let html = "";
    if (data.thumbnail) {
      html += "<div class='detail-thumb'><img src='" + API.thumbUrl(data.path) + "' alt=''></div>";
    }
    html += "<h3>" + Fmt.escape(data.name) + "</h3><table>";
    const row = (key, value) => {
      html += "<tr><td>" + key + "</td><td>" + value + "</td></tr>";
    };
    row("路径", Fmt.escape(data.path));
    row("大小", Fmt.bytes(data.size));
    row("修改时间", Fmt.dateTime(data.mtime));
    if (record) {
      if (record.duration_ms > 0) row("时长", Fmt.time(record.duration_ms));
      if (record.width > 0 && record.height > 0) row("分辨率", record.width + " × " + record.height);
      if (record.title) row("标题", Fmt.escape(record.title));
      row("播放次数", record.play_count);
      row("上次播放", Fmt.relative(record.last_played_at));
      if (record.last_position_ms > 0) row("上次进度", Fmt.time(record.last_position_ms));
      const tags = (data.tags || [])
        .map(
          (t) =>
            "<span class='dot' style='background:" +
            Fmt.escape(t.color || "#5c636e") +
            "'></span>" +
            Fmt.escape(t.name)
        )
        .join(" ");
      row("标签", tags || "—");
      row("评论", data.comment_count + " 条");
    } else {
      row("媒体信息", "尚未播放，暂无记录");
    }
    html += "</table>";
    content.innerHTML = html;
  }

  function toggleDetail() {
    const panel = $("#detailPanel");
    const show = panel.classList.contains("hidden");
    panel.classList.toggle("hidden", !show);
    if (!show) return;
    const target =
      state.selectedPaths[0] || state.visiblePaths[0] || state.entries.find((e) => !e.isdir)?.path || "";
    showDetailsFor(target);
  }

  /* ------------------------------------------------------------ recent */

  async function refreshRecent() {
    let data;
    try {
      data = await API.get("/api/recent");
    } catch (e) {
      UI.toast(e.message);
      return;
    }
    state.recentItems = data.items;
    const list = $("#recentList");
    list.innerHTML = "";
    for (const item of data.items) {
      let subtitle = "播放 " + item.play_count + " 次 · " + Fmt.relative(item.last_played_at);
      if (item.last_position_ms > 0) subtitle += " · 上次进度 " + Fmt.time(item.last_position_ms);
      list.appendChild(
        makeMediaItem({
          path: item.path,
          name: item.name,
          subtitle,
          missing: !item.exists,
          hasThumb: item.has_thumb,
        })
      );
    }
  }

  /* ------------------------------------------------------------ search */

  async function doSearch() {
    const keyword = $("#searchInput").value.trim();
    const list = $("#searchList");
    list.innerHTML = "";
    if (!keyword) {
      $("#searchInfo").textContent = "输入关键字搜索文件名、标签和评论";
      return;
    }
    let data;
    try {
      data = await API.get("/api/search", { q: keyword });
    } catch (e) {
      UI.toast(e.message);
      return;
    }
    state.searchItems = data.items;
    for (const item of data.items) {
      const li = makeMediaItem({
        path: item.path,
        name: item.name,
        subtitle: item.reason,
        missing: !item.exists,
        hasThumb: item.has_thumb,
      });
      li.title = item.path + "\n匹配: " + item.reason;
      list.appendChild(li);
    }
    $("#searchInfo").textContent = "找到 " + data.items.length + " 个结果";
  }

  /* ------------------------------------------------------------ m3u */

  async function exportM3u() {
    if (!state.playlist.length) {
      UI.alert("播放列表为空");
      return;
    }
    const file = await UI.prompt("保存 m3u 到（服务器路径）", state.config.default_m3u || "playlist.m3u");
    if (!file) return;
    try {
      const res = await API.post("/api/playlist/save", { file, paths: state.playlist });
      UI.toast("已保存: " + res.file);
    } catch (e) {
      UI.alert(e.message);
    }
  }

  async function importM3u() {
    const file = await UI.prompt("m3u 文件路径", state.config.default_m3u || "");
    if (!file) return;
    try {
      const res = await API.post("/api/playlist/load", { file });
      await addFilesToPlaylist(res.paths);
      setTab("lib");
      UI.toast("已导入 " + res.paths.length + " 个路径");
    } catch (e) {
      UI.alert(e.message);
    }
  }

  /* ------------------------------------------------------------ about */

  function showAbout() {
    const shortcuts = [
      ["Space", "播放 / 暂停"],
      ["← / →", "快退 / 快进 5 秒"],
      ["↑ / ↓", "音量 ±5"],
      ["F", "全屏切换"],
      ["M", "静音"],
      ["L", "播放列表"],
      ["S", "字幕开关"],
      ["[ / ]", "字幕延迟 -/+ 100ms"],
      ["N", "添加评论"],
      ["Ctrl+L", "评论列表"],
      ["C", "截图"],
      ["A", "画面比例"],
      ["Ctrl+Q", "关闭播放器"],
    ];
    const rows = shortcuts.map((s) => "<tr><td>" + s[0] + "</td><td>" + s[1] + "</td></tr>").join("");
    const ffmpeg = state.config.ffmpeg
      ? "已检测到"
      : "未检测到（缩略图与媒体信息探测不可用）";
    const body =
      "<p>媒体播放器 Web 版 " +
      Fmt.escape(state.config.version || "") +
      "</p><p>数据目录：" +
      Fmt.escape(state.config.data_dir || "") +
      "<br>ffmpeg：" +
      ffmpeg +
      "<br>允许的根目录：" +
      Fmt.escape((state.config.roots || []).join("  ")) +
      "</p><h4>快捷键</h4><table>" +
      rows +
      "</table>";
    UI.openModal({ title: "关于", body, width: 460, footer: [{ label: "确定", primary: true }] });
  }

  /* ------------------------------------------------------------ events */

  function bindEvents() {
    $$("#tabs .tab").forEach((btn) => {
      btn.addEventListener("click", () => setTab(btn.dataset.tab));
    });

    $("#btnDetail").addEventListener("click", toggleDetail);
    $("#detailClose").addEventListener("click", () => $("#detailPanel").classList.add("hidden"));
    $("#btnExploreDir").addEventListener("click", () => state.path && explore(state.path));
    $("#btnAbout").addEventListener("click", showAbout);
    $("#btnThumbBatch").addEventListener("click", () => {
      const selected = state.selectedPaths.filter((p) => state.playlist.includes(p));
      requestThumbs(selected.length ? selected : state.visiblePaths);
    });

    $("#pathGo").addEventListener("click", () => browse($("#pathInput").value.trim()));
    $("#pathInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") browse($("#pathInput").value.trim());
    });
    $("#pathRefresh").addEventListener("click", () => browse(state.path));
    $("#pathFilter").addEventListener("input", () => {
      clearTimeout(filterTimer);
      filterTimer = setTimeout(() => browse(state.path), 250);
    });
    $("#onlyVideo").checked = state.onlyVideo;
    $("#onlyVideo").addEventListener("change", () => {
      state.onlyVideo = $("#onlyVideo").checked;
      localStorage.setItem("mw/onlyVideo", state.onlyVideo ? "true" : "false");
      browse(state.path);
    });
    $("#sortSelect").value = String(state.sort);
    $("#sortSelect").addEventListener("change", () => {
      state.sort = parseInt($("#sortSelect").value, 10) || 0;
      localStorage.setItem("mw/sort", String(state.sort));
      browse(state.path);
    });

    $("#libAddDir").addEventListener("click", async () => {
      const path = await UI.prompt("添加库目录（绝对路径）", state.path || "");
      if (path) addLibraryDir(path);
    });
    $("#libRemoveDir").addEventListener("click", removeLibraryDir);
    $("#libScan").addEventListener("click", () => {
      const selected = state.selectedPaths.find((p) => state.dirs.some((d) => d.path === p));
      if (!selected) {
        UI.alert("请先在路径库列表中选择目录");
        return;
      }
      scanDir(selected);
    });

    $("#fileList").addEventListener("click", (e) => {
      const li = e.target.closest("li.entry");
      if (!li) return;
      const paths = state.entries.map((x) => x.path);
      handleItemClick(e, $("#fileList"), paths, li);
      if (!e.ctrlKey && !e.shiftKey) showDetailsFor(li.dataset.path);
    });
    $("#fileList").addEventListener("dblclick", (e) => {
      const li = e.target.closest("li.entry");
      if (!li) return;
      if (li.dataset.isdir === "true") browse(li.dataset.path);
      else openVideosInDir(state.path, li.dataset.path);
    });
    $("#fileList").addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const li = e.target.closest("li.entry");
      if (!li) return;
      const path = li.dataset.path;
      if (li.dataset.isdir === "true") {
        showMenu(e.clientX, e.clientY, [
          { label: "进入文件夹", onClick: () => browse(path) },
          { label: "添加为库目录", onClick: () => addLibraryDir(path) },
          { label: "扫描入库", onClick: () => scanDir(path) },
          { label: "在资源管理器中显示", onClick: () => explore(path) },
          "-",
          { label: "刷新", onClick: () => browse(state.path) },
        ]);
        return;
      }
      const videoFiles = state.entries.filter((x) => x.is_video).map((x) => x.path);
      const selectedVideos = selectedOr(path).filter((p) => videoFiles.includes(p));
      showMenu(e.clientX, e.clientY, [
        {
          label: "播放",
          enabled: li.classList.contains("video"),
          onClick: () => openVideosInDir(state.path, path),
        },
        {
          label: "编辑标签...",
          enabled: selectedVideos.length > 0,
          onClick: () => editTags(selectedVideos),
        },
        { label: "查看详情", onClick: () => showDetailsFor(path) },
        { label: "生成缩略图", enabled: li.classList.contains("video"), onClick: () => requestThumbs([path]) },
        { label: "在资源管理器中显示", onClick: () => explore(path) },
        "-",
        { label: "刷新", onClick: () => browse(state.path) },
      ]);
    });

    $("#dirList").addEventListener("click", (e) => {
      const li = e.target.closest("li.entry");
      if (!li) return;
      handleItemClick(e, $("#dirList"), state.dirs.map((d) => d.path), li);
    });
    $("#dirList").addEventListener("dblclick", (e) => {
      const li = e.target.closest("li.entry");
      if (li) browse(li.dataset.path);
    });
    $("#dirList").addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const li = e.target.closest("li.entry");
      if (!li) return;
      const path = li.dataset.path;
      showMenu(e.clientX, e.clientY, [
        { label: "进入", onClick: () => browse(path) },
        { label: "扫描入库", onClick: () => scanDir(path) },
        { label: "移除", onClick: removeLibraryDir },
        { label: "在资源管理器中显示", onClick: () => explore(path) },
      ]);
    });

    $("#playlistView").addEventListener("click", (e) => {
      const li = e.target.closest("li.media-item");
      if (!li) return;
      handleItemClick(e, $("#playlistView"), state.visiblePaths, li);
      if (!e.ctrlKey && !e.shiftKey) showDetailsFor(li.dataset.path);
    });
    $("#playlistView").addEventListener("dblclick", (e) => {
      const li = e.target.closest("li.media-item");
      if (!li) return;
      const index = parseInt(li.dataset.index, 10);
      if (state.visiblePaths.length) Player.open(state.visiblePaths, index);
    });
    $("#playlistView").addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const li = e.target.closest("li.media-item");
      if (!li) return;
      const path = li.dataset.path;
      const selected = selectedOr(path);
      showMenu(e.clientX, e.clientY, [
        { label: "播放", onClick: () => Player.open(state.visiblePaths, parseInt(li.dataset.index, 10)) },
        { label: "编辑标签...", enabled: selected.length > 0, onClick: () => editTags(selected) },
        { label: "查看详情", onClick: () => showDetailsFor(path) },
        { label: "生成缩略图", enabled: selected.length > 0, onClick: () => requestThumbs(selected) },
        { label: "从列表移除", enabled: selected.length > 0, onClick: () => removeFromPlaylist(selected) },
        { label: "清空列表", enabled: state.playlist.length > 0, onClick: async () => {
            if (!(await UI.confirm("确定清空播放列表吗？"))) return;
            state.playlist = [];
            savePlaylistLocal();
            await refreshPlaylistView();
          } },
        { label: "移除失效项", enabled: state.playlist.length > 0, onClick: cleanPlaylist },
        "-",
        { label: "导出 m3u", onClick: exportM3u },
        { label: "导入 m3u", onClick: importM3u },
        { label: "在资源管理器中显示", onClick: () => explore(path) },
      ]);
    });

    $("#recentList").addEventListener("click", (e) => {
      const li = e.target.closest("li.media-item");
      if (!li) return;
      handleItemClick(e, $("#recentList"), state.recentItems.map((i) => i.path), li);
      if (!e.ctrlKey && !e.shiftKey) showDetailsFor(li.dataset.path);
    });
    $("#recentList").addEventListener("dblclick", (e) => {
      const li = e.target.closest("li.media-item");
      if (!li) return;
      const files = state.recentItems.filter((i) => i.exists).map((i) => i.path);
      if (!files.length) return;
      let index = files.indexOf(li.dataset.path);
      if (index < 0) index = 0;
      Player.open(files, index);
    });
    $("#recentList").addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const li = e.target.closest("li.media-item");
      if (!li) return;
      showMenu(e.clientX, e.clientY, [
        {
          label: "播放",
          onClick: () => {
            const files = state.recentItems.filter((i) => i.exists).map((i) => i.path);
            let index = files.indexOf(li.dataset.path);
            if (index < 0) index = 0;
            Player.open(files, index);
          },
        },
        { label: "查看详情", onClick: () => showDetailsFor(li.dataset.path) },
        { label: "在资源管理器中显示", onClick: () => explore(li.dataset.path) },
      ]);
    });

    $("#searchList").addEventListener("click", (e) => {
      const li = e.target.closest("li.media-item");
      if (!li) return;
      handleItemClick(e, $("#searchList"), state.searchItems.map((i) => i.path), li);
      if (!e.ctrlKey && !e.shiftKey) showDetailsFor(li.dataset.path);
    });
    $("#searchList").addEventListener("dblclick", (e) => {
      const li = e.target.closest("li.media-item");
      if (!li) return;
      const files = state.searchItems.filter((i) => i.exists).map((i) => i.path);
      if (!files.length) return;
      let index = files.indexOf(li.dataset.path);
      if (index < 0) index = 0;
      Player.open(files, index);
    });
    $("#searchList").addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const li = e.target.closest("li.media-item");
      if (!li) return;
      const path = li.dataset.path;
      showMenu(e.clientX, e.clientY, [
        {
          label: "播放",
          enabled: state.searchItems.some((i) => i.path === path && i.exists),
          onClick: () => {
            const files = state.searchItems.filter((i) => i.exists).map((i) => i.path);
            let index = files.indexOf(path);
            if (index < 0) index = 0;
            Player.open(files, index);
          },
        },
        { label: "编辑标签...", onClick: () => editTags([path]) },
        { label: "查看详情", onClick: () => showDetailsFor(path) },
        { label: "生成缩略图", onClick: () => requestThumbs([path]) },
        { label: "在资源管理器中显示", onClick: () => explore(path) },
      ]);
    });

    $("#plScanDir").addEventListener("click", async () => {
      const selected = state.selectedPaths.find((p) => state.dirs.some((d) => d.path === p));
      if (selected) return scanDir(selected);
      const path = await UI.prompt("扫描目录（绝对路径）", state.path || "");
      if (path) scanDir(path);
    });
    $("#plImport").addEventListener("click", importM3u);
    $("#plExport").addEventListener("click", exportM3u);
    $("#plThumb").addEventListener("click", () => {
      const selected = state.selectedPaths.filter((p) => state.playlist.includes(p));
      requestThumbs(selected.length ? selected : state.visiblePaths);
    });
    $("#plClean").addEventListener("click", cleanPlaylist);
    $("#plClear").addEventListener("click", async () => {
      if (!state.playlist.length) return;
      if (!(await UI.confirm("确定清空播放列表吗？"))) return;
      state.playlist = [];
      savePlaylistLocal();
      await refreshPlaylistView();
    });
    $("#tagFilter").addEventListener("change", async () => {
      const value = $("#tagFilter").value;
      state.activeTagIds = value ? [Number(value)] : [];
      state.tagMatchAll = false;
      updateTagMultiButton();
      await refreshPlaylistView();
    });
    $("#tagMulti").addEventListener("click", multiTagFilter);
    $("#tagManage").addEventListener("click", manageTags);

    $("#recentRefresh").addEventListener("click", refreshRecent);
    $("#recentClear").addEventListener("click", async () => {
      if (!(await UI.confirm("确定清空最近播放记录吗？"))) return;
      try {
        await API.post("/api/recent/clear");
        await refreshRecent();
      } catch (e) {
        UI.alert(e.message);
      }
    });

    $("#searchGo").addEventListener("click", doSearch);
    $("#searchInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") doSearch();
    });
  }

  /* ------------------------------------------------------------ init */

  async function init() {
    try {
      state.config = await API.get("/api/config");
    } catch (e) {
      state.config = {};
    }
    if (!state.config.ffmpeg) {
      const banner = $("#ffmpegBanner");
      banner.textContent =
        "未检测到 ffmpeg：缩略图与媒体信息探测不可用（不影响播放与媒体库）。可在 config.json 的 ffmpeg/ffprobe 字段填写可执行文件路径。";
      banner.classList.remove("hidden");
    }
    bindEvents();
    await refreshTagFilter();
    await loadLibraryDirs();
    await browse(state.path);
    await refreshPlaylistView();
    setTab("path");
  }

  window.APP = {
    get visiblePaths() {
      return state.visiblePaths;
    },
    onPlayerClosed() {
      refreshPlaylistView();
      if (state.tab === "recent") refreshRecent();
    },
    refreshPlaylistView,
  };

  document.addEventListener("DOMContentLoaded", init);
})();
