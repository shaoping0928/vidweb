const API = {
  async _fetch(url, options) {
    const res = await fetch(url, options);
    if (!res.ok) {
      let detail = res.status + " " + res.statusText;
      try {
        const data = await res.json();
        if (data && data.detail) detail = data.detail;
      } catch (e) {}
      const error = new Error(detail);
      error.status = res.status;
      throw error;
    }
    if (res.status === 204) return null;
    const type = res.headers.get("content-type") || "";
    return type.includes("application/json") ? res.json() : res.text();
  },
  get(path, params) {
    let qs = "";
    if (params) {
      const sp = new URLSearchParams();
      for (const key in params) {
        const value = params[key];
        if (value === undefined || value === null) continue;
        sp.set(key, value);
      }
      const s = sp.toString();
      if (s) qs = "?" + s;
    }
    return this._fetch(path + qs);
  },
  post(path, body) {
    return this._fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
  },
  put(path, body) {
    return this._fetch(path, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
  },
  del(path) {
    return this._fetch(path, { method: "DELETE" });
  },
  thumbUrl(path, bust) {
    return "/api/thumbnail?path=" + encodeURIComponent(path) + (bust ? "&_=" + bust : "");
  },
  streamUrl(path) {
    return "/api/stream?path=" + encodeURIComponent(path);
  },
};

const Fmt = {
  pad(n) {
    return String(n).padStart(2, "0");
  },
  time(ms) {
    if (!isFinite(ms) || ms < 0) ms = 0;
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor(total / 60) % 60;
    const s = total % 60;
    return h + ":" + this.pad(m) + ":" + this.pad(s);
  },
  timePrecise(ms) {
    if (!isFinite(ms) || ms < 0) ms = 0;
    const total = Math.floor(ms);
    const s = Math.floor(total / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor(s / 60) % 60;
    const sec = s % 60;
    const msec = total % 1000;
    return h + ":" + this.pad(m) + ":" + this.pad(sec) + "." + String(msec).padStart(3, "0");
  },
  bytes(n) {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = Number(n) || 0;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }
    return value.toFixed(unit === 0 ? 0 : 1) + " " + units[unit];
  },
  relative(secs) {
    if (!secs) return "从未";
    const diff = Math.floor(Date.now() / 1000) - secs;
    if (diff < 60) return "刚刚";
    if (diff < 3600) return Math.floor(diff / 60) + " 分钟前";
    if (diff < 86400) return Math.floor(diff / 3600) + " 小时前";
    if (diff < 86400 * 7) return Math.floor(diff / 86400) + " 天前";
    const d = new Date(secs * 1000);
    return (
      d.getFullYear() + "-" + this.pad(d.getMonth() + 1) + "-" + this.pad(d.getDate()) +
      " " + this.pad(d.getHours()) + ":" + this.pad(d.getMinutes())
    );
  },
  dateTime(secs) {
    const d = new Date((Number(secs) || 0) * 1000);
    return (
      d.getFullYear() + "-" + this.pad(d.getMonth() + 1) + "-" + this.pad(d.getDate()) +
      " " + this.pad(d.getHours()) + ":" + this.pad(d.getMinutes())
    );
  },
  timestamp() {
    const d = new Date();
    return (
      String(d.getFullYear()) + this.pad(d.getMonth() + 1) + this.pad(d.getDate()) +
      "_" + this.pad(d.getHours()) + this.pad(d.getMinutes()) + this.pad(d.getSeconds())
    );
  },
  escape(value) {
    return String(value === undefined || value === null ? "" : value).replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  },
};

window.API = API;
window.Fmt = Fmt;
