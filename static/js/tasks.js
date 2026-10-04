(function () {
  "use strict";

  const tasks = new Map();
  let seq = 0;

  function panel() {
    return document.getElementById("taskPanel");
  }

  function updatePanel() {
    const el = panel();
    if (!el) return;
    el.classList.toggle("hidden", tasks.size === 0);
  }

  function run(options) {
    const opts = options || {};
    const host = panel();
    if (!host) return null;
    const id = opts.id || "task-" + ++seq;
    const el = document.createElement("div");
    el.className = "task-item";
    const head = document.createElement("div");
    head.className = "task-head";
    const title = document.createElement("span");
    title.className = "task-title";
    title.textContent = opts.title || "任务";
    if (opts.tooltip) title.title = opts.tooltip;
    const close = document.createElement("button");
    close.className = "task-close";
    close.textContent = "✕";
    close.title = "取消任务";
    head.append(title, close);
    const bar = document.createElement("div");
    bar.className = "task-bar indeterminate";
    const fill = document.createElement("div");
    fill.className = "fill";
    bar.appendChild(fill);
    const status = document.createElement("div");
    status.className = "task-status";
    status.textContent = opts.initialText || "正在处理...";
    el.append(head, bar, status);
    host.appendChild(el);
    updatePanel();

    const task = {
      id: id,
      el: el,
      bar: bar,
      fill: fill,
      status: status,
      close: close,
      finished: false,
      timer: null,
      poll: opts.poll,
      onFinish: opts.onFinish,
      onCancel: opts.onCancel,
      interval: opts.interval || 500,
      removableAfter: opts.removableAfter === undefined ? 6000 : opts.removableAfter,
    };
    tasks.set(id, task);
    close.onclick = () => {
      if (task.finished) {
        remove(id);
        return;
      }
      status.textContent = "正在取消...";
      if (task.onCancel) Promise.resolve(task.onCancel()).catch(() => {});
    };
    if (task.poll) {
      task.timer = setInterval(() => poll(id), task.interval);
      poll(id);
    }
    return id;
  }

  async function poll(id) {
    const task = tasks.get(id);
    if (!task || task.finished || !task.poll) return;
    let st;
    try {
      st = await task.poll();
    } catch (error) {
      finish(id, "error", "任务失败：" + error.message);
      return;
    }
    if (!st) return;
    if (st.state === "running") {
      renderRunning(task, st);
      return;
    }
    let message = st.text || "";
    if (st.state === "done" && task.onFinish) {
      try {
        const finalMessage = await task.onFinish(st);
        if (finalMessage) message = finalMessage;
      } catch (error) {
        finish(id, "error", "处理失败：" + error.message);
        return;
      }
    }
    finish(id, st.state, message);
  }

  function renderRunning(task, st) {
    if (st.percent === null || st.percent === undefined) {
      task.bar.classList.add("indeterminate");
    } else {
      task.bar.classList.remove("indeterminate");
      const pct = Math.max(0, Math.min(100, st.percent));
      task.fill.style.width = pct + "%";
    }
    if (st.text) task.status.textContent = st.text;
  }

  function finish(id, state, message) {
    const task = tasks.get(id);
    if (!task || task.finished) return;
    task.finished = true;
    clearInterval(task.timer);
    task.bar.classList.remove("indeterminate");
    if (state === "done") {
      task.fill.style.width = "100%";
      task.el.classList.add("done");
    } else if (state === "error") {
      task.el.classList.add("error");
    }
    task.status.textContent =
      message || (state === "done" ? "完成" : state === "cancelled" ? "已取消" : "任务结束");
    task.close.textContent = "×";
    task.close.title = "关闭";
    if (task.removableAfter > 0) {
      setTimeout(() => remove(id), task.removableAfter);
    }
  }

  function remove(id) {
    const task = tasks.get(id);
    if (!task) return;
    clearInterval(task.timer);
    task.el.remove();
    tasks.delete(id);
    updatePanel();
  }

  window.Tasks = {
    run: run,
    remove: remove,
    count: () => tasks.size,
  };
})();
