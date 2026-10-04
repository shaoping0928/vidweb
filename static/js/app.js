(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const state = {
    tab: "path",
    path: "",
    onlyVideo: false,
    sort: 0,
    dirs: [],
    entries: [],
    playlist: [],
    playlistInfo: {},
    visiblePaths: [],
    playlistTotal: 0,
    playlistFiltered: 0,
    playlistOffset: 0,
    playlistLoading: false,
    libFilters: loadLibFilters(),
    tags: [],
    tagSubtrees: new Map(),
    tagExpanded: {},
    config: {},
    detailPath: "",
    searchItems: [],
    recentItems: [],
    selectedPaths: [],
    lastSelIndex: -1,
    selListEl: null,
    serverSettings: null,
    settingRoots: [],
    roots: [],
    parent: "",
    pages: { fileList: 1, playlist: 1, recent: 1, search: 1, tasks: 1 },
    taskItems: [],
  };

  const PAGE_SIZES = [10, 20, 30, 50, 100];

  function pageSize() {
    const value = parseInt(Prefs.get("mw/pageSize", "30"), 10);
    return PAGE_SIZES.includes(value) ? value : 30;
  }

  function setPageSize(value) {
    Prefs.set("mw/pageSize", value);
  }

  function paginate(total, page, size) {
    const totalPages = Math.max(1, Math.ceil(total / size));
    const current = Math.min(Math.max(1, page || 1), totalPages);
    return { start: (current - 1) * size, page: current, totalPages };
  }

  function renderPager(selector, key, total, rerender, serverMode) {
    const box = $(selector);
    if (!box) return;
    box.innerHTML = "";
    if (!total) return;
    const size = pageSize();
    let page;
    let totalPages;
    if (serverMode) {
      totalPages = Math.max(1, Math.ceil(total / size));
      page = Math.min(Math.max(1, state.pages[key] || 1), totalPages);
      state.pages[key] = page;
    } else {
      const info = paginate(total, state.pages[key], size);
      page = info.page;
      totalPages = info.totalPages;
      state.pages[key] = page;
    }
    const info = document.createElement("span");
    info.className = "pager-info";
    info.textContent = "共 " + total + " 条";
    const prev = document.createElement("button");
    prev.textContent = "上一页";
    prev.disabled = page <= 1;
    prev.addEventListener("click", () => {
      state.pages[key] = page - 1;
      rerender();
    });
    const label = document.createElement("span");
    label.textContent = page + " / " + totalPages;
    const next = document.createElement("button");
    next.textContent = "下一页";
    next.disabled = page >= totalPages;
    next.addEventListener("click", () => {
      state.pages[key] = page + 1;
      rerender();
    });
    const sizeSelect = document.createElement("select");
    for (const value of PAGE_SIZES) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value + " / 页";
      if (value === size) option.selected = true;
      sizeSelect.appendChild(option);
    }
    sizeSelect.addEventListener("change", () => {
      setPageSize(Number(sizeSelect.value));
      state.pages.fileList = 1;
      state.pages.playlist = 1;
      state.pages.recent = 1;
      state.pages.search = 1;
      rerenderAllLists();
    });
    box.append(info, prev, label, next, sizeSelect);
  }

  function rerenderAllLists() {
    renderFileList();
    refreshPlaylistView();
    renderRecentList();
    renderSearchList();
    if (window.Player && window.Player.renderPlaylistPanel) window.Player.renderPlaylistPanel();
  }

  function initSplitters() {
    $$(".splitter").forEach((splitter) => {
      const target = document.getElementById(splitter.dataset.resizeTarget);
      if (!target) return;
      const min = Number(splitter.dataset.min || 140);
      const max = Number(splitter.dataset.max || 640);
      const invert = splitter.dataset.invert === "true";
      const key = "mw/split/" + splitter.dataset.resizeTarget;
      const saved = parseInt(Prefs.get(key, "0"), 10);
      if (saved >= min && saved <= max) target.style.width = saved + "px";
      let dragging = false;
      let startX = 0;
      let startWidth = 0;
      splitter.addEventListener("pointerdown", (e) => {
        dragging = true;
        startX = e.clientX;
        startWidth = target.getBoundingClientRect().width;
        splitter.classList.add("dragging");
        try {
          splitter.setPointerCapture(e.pointerId);
        } catch (err) {}
        e.preventDefault();
      });
      splitter.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        const delta = e.clientX - startX;
        const width = Math.min(max, Math.max(min, startWidth + (invert ? -delta : delta)));
        target.style.width = width + "px";
        e.preventDefault();
      });
      const finish = (e) => {
        if (!dragging) return;
        dragging = false;
        splitter.classList.remove("dragging");
        try {
          splitter.releasePointerCapture(e.pointerId);
        } catch (err) {}
        Prefs.set(key, Math.round(target.getBoundingClientRect().width));
        if (target.id === "playerPanel" && window.Player && window.Player.resetDanmaku) {
          window.Player.resetDanmaku();
        }
      };
      splitter.addEventListener("pointerup", finish);
      splitter.addEventListener("pointercancel", finish);
      splitter.addEventListener("dblclick", () => {
        target.style.width = "";
        Prefs.remove(key);
      });
    });
  }

  function basename(path) {
    return String(path || "").split(/[\\/]/).pop() || "";
  }

  function pathKey(path) {
    return String(path || "")
      .replace(/\//g, "\\")
      .replace(/\\+$/, "")
      .toLowerCase();
  }

  function buildTagTree(tags) {
    const byId = new Map();
    for (const tag of tags || []) byId.set(tag.id, Object.assign({}, tag, { children: [] }));
    const roots = [];
    for (const node of byId.values()) {
      const parent = node.parent_id ? byId.get(node.parent_id) : null;
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    const sortNodes = (list) => {
      list.sort((a, b) => collator.compare(a.name, b.name));
      list.forEach((node) => sortNodes(node.children));
    };
    sortNodes(roots);
    return roots;
  }

  function computeTagSubtrees(tags) {
    const children = new Map();
    for (const tag of tags || []) {
      const key = tag.parent_id || 0;
      if (!children.has(key)) children.set(key, []);
      children.get(key).push(tag.id);
    }
    const result = new Map();
    for (const tag of tags || []) {
      const set = new Set();
      const stack = [tag.id];
      while (stack.length) {
        const current = stack.pop();
        if (set.has(current)) continue;
        set.add(current);
        for (const child of children.get(current) || []) stack.push(child);
      }
      result.set(tag.id, set);
    }
    return result;
  }

  function tagDepthList(tags) {
    const out = [];
    const walk = (nodes, depth) => {
      for (const node of nodes) {
        out.push({ tag: node, depth });
        walk(node.children, depth + 1);
      }
    };
    walk(buildTagTree(tags), 0);
    return out;
  }

  function saveTagExpanded() {
    Prefs.setJSON("mw/tagExpanded", state.tagExpanded);
  }

  function applyPrefs() {
    state.path = Prefs.get("mw/lastPath", "");
    state.onlyVideo = Prefs.get("mw/onlyVideo", "false") === "true";
    state.sort = parseInt(Prefs.get("mw/sort", "0"), 10) || 0;
    state.libFilters = loadLibFilters();
    state.tagExpanded = Prefs.getJSON("mw/tagExpanded", {});
  }

  function loadLibFilters() {
    const defaults = {
      search: "",
      status: "all",
      duration: "all",
      sort: "name",
      tagMode: "any",
      tagNames: [],
    };
    const saved = Prefs.getJSON("mw/libFilters", {});
    return Object.assign(defaults, saved || {});
  }

  function saveLibFilters() {
    Prefs.setJSON("mw/libFilters", state.libFilters);
  }

  function restoreLibFilterUI() {
    $("#plSearch").value = state.libFilters.search || "";
    $("#plSort").value = state.libFilters.sort || "name";
    const status = document.querySelector(
      'input[name="plStatus"][value="' + (state.libFilters.status || "all") + '"]'
    );
    if (status) status.checked = true;
    const duration = document.querySelector(
      'input[name="plDuration"][value="' + (state.libFilters.duration || "all") + '"]'
    );
    if (duration) duration.checked = true;
    const mode = document.querySelector(
      'input[name="plTagMode"][value="' + (state.libFilters.tagMode || "any") + '"]'
    );
    if (mode) mode.checked = true;
  }

  function setStatus(text) {
    $("#statusText").textContent = text || "";
  }

  function setTab(name) {
    state.tab = name;
    $$("#tabs .tab").forEach((btn) => btn.classList.toggle("active", btn.dataset.tab === name));
    $$(".page").forEach((page) => page.classList.toggle("active", page.id === "page-" + name));
    if (name === "tags") renderTagManagePage();
    if (name === "tasks") renderTasksPage();
    if (name === "settings") loadSettings();
    if (name === "player") setDetailVisible(false);
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

  /* ------------------------------------------------------------ drives */

  async function loadDrives() {
    try {
      const data = await API.get("/api/drives");
      state.roots = data.roots || [];
    } catch (e) {
      state.roots = [];
    }
    renderDriveSelect();
  }

  function renderDriveSelect() {
    const select = $("#driveSelect");
    select.innerHTML = "";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "选择驱动器";
    select.appendChild(placeholder);
    for (const root of state.roots) {
      const option = document.createElement("option");
      option.value = root.path;
      option.textContent = root.total
        ? root.path + "（可用 " + Fmt.bytes(root.free) + "）"
        : root.path;
      select.appendChild(option);
    }
    syncDriveSelect(state.path);
    updatePathUp();
  }

  function syncDriveSelect(path) {
    const select = $("#driveSelect");
    if (!path) {
      select.value = "";
      return;
    }
    const lower = path.toLowerCase();
    let best = "";
    for (const root of state.roots) {
      const base = root.path.toLowerCase().replace(/[\\/]+$/, "");
      if (lower === base || lower.startsWith(base + "\\") || lower.startsWith(base + "/")) {
        if (root.path.length > best.length) best = root.path;
      }
    }
    select.value = best;
  }

  function samePath(a, b) {
    const norm = (value) => String(value || "").replace(/[\\/]+$/, "").toLowerCase();
    return norm(a) === norm(b) && norm(a) !== "";
  }

  function updatePathUp() {
    const atRoot =
      state.roots.some((root) => samePath(root.path, state.path)) ||
      samePath(state.path, state.parent);
    $("#pathUp").disabled = atRoot || !state.parent;
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
      state.parent = data.parent || "";
      state.entries = data.entries;
      state.pages.fileList = 1;
      $("#pathInput").value = data.path;
      syncDriveSelect(data.path);
      updatePathUp();
      Prefs.set("mw/lastPath", data.path);
      renderFileList();
    } catch (e) {
      UI.toast("打开目录失败: " + e.message);
    }
  }

  function renderFileList() {
    const list = $("#fileList");
    list.innerHTML = "";
    if (!state.entries.length) {
      list.appendChild(makeEmptyHint("此目录没有可显示的文件"));
      renderPager("#fileListPager", "fileList", 0, renderFileList);
      return;
    }
    const size = pageSize();
    const { start } = paginate(state.entries.length, state.pages.fileList, size);
    state.pages.fileList = paginate(state.entries.length, state.pages.fileList, size).page;
    for (const entry of state.entries.slice(start, start + size)) {
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
    renderPager("#fileListPager", "fileList", state.entries.length, renderFileList);
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
      const data = await API.get("/api/dirs");
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
      li.dataset.id = item.id;
      li.title = item.path + (item.exists ? "" : "\n目录不存在") + "\n右键可编辑路径 / 扫描入库";
      const name = document.createElement("span");
      name.className = "entry-name";
      name.textContent = item.path;
      li.appendChild(name);
      list.appendChild(li);
    }
  }

  async function addLibraryDir(path) {
    try {
      const data = await API.post("/api/dirs", { path });
      state.dirs = data.items;
      renderDirList();
    } catch (e) {
      UI.alert(e.message);
    }
  }

  function selectedDir() {
    for (const path of state.selectedPaths) {
      const found = state.dirs.find((d) => d.path === path);
      if (found) return found;
    }
    return null;
  }

  async function removeLibraryDir() {
    const target = selectedDir();
    if (!target) {
      UI.alert("请先在路径库列表中选择要移除的目录");
      return;
    }
    if (!(await UI.confirm("确定从路径库移除「" + target.path + "」吗？已入库的文件会保留。"))) return;
    try {
      const data = await API.del("/api/dirs/" + target.id);
      state.dirs = data.items;
      renderDirList();
    } catch (e) {
      UI.alert(e.message);
    }
  }

  async function editLibraryDir(dirId, currentPath) {
    const value = await UI.prompt(
      "编辑目录绝对路径（可用于文件迁移后重新指向）",
      currentPath
    );
    if (!value || !value.trim()) return;
    try {
      const data = await API.put("/api/dirs/" + dirId, { path: value.trim() });
      state.dirs = data.items;
      renderDirList();
      await refreshPlaylistView();
      UI.toast("目录已更新，同步文件 " + data.moved_files + " 个");
    } catch (e) {
      UI.alert(e.message);
    }
  }

  async function startScan(body, titlePath) {
    let jobId;
    try {
      const res = await API.post("/api/scan", body);
      jobId = res.job_id;
    } catch (e) {
      UI.alert(e.message);
      return;
    }
    Tasks.run({
      title: "扫描入库：" + basename(titlePath),
      tooltip: titlePath,
      poll: async () => {
        const st = await API.get("/api/scan/status", { job_id: jobId });
        if (st.state === "walking") {
          return { state: "running", percent: null, text: "正在遍历目录..." };
        }
        if (st.state === "importing") {
          return {
            state: "running",
            percent: st.total ? (st.processed / st.total) * 100 : 0,
            text: "已入库 " + st.processed + "/" + st.total + "（新增 " + st.added + "）",
          };
        }
        if (st.state === "done") {
          return { state: "done", percent: 100, text: "正在加入列表..." };
        }
        if (st.state === "cancelled") {
          return { state: "cancelled", percent: 100, text: "已取消" };
        }
        return { state: "error", percent: null, text: "失败：" + (st.error || "未知错误") };
      },
      onFinish: async (status) => {
        if (status.state !== "done") return null;
        const full = await API.get("/api/scan/status", { job_id: jobId });
        const addedToPlaylist = full.playlist_added || 0;
        if (addedToPlaylist) {
          await refreshPlaylistView(true);
          setTab("lib");
        }
        if (state.tab === "tasks") renderTasksPage();
        const message =
          "完成：共 " + full.total + " 个，新增入库 " + full.added + " 个，加入列表 " + addedToPlaylist + " 个";
        UI.toast(message);
        return message;
      },
      onCancel: () => API.post("/api/scan/cancel", { job_id: jobId }).catch(() => {}),
    });
  }

  function scanDirPath(path) {
    if (!path) {
      UI.alert("请先在路径库列表中选择目录");
      return;
    }
    startScan({ path: path }, path);
  }

  function scanDirId(dir) {
    if (!dir || !dir.id) {
      UI.alert("请先在路径库列表中选择目录");
      return;
    }
    startScan({ dir_id: dir.id }, dir.path);
  }

  /* ------------------------------------------------------------ tasks page */

  const TASK_STATES = {
    walking: { label: "遍历中", cls: "running" },
    importing: { label: "入库中", cls: "running" },
    done: { label: "完成", cls: "done" },
    error: { label: "失败", cls: "error" },
    cancelled: { label: "已取消", cls: "" },
  };

  let tasksTimer = null;

  async function renderTasksPage() {
    let data;
    try {
      data = await API.get("/api/tasks");
    } catch (e) {
      UI.toast(e.message);
      return;
    }
    state.taskItems = data.items || [];
    renderTaskList();
    clearTimeout(tasksTimer);
    if (state.taskItems.some((t) => t.state === "walking" || t.state === "importing")) {
      tasksTimer = setTimeout(() => {
        if (state.tab === "tasks") renderTasksPage();
      }, 2000);
    }
  }

  function formatTaskDuration(task) {
    const end = task.finished_at || Math.floor(Date.now() / 1000);
    const seconds = Math.max(0, end - (task.created_at || end));
    if (seconds < 60) return seconds + "s";
    const minutes = Math.floor(seconds / 60);
    return minutes + "m " + (seconds % 60) + "s";
  }

  function makeTaskRow(task) {
    const li = document.createElement("li");
    li.className = "task-hist";
    const top = document.createElement("div");
    top.className = "task-hist-top";
    const running = task.state === "walking" || task.state === "importing";
    const stateInfo = TASK_STATES[task.state] || { label: task.state || "-", cls: "" };
    const name = document.createElement("span");
    name.className = "task-hist-name";
    name.textContent = task.name || task.type || "任务";
    const badge = document.createElement("span");
    badge.className = "state-badge " + stateInfo.cls;
    badge.textContent = stateInfo.label;
    const time = document.createElement("span");
    time.className = "task-hist-time";
    time.textContent =
      Fmt.dateTime(task.created_at) + " · " + (running ? "进行中 " + formatTaskDuration(task) : formatTaskDuration(task));
    const ip = document.createElement("span");
    ip.className = "task-hist-ip";
    ip.textContent = task.ip || "-";
    const del = document.createElement("button");
    del.className = "task-hist-del";
    del.textContent = "删除";
    del.addEventListener("click", async () => {
      try {
        await API.del("/api/tasks/" + task.id);
        await renderTasksPage();
      } catch (e) {
        UI.alert(e.message);
      }
    });
    top.append(name, badge, time, ip, del);

    const bottom = document.createElement("div");
    bottom.className = "task-hist-bottom";
    const mini = document.createElement("div");
    mini.className = "mini-bar" + (task.state === "walking" ? " indeterminate" : "");
    const fill = document.createElement("div");
    fill.className = "fill";
    const pct = task.total ? Math.round((task.processed / task.total) * 100) : task.state === "done" ? 100 : 0;
    fill.style.width = pct + "%";
    mini.appendChild(fill);
    const pctText = document.createElement("span");
    pctText.className = "task-hist-pct";
    pctText.textContent =
      task.state === "walking" ? "..." : task.state === "done" ? "100%" : pct + "%";
    const desc = document.createElement("span");
    desc.className = "task-hist-desc";
    let descText = task.description || "";
    if (task.error) descText += (descText ? " · " : "") + task.error;
    desc.textContent = descText;
    desc.title = descText;
    bottom.append(mini, pctText, desc);

    li.append(top, bottom);
    return li;
  }

  function renderTaskList() {
    const list = $("#taskList");
    if (!list) return;
    list.innerHTML = "";
    $("#tasksSummary").textContent = state.taskItems.length
      ? "共 " + state.taskItems.length + " 条任务"
      : "暂无任务";
    if (!state.taskItems.length) {
      list.appendChild(makeEmptyHint("暂无任务记录，扫描入库后这里会显示任务历史"));
      renderPager("#tasksPager", "tasks", 0, renderTaskList);
      return;
    }
    const size = pageSize();
    const { start } = paginate(state.taskItems.length, state.pages.tasks, size);
    state.pages.tasks = paginate(state.taskItems.length, state.pages.tasks, size).page;
    for (const task of state.taskItems.slice(start, start + size)) {
      list.appendChild(makeTaskRow(task));
    }
    renderPager("#tasksPager", "tasks", state.taskItems.length, renderTaskList);
  }

  /* ------------------------------------------------------------ playlist */

  async function loadServerPlaylist() {
    try {
      const data = await API.get("/api/playlist");
      const serverPaths = data.items || [];
      if (serverPaths.length) return;
      const localPaths = Prefs.getJSON("playlist", []);
      if (localPaths.length) {
        await API.put("/api/playlist", { paths: localPaths });
      }
    } catch (e) {}
  }

  function makeEmptyHint(text, actionLabel, action) {
    const li = document.createElement("li");
    li.className = "empty-hint";
    const label = document.createElement("div");
    label.textContent = text;
    li.appendChild(label);
    if (actionLabel && action) {
      const btn = document.createElement("button");
      btn.className = "primary";
      btn.textContent = actionLabel;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        action();
      });
      li.appendChild(btn);
    }
    return li;
  }

  async function restorePlaylistFromDb() {
    try {
      const res = await API.post("/api/playlist/restore");
      await refreshPlaylistView(true);
      UI.toast(
        res.added
          ? "已从媒体库恢复 " + res.added + " 个视频"
          : "媒体库视频已全部在播放列表中"
      );
    } catch (e) {
      UI.alert(e.message);
    }
  }

  function resetLibFilters() {
    state.libFilters = {
      search: "",
      status: "all",
      duration: "all",
      sort: "name",
      tagMode: "any",
      tagNames: [],
    };
    saveLibFilters();
    restoreLibFilterUI();
    renderLibTagList();
    refreshPlaylistView(true);
  }

  function selectedTagIds() {
    const nameToId = new Map(state.tags.map((t) => [t.name, t.id]));
    return (state.libFilters.tagNames || [])
      .map((name) => nameToId.get(name))
      .filter((id) => id !== undefined);
  }

  function playlistQueryBody(extra) {
    return Object.assign(
      {
        search: state.libFilters.search || "",
        status: state.libFilters.status || "all",
        duration: state.libFilters.duration || "all",
        tag_ids: selectedTagIds(),
        tag_match_all: state.libFilters.tagMode === "all",
        sort: state.libFilters.sort || "name",
      },
      extra || {}
    );
  }

  async function fetchFilteredPaths() {
    const data = await API.post(
      "/api/playlist/query",
      playlistQueryBody({ paths_only: true })
    );
    return data.paths || [];
  }

  async function addFilesToPlaylist(paths) {
    if (!paths || !paths.length) return 0;
    try {
      const res = await API.post("/api/playlist/add", { paths });
      if (res.added) await refreshPlaylistView();
      return res.added;
    } catch (e) {
      UI.alert(e.message);
      return 0;
    }
  }

  async function refreshPlaylistView(resetPage) {
    if (resetPage) state.pages.playlist = 1;
    const size = pageSize();
    state.playlistLoading = true;
    try {
      const data = await API.post(
        "/api/playlist/query",
        playlistQueryBody({
          offset: (state.pages.playlist - 1) * size,
          limit: size,
        })
      );
      state.playlistInfo = {};
      (data.items || []).forEach((item) => {
        state.playlistInfo[item.path] = item;
      });
      state.visiblePaths = (data.items || []).map((item) => item.path);
      state.playlistOffset = data.offset || 0;
      state.playlistTotal = data.total || 0;
      state.playlistFiltered = data.filtered || 0;
    } catch (e) {
      state.visiblePaths = [];
      state.playlistTotal = 0;
      state.playlistFiltered = 0;
      UI.toast("播放列表加载失败: " + e.message);
    } finally {
      state.playlistLoading = false;
    }
    renderPlaylist();
  }

  const collator = new Intl.Collator("zh-Hans-CN", { sensitivity: "base", numeric: true });

  function renderPlaylist() {
    const list = $("#playlistView");
    list.innerHTML = "";
    if (state.playlistLoading) {
      list.appendChild(makeEmptyHint("正在加载播放列表..."));
      return;
    }
    if (!state.playlistFiltered) {
      const filtered = state.playlistTotal > 0;
      list.appendChild(
        makeEmptyHint(
          filtered ? "当前筛选条件下没有视频" : "视频库为空",
          filtered ? "重置筛选" : "从媒体库恢复",
          filtered ? resetLibFilters : restorePlaylistFromDb
        )
      );
      renderPager("#playlistPager", "playlist", 0, refreshPlaylistView, true);
      return;
    }
    state.visiblePaths.forEach((path, offset) => {
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
      if (info.rel_path) {
        li.title =
          path +
          "\n相对路径: " +
          info.rel_path +
          (info.dir_path ? "\n目录: " + info.dir_path : "");
      }
      li.dataset.index = state.playlistOffset + offset;
      list.appendChild(li);
    });
    renderPager("#playlistPager", "playlist", state.playlistFiltered, refreshPlaylistView, true);
  }

  async function removeFromPlaylist(paths) {
    try {
      await API.post("/api/playlist/remove", { paths });
      await refreshPlaylistView();
    } catch (e) {
      UI.alert(e.message);
    }
  }

  async function cleanPlaylist() {
    try {
      const res = await API.post("/api/playlist/clean");
      await refreshPlaylistView();
      UI.toast("已移除失效项 " + res.removed + " 个");
    } catch (e) {
      UI.alert(e.message);
    }
  }

  async function clearPlaylist() {
    if (!(await UI.confirm("确定清空播放列表吗？"))) return;
    try {
      await API.del("/api/playlist");
      await refreshPlaylistView();
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
    state.tagSubtrees = computeTagSubtrees(state.tags);
    const valid = new Set(state.tags.map((t) => t.name));
    state.libFilters.tagNames = (state.libFilters.tagNames || []).filter((n) =>
      valid.has(n)
    );
    renderLibTagList();
  }

  function renderLibTagList() {
    const box = $("#plTagList");
    if (!box) return;
    box.innerHTML = "";
    $("#plTagEmpty").classList.toggle("hidden", state.tags.length > 0);
    const renderNode = (node, depth) => {
      const hasChildren = node.children.length > 0;
      const expanded = state.tagExpanded[node.id] !== false;
      const label = document.createElement("label");
      label.className = "check";
      label.style.paddingLeft = depth * 12 + "px";
      const caret = document.createElement("span");
      caret.className = "caret" + (hasChildren ? "" : " empty");
      caret.textContent = hasChildren ? (expanded ? "▾" : "▸") : "•";
      caret.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!hasChildren) return;
        state.tagExpanded[node.id] = !expanded;
        saveTagExpanded();
        renderLibTagList();
      });
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = state.libFilters.tagNames.includes(node.name);
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.style.background = node.color || "#5c636e";
      const name = document.createElement("span");
      name.textContent = node.name;
      const count = document.createElement("span");
      count.className = "count";
      count.textContent = hasChildren ? node.subtree_count : node.file_count;
      if (hasChildren) {
        count.title = "自身 " + node.file_count + " 个，含子标签共 " + node.subtree_count + " 个";
      }
      label.append(caret, checkbox, dot, name, count);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          if (!state.libFilters.tagNames.includes(node.name)) {
            state.libFilters.tagNames.push(node.name);
          }
        } else {
          state.libFilters.tagNames = state.libFilters.tagNames.filter(
            (n) => n !== node.name
          );
        }
        saveLibFilters();
        refreshPlaylistView(true);
      });
      box.appendChild(label);
      if (hasChildren && expanded) {
        node.children.forEach((child) => renderNode(child, depth + 1));
      }
    };
    buildTagTree(state.tags).forEach((root) => renderNode(root, 0));
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
    const addRow = (name, color, checked, count, depth) => {
      const row = document.createElement("label");
      row.className = "check-row";
      if (depth) row.style.paddingLeft = 6 + depth * 14 + "px";
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
    for (const entry of tagDepthList(data.tags || [])) {
      const tag = entry.tag;
      const count = counts[tag.name] || 0;
      const checked = batch ? count === paths.length : count > 0;
      addRow(tag.name, tag.color, checked, count, entry.depth);
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

  function renderTagParentSelect() {
    const select = $("#tagNewParent");
    if (!select) return;
    const current = select.value;
    select.innerHTML = "";
    const root = document.createElement("option");
    root.value = "";
    root.textContent = "顶层标签";
    select.appendChild(root);
    const walk = (nodes, depth) => {
      for (const node of nodes) {
        const option = document.createElement("option");
        option.value = node.id;
        option.textContent = "　".repeat(depth) + node.name;
        select.appendChild(option);
        walk(node.children, depth + 1);
      }
    };
    walk(buildTagTree(state.tags), 0);
    if (current && Array.from(select.options).some((o) => o.value === current)) {
      select.value = current;
    }
  }

  async function renderTagManagePage() {
    let data;
    try {
      data = await API.get("/api/tags");
    } catch (e) {
      UI.toast(e.message);
      return;
    }
    state.tags = data.items;
    state.tagSubtrees = computeTagSubtrees(state.tags);
    renderTagParentSelect();
    const list = $("#tagManageList");
    list.innerHTML = "";
    $("#tagSummary").textContent = data.items.length
      ? "共 " + data.items.length + " 个标签"
      : "暂无标签";
    if (!data.items.length) {
      const empty = document.createElement("li");
      empty.className = "label";
      empty.style.padding = "12px";
      empty.textContent = "还没有标签：可在上方新建，或在文件右键「编辑标签」中创建。";
      list.appendChild(empty);
      return;
    }
    const afterChange = async () => {
      await renderTagManagePage();
      await refreshTagFilter();
      await refreshPlaylistView();
    };
    const renderNode = (node, depth) => {
      const hasChildren = node.children.length > 0;
      const expanded = state.tagExpanded[node.id] !== false;
      const li = document.createElement("li");
      li.className = "tag-row";
      li.style.paddingLeft = 8 + depth * 16 + "px";
      const caret = document.createElement("span");
      caret.className = "caret" + (hasChildren ? "" : " empty");
      caret.textContent = hasChildren ? (expanded ? "▾" : "▸") : "•";
      caret.addEventListener("click", () => {
        if (!hasChildren) return;
        state.tagExpanded[node.id] = !expanded;
        saveTagExpanded();
        renderTagManagePage();
      });
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.style.background = node.color || "#5c636e";
      const name = document.createElement("span");
      name.className = "tag-name";
      name.textContent = node.name;
      const count = document.createElement("span");
      count.className = "tag-count";
      if (hasChildren) {
        count.textContent = node.subtree_count + " 个文件（自身 " + node.file_count + "）";
      } else {
        count.textContent = node.file_count + " 个文件";
      }
      const actions = document.createElement("span");
      actions.className = "tag-actions";
      const renameBtn = document.createElement("button");
      renameBtn.textContent = "重命名";
      renameBtn.addEventListener("click", async () => {
        const value = await UI.prompt("新名称", node.name);
        if (!value || !value.trim()) return;
        try {
          await API.put("/api/tags/" + node.id, { name: value.trim() });
          await afterChange();
        } catch (e) {
          UI.alert(e.message);
        }
      });
      const colorBtn = document.createElement("button");
      colorBtn.textContent = "颜色";
      colorBtn.addEventListener("click", () => {
        const input = document.createElement("input");
        input.type = "color";
        input.value = node.color || "#3d8bfd";
        input.style.position = "fixed";
        input.style.left = "-100px";
        document.body.appendChild(input);
        input.addEventListener("input", async () => {
          try {
            await API.put("/api/tags/" + node.id, { color: input.value });
            await afterChange();
          } catch (e) {
            UI.alert(e.message);
          }
        });
        input.addEventListener("change", () => input.remove());
        input.click();
      });
      const childBtn = document.createElement("button");
      childBtn.textContent = "子标签";
      childBtn.addEventListener("click", async () => {
        const value = await UI.prompt("新建子标签（父标签：" + node.name + "）");
        if (!value || !value.trim()) return;
        try {
          await API.post("/api/tags", { name: value.trim(), parent_id: node.id });
          state.tagExpanded[node.id] = true;
          saveTagExpanded();
          await afterChange();
        } catch (e) {
          UI.alert(e.message);
        }
      });
      const moveBtn = document.createElement("button");
      moveBtn.textContent = "移动";
      moveBtn.addEventListener("click", () => {
        const forbidden = state.tagSubtrees.get(node.id) || new Set([node.id]);
        const select = document.createElement("select");
        select.style.width = "100%";
        const rootOption = document.createElement("option");
        rootOption.value = "";
        rootOption.textContent = "顶层标签";
        select.appendChild(rootOption);
        const walk = (nodes, depthLevel) => {
          for (const item of nodes) {
            if (!forbidden.has(item.id)) {
              const option = document.createElement("option");
              option.value = item.id;
              option.textContent = "　".repeat(depthLevel) + item.name;
              select.appendChild(option);
            }
            walk(item.children, depthLevel + 1);
          }
        };
        walk(buildTagTree(state.tags), 0);
        const wrap = document.createElement("div");
        const label = document.createElement("div");
        label.className = "modal-label";
        label.textContent = "把「" + node.name + "」移动到：";
        wrap.append(label, select);
        UI.openModal({
          title: "移动标签",
          body: wrap,
          width: 380,
          footer: [
            { label: "取消" },
            {
              label: "确定",
              primary: true,
              onClick: async () => {
                const value = select.value ? Number(select.value) : null;
                try {
                  await API.put("/api/tags/" + node.id, { parent_id: value });
                  await afterChange();
                } catch (e) {
                  UI.alert(e.message);
                }
              },
            },
          ],
        });
      });
      const delBtn = document.createElement("button");
      delBtn.textContent = "删除";
      delBtn.addEventListener("click", async () => {
        const extra = hasChildren ? "其子标签将变为顶层标签。" : "";
        if (!(await UI.confirm("确定删除标签「" + node.name + "」吗？所有文件上的该标签都会被移除。" + extra))) return;
        try {
          await API.del("/api/tags/" + node.id);
          await afterChange();
        } catch (e) {
          UI.alert(e.message);
        }
      });
      actions.append(renameBtn, colorBtn, childBtn, moveBtn, delBtn);
      li.append(caret, dot, name, count, actions);
      list.appendChild(li);
      if (hasChildren && expanded) {
        node.children.forEach((child) => renderNode(child, depth + 1));
      }
    };
    buildTagTree(state.tags).forEach((root) => renderNode(root, 0));
  }

  async function createTag() {
    const input = $("#tagNewName");
    const name = input.value.trim();
    if (!name) return;
    const parentValue = $("#tagNewParent") ? $("#tagNewParent").value : "";
    const parentId = parentValue ? Number(parentValue) : null;
    try {
      await API.post("/api/tags", { name: name, parent_id: parentId });
      input.value = "";
      await renderTagManagePage();
      await refreshTagFilter();
      UI.toast("已新建标签: " + name);
    } catch (e) {
      UI.alert(e.message);
    }
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

  function setDetailVisible(show) {
    $("#detailPanel").classList.toggle("hidden", !show);
    const splitter = $("#detailSplitter");
    if (splitter) splitter.classList.toggle("hidden", !show);
  }

  function showDetailsInPanel(path) {
    setDetailVisible(true);
    showDetailsFor(path);
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
    state.pages.recent = 1;
    renderRecentList();
  }

  function renderRecentList() {
    const list = $("#recentList");
    list.innerHTML = "";
    if (!state.recentItems.length) {
      list.appendChild(makeEmptyHint("暂无播放记录"));
      renderPager("#recentPager", "recent", 0, renderRecentList);
      return;
    }
    const size = pageSize();
    const { start } = paginate(state.recentItems.length, state.pages.recent, size);
    state.pages.recent = paginate(state.recentItems.length, state.pages.recent, size).page;
    for (const item of state.recentItems.slice(start, start + size)) {
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
    renderPager("#recentPager", "recent", state.recentItems.length, renderRecentList);
  }

  /* ------------------------------------------------------------ search */

  async function doSearch() {
    const keyword = $("#searchInput").value.trim();
    if (!keyword) {
      state.searchItems = [];
      renderSearchList();
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
    state.pages.search = 1;
    renderSearchList();
    $("#searchInfo").textContent = "找到 " + data.items.length + " 个结果";
  }

  function renderSearchList() {
    const list = $("#searchList");
    list.innerHTML = "";
    if (!state.searchItems.length) {
      if ($("#searchInput").value.trim()) {
        list.appendChild(makeEmptyHint("没有匹配的结果"));
      }
      renderPager("#searchPager", "search", 0, renderSearchList);
      return;
    }
    const size = pageSize();
    const { start } = paginate(state.searchItems.length, state.pages.search, size);
    state.pages.search = paginate(state.searchItems.length, state.pages.search, size).page;
    for (const item of state.searchItems.slice(start, start + size)) {
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
    renderPager("#searchPager", "search", state.searchItems.length, renderSearchList);
  }

  /* ------------------------------------------------------------ m3u */

  async function exportM3u() {
    let paths = [];
    try {
      const data = await API.get("/api/playlist");
      paths = data.items || [];
    } catch (e) {
      UI.alert(e.message);
      return;
    }
    if (!paths.length) {
      UI.alert("播放列表为空");
      return;
    }
    const file = await UI.prompt("保存 m3u 到（服务器路径）", state.config.default_m3u || "playlist.m3u");
    if (!file) return;
    try {
      const res = await API.post("/api/playlist/save", { file, paths });
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

  /* ------------------------------------------------------------ settings */

  async function refreshConfig() {
    try {
      state.config = await API.get("/api/config");
    } catch (e) {
      return;
    }
    if (window.Player) window.Player.transcodeOn = !!state.config.transcode;
    const banner = $("#ffmpegBanner");
    if (!state.config.ffmpeg) {
      banner.textContent =
        "未检测到 ffmpeg：缩略图与媒体信息探测不可用（不影响播放与媒体库）。可在「设置」页填写 ffmpeg/ffprobe 路径。";
      banner.classList.remove("hidden");
    } else {
      banner.classList.add("hidden");
    }
  }

  function renderSettingRoots() {
    const list = $("#setRoots");
    list.innerHTML = "";
    if (!state.settingRoots.length) {
      const li = document.createElement("li");
      li.className = "label";
      li.textContent = "（未设置，默认允许访问所有本地磁盘）";
      list.appendChild(li);
      return;
    }
    for (const path of state.settingRoots) {
      const li = document.createElement("li");
      li.className = "entry";
      li.dataset.path = path;
      const name = document.createElement("span");
      name.className = "entry-name";
      name.textContent = path;
      li.appendChild(name);
      list.appendChild(li);
    }
  }

  async function loadSettings() {
    let data;
    try {
      data = await API.get("/api/settings");
    } catch (e) {
      UI.toast("读取设置失败: " + e.message);
      return;
    }
    state.serverSettings = data;
    state.settingRoots = (data.allowed_roots || []).slice();
    $("#setHost").value = data.host;
    $("#setPort").value = data.port;
    $("#setFfmpeg").value = data.ffmpeg;
    $("#setFfprobe").value = data.ffprobe;
    $("#setTranscode").checked = !!data.transcode;
    $("#setDataDir").textContent = data.data_dir;
    $("#setConfigFile").textContent = data.config_file;
    $("#setToolStatus").textContent = data.ffmpeg_resolved
      ? "当前生效: " + data.ffmpeg_resolved
      : "当前未检测到 ffmpeg";
    renderSettingRoots();

    const defaults = loadPlayerDefaults();
    $("#setVolume").value = String(defaults.volume);
    $("#setSpeed").value = String(defaults.speed);
    $("#setMode").value = String(defaults.mode);
    $("#setDanmaku").checked = defaults.danmaku;
    $("#setDanmakuSpeed").value = String(defaults.danmakuSpeed);
    $("#setPageSize").value = String(pageSize());
    $("#aboutVersion").textContent = state.config.version || "";
    $("#aboutFfmpeg").textContent = state.config.ffmpeg
      ? state.config.ffmpeg_path || "已检测到"
      : "未检测到（缩略图与媒体信息探测不可用）";
    $("#aboutDataDir").textContent = state.config.data_dir || data.data_dir || "";
    $("#aboutConfigFile").textContent = data.config_file || "";
    updatePlayerDefaultLabels();
  }

  function loadPlayerDefaults() {
    const defaults = Prefs.getJSON("mw/defaults", {});
    return {
      volume: defaults.volume !== undefined ? Number(defaults.volume) : 80,
      speed: defaults.speed !== undefined ? Number(defaults.speed) : 10,
      mode: defaults.mode !== undefined ? Number(defaults.mode) : 0,
      danmaku: defaults.danmaku !== undefined ? !!defaults.danmaku : true,
      danmakuSpeed: defaults.danmakuSpeed !== undefined ? Number(defaults.danmakuSpeed) : 8000,
    };
  }

  function updatePlayerDefaultLabels() {
    $("#setVolumeText").textContent = $("#setVolume").value;
    $("#setSpeedText").textContent = (Number($("#setSpeed").value) / 10).toFixed(1) + "x";
  }

  async function saveServerSettings() {
    try {
      const res = await API.put("/api/settings", {
        host: $("#setHost").value.trim(),
        port: Number($("#setPort").value),
        allowed_roots: state.settingRoots,
        ffmpeg: $("#setFfmpeg").value.trim(),
        ffprobe: $("#setFfprobe").value.trim(),
        transcode: $("#setTranscode").checked,
      });
      await refreshConfig();
      await loadDrives();
      await loadSettings();
      UI.toast(
        res.restart_required
          ? "已保存；监听地址/端口需重启服务后生效"
          : "服务器设置已保存"
      );
    } catch (e) {
      UI.alert(e.message);
    }
  }

  async function testTool(tool, inputId, statusEl) {
    const path = $(inputId).value.trim();
    if (!path) {
      statusEl.textContent = "请先填写路径或命令名";
      return;
    }
    statusEl.textContent = "检测中...";
    try {
      const res = await API.post("/api/settings/test-tool", { path, tool });
      $(inputId).value = res.resolved;
      statusEl.textContent = tool + " 可用：" + res.version;
    } catch (e) {
      statusEl.textContent = tool + " 检测失败：" + e.message;
    }
  }

  function savePlayerDefaults() {
    const defaults = {
      volume: Number($("#setVolume").value),
      speed: Number($("#setSpeed").value),
      mode: Number($("#setMode").value),
      danmaku: $("#setDanmaku").checked,
      danmakuSpeed: Number($("#setDanmakuSpeed").value),
    };
    Prefs.setJSON("mw/defaults", defaults);
    Prefs.set("mw/volume", defaults.volume);
    Prefs.set("mw/speed", defaults.speed);
    Prefs.set("mw/mode", defaults.mode);
    Prefs.set("mw/danmaku", defaults.danmaku ? "1" : "0");
    Prefs.set("mw/danmakuSpeed", defaults.danmakuSpeed);
    UI.toast("播放器默认值已保存");
  }

  /* ------------------------------------------------------------ about */

  function showAbout() {
    const shortcuts = [
      ["Space", "播放 / 暂停"],
      ["← / →", "快退 / 快进 5 秒"],
      ["↑ / ↓", "音量 ±5"],
      ["F", "全屏切换"],
      ["M", "静音"],
      ["L", "信息面板显示/隐藏"],
      ["D", "弹幕开关"],
      ["Ctrl+L", "评论列表（面板）"],
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

    $("#detailClose").addEventListener("click", () => setDetailVisible(false));
    $("#btnAbout").addEventListener("click", showAbout);

    $("#pathGo").addEventListener("click", () => browse($("#pathInput").value.trim()));
    $("#driveSelect").addEventListener("change", () => {
      const value = $("#driveSelect").value;
      if (value) browse(value);
    });
    $("#pathUp").addEventListener("click", () => {
      if ($("#pathUp").disabled || !state.parent) return;
      browse(state.parent);
    });
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
      Prefs.set("mw/onlyVideo", state.onlyVideo ? "true" : "false");
      browse(state.path);
    });
    $("#sortSelect").value = String(state.sort);
    $("#sortSelect").addEventListener("change", () => {
      state.sort = parseInt($("#sortSelect").value, 10) || 0;
      Prefs.set("mw/sort", String(state.sort));
      browse(state.path);
    });

    $("#libAddDir").addEventListener("click", async () => {
      const path = await UI.prompt("添加库目录（绝对路径）", state.path || "");
      if (path) addLibraryDir(path);
    });
    $("#libRemoveDir").addEventListener("click", removeLibraryDir);
    $("#libScan").addEventListener("click", () => {
      const selected = selectedDir();
      if (!selected) {
        UI.alert("请先在路径库列表中选择目录");
        return;
      }
      scanDirId(selected);
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
          { label: "扫描入库", onClick: () => scanDirPath(path) },
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
        { label: "查看详情", onClick: () => showDetailsInPanel(path) },
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
      const dirId = parseInt(li.dataset.id, 10);
      showMenu(e.clientX, e.clientY, [
        { label: "进入", onClick: () => browse(path) },
        { label: "扫描入库", onClick: () => scanDirId({ id: dirId, path }) },
        { label: "编辑路径...", onClick: () => editLibraryDir(dirId, path) },
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
    $("#playlistView").addEventListener("dblclick", async (e) => {
      const li = e.target.closest("li.media-item");
      if (!li) return;
      const index = parseInt(li.dataset.index, 10);
      const paths = await fetchFilteredPaths();
      if (paths.length) Player.open(paths, index);
    });
    $("#playlistView").addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const li = e.target.closest("li.media-item");
      if (!li) return;
      const path = li.dataset.path;
      const index = parseInt(li.dataset.index, 10);
      const selected = selectedOr(path);
      showMenu(e.clientX, e.clientY, [
        {
          label: "播放",
          onClick: async () => {
            const paths = await fetchFilteredPaths();
            if (paths.length) Player.open(paths, index);
          },
        },
        { label: "编辑标签...", enabled: selected.length > 0, onClick: () => editTags(selected) },
        { label: "查看详情", onClick: () => showDetailsInPanel(path) },
        { label: "生成缩略图", enabled: selected.length > 0, onClick: () => requestThumbs(selected) },
        { label: "从列表移除", enabled: selected.length > 0, onClick: () => removeFromPlaylist(selected) },
        { label: "清空列表", enabled: state.playlistTotal > 0, onClick: clearPlaylist },
        { label: "移除失效项", enabled: state.playlistTotal > 0, onClick: cleanPlaylist },
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
        { label: "查看详情", onClick: () => showDetailsInPanel(li.dataset.path) },
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
        { label: "查看详情", onClick: () => showDetailsInPanel(path) },
        { label: "生成缩略图", onClick: () => requestThumbs([path]) },
        { label: "在资源管理器中显示", onClick: () => explore(path) },
      ]);
    });

    let libFilterTimer = null;
    $("#plSearch").addEventListener("input", () => {
      clearTimeout(libFilterTimer);
      libFilterTimer = setTimeout(() => {
        state.libFilters.search = $("#plSearch").value;
        saveLibFilters();
        refreshPlaylistView(true);
      }, 200);
    });
    $$('input[name="plStatus"]').forEach((radio) =>
      radio.addEventListener("change", () => {
        state.libFilters.status = radio.value;
        saveLibFilters();
        refreshPlaylistView(true);
      })
    );
    $$('input[name="plDuration"]').forEach((radio) =>
      radio.addEventListener("change", () => {
        state.libFilters.duration = radio.value;
        saveLibFilters();
        refreshPlaylistView(true);
      })
    );
    $$('input[name="plTagMode"]').forEach((radio) =>
      radio.addEventListener("change", () => {
        state.libFilters.tagMode = radio.value;
        saveLibFilters();
        refreshPlaylistView(true);
      })
    );
    $("#plSort").addEventListener("change", () => {
      state.libFilters.sort = $("#plSort").value;
      saveLibFilters();
      refreshPlaylistView(true);
    });
    $("#plResetFilters").addEventListener("click", resetLibFilters);
    $("#plRestore").addEventListener("click", restorePlaylistFromDb);
    $("#tagCreate").addEventListener("click", createTag);
    $("#tagNewName").addEventListener("keydown", (e) => {
      if (e.key === "Enter") createTag();
    });
    $("#tasksRefresh").addEventListener("click", renderTasksPage);

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

    $("#setVolume").addEventListener("input", updatePlayerDefaultLabels);
    $("#setSpeed").addEventListener("input", updatePlayerDefaultLabels);
    $("#setPlayerSave").addEventListener("click", savePlayerDefaults);
    $("#setPageSizeSave").addEventListener("click", () => {
      setPageSize(Number($("#setPageSize").value));
      state.pages = { fileList: 1, playlist: 1, recent: 1, search: 1 };
      rerenderAllLists();
      UI.toast("每页数量已设置为 " + pageSize());
    });
    $("#setServerSave").addEventListener("click", saveServerSettings);
    $("#setFfmpegTest").addEventListener("click", () =>
      testTool("ffmpeg", "#setFfmpeg", $("#setToolStatus"))
    );
    $("#setFfprobeTest").addEventListener("click", () =>
      testTool("ffprobe", "#setFfprobe", $("#setToolStatus"))
    );
    $("#setRootAdd").addEventListener("click", async () => {
      const path = await UI.prompt("添加允许访问的根目录（绝对路径）", "");
      if (!path) return;
      if (!state.settingRoots.includes(path)) state.settingRoots.push(path);
      renderSettingRoots();
      UI.toast("已添加，点击「保存服务器设置」后生效");
    });
    $("#setRootRemove").addEventListener("click", () => {
      const selected = state.selectedPaths.find((p) => state.settingRoots.includes(p));
      if (!selected) {
        UI.alert("请先在列表中选择要移除的目录");
        return;
      }
      state.settingRoots = state.settingRoots.filter((p) => p !== selected);
      renderSettingRoots();
      UI.toast("已移除，点击「保存服务器设置」后生效");
    });
    $("#setRoots").addEventListener("click", (e) => {
      const li = e.target.closest("li.entry");
      if (!li) return;
      handleItemClick(e, $("#setRoots"), state.settingRoots, li);
    });
  }

  /* ------------------------------------------------------------ init */

  async function init() {
    await Prefs.load();
    applyPrefs();
    await refreshConfig();
    bindEvents();
    initSplitters();
    restoreLibFilterUI();
    await refreshTagFilter();
    await loadLibraryDirs();
    await loadDrives();
    await loadServerPlaylist();
    await browse(state.path);
    await refreshPlaylistView(true);
    setTab("path");
  }

  window.APP = {
    get visiblePaths() {
      return state.visiblePaths;
    },
    setTab,
    refreshRecent,
    onPlayerClosed() {
      refreshPlaylistView();
    },
    refreshPlaylistView,
  };

  document.addEventListener("DOMContentLoaded", init);
})();
