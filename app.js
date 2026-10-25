(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const HISTORY_MAX = 8;
  // Cached because they get detached from the stage and getElementById can't find detached nodes.
  const emptyEl = $("empty");
  const counterEl = $("counter");

  // Formats a developer might paste into a PR comment.
  const FORMATS = {
    md: (url) => `![LGTM](${url})`,
    html: (url) => `<img src="${url}" alt="LGTM" width="320">`,
    url: (url) => url,
  };

  // localStorage can throw (private mode, blocked storage), so every access is guarded.
  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
    },
  };

  const state = {
    broken: new Set(),     // dead links found this session
    bag: [],               // shuffle bag: no repeats until the pool is exhausted
    current: null,
    history: [],
    format: FORMATS[store.get("lgtm.format")] ? store.get("lgtm.format") : "md",
    queued: null,          // next GIF, preloaded so flips feel instant
  };

  const pool = [...new Set(window.SEED_GIFS || [])];
  const livePool = () => pool.filter((u) => !state.broken.has(u));

  /* ---------- picking & preloading ---------- */

  function refillBag() {
    const bag = livePool().filter((u) => u !== state.current);
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    state.bag = bag;
  }

  function nextUrl() {
    // Drop anything found broken since the bag was filled.
    while (state.bag.length) {
      const url = state.bag.pop();
      if (!state.broken.has(url)) return url;
    }
    refillBag();
    return state.bag.pop() || null;
  }

  function loadImage(url) {
    return new Promise((resolve) => {
      const img = new Image();
      img.alt = "LGTM GIF";
      img.decoding = "async";
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }

  function queueNext() {
    const url = nextUrl();
    state.queued = url ? { url, ready: loadImage(url) } : null;
  }

  /* ---------- rendering ---------- */

  function render() {
    const has = Boolean(state.current);
    $("snippet").textContent = has ? FORMATS[state.format](state.current) : "…";
    $("copyBtn").disabled = !has;

    document.querySelectorAll("[data-format]").forEach((btn) => {
      btn.setAttribute("aria-selected", String(btn.dataset.format === state.format));
    });

    $("poolInfo").textContent = livePool().length;
    renderHistory();
  }

  function renderHistory() {
    // Always render every slot (empty ones as placeholders) so the layout never jumps.
    const slots = Array.from({ length: HISTORY_MAX }, (_, i) => state.history[i] || null);
    $("historyWrap").classList.toggle("is-empty", !state.history.length);
    $("history").replaceChildren(...slots.map((url) => {
      const li = document.createElement("li");
      if (!url) {
        li.className = "slot";
        return li;
      }
      const btn = document.createElement("button");
      btn.type = "button";
      btn.title = "Show this one again";
      btn.setAttribute("aria-current", String(url === state.current));
      btn.addEventListener("click", () => display(url, { remember: false }));
      const img = document.createElement("img");
      img.src = url;
      img.alt = "";
      img.loading = "lazy";
      btn.append(img);
      li.append(btn);
      return li;
    }));
  }

  function showEmpty(message) {
    const stage = $("stage");
    stage.classList.remove("loading");
    counterEl.hidden = true;
    emptyEl.querySelector("p").textContent = message;
    stage.replaceChildren(emptyEl, counterEl);
  }

  function display(url, { img, remember = true, copy = false } = {}) {
    const el = img || Object.assign(new Image(), { src: url, alt: "LGTM GIF" });
    const stage = $("stage");
    stage.classList.remove("loading", "rolling");
    void stage.offsetWidth; // restart the roll animation
    stage.classList.add("rolling");
    stage.replaceChildren(el, counterEl);

    state.current = url;
    if (remember) {
      state.history = [url, ...state.history.filter((u) => u !== url)].slice(0, HISTORY_MAX);
      state.seen = (state.seen || 0) + 1;
    }
    counterEl.hidden = false;
    counterEl.textContent = `#${state.seen || 1}`;

    render();
    if (copy) copySnippet({ auto: true });
  }

  /* ---------- actions ---------- */

  let flipping = false;
  async function flip() {
    if (flipping) return;
    flipping = true;
    $("stage").classList.add("loading");
    try {
      // Try queued GIFs until one loads; dead links are skipped silently.
      for (;;) {
        if (!state.queued) queueNext();
        if (!state.queued) {
          showEmpty("Couldn't load any GIFs. Check your connection.");
          render();
          return;
        }
        const { url, ready } = state.queued;
        const img = await ready;
        state.queued = null;
        if (img) {
          display(url, { img, copy: true });
          queueNext();
          return;
        }
        state.broken.add(url);
      }
    } finally {
      flipping = false;
    }
  }

  async function writeClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  async function copySnippet({ auto = false } = {}) {
    if (!state.current) return;
    const ok = await writeClipboard(FORMATS[state.format](state.current));
    if (ok) toast(auto ? `copied ${state.format}, paste it in the PR` : `copied ${state.format}`);
    else if (!auto) toast("clipboard blocked: select the snippet and copy it", true);
  }

  function setFormat(format) {
    if (!FORMATS[format]) return;
    state.format = format;
    store.set("lgtm.format", format);
    render();
    if (state.current) copySnippet();
  }

  function toggleTheme() {
    const root = document.documentElement;
    const dark = root.dataset.theme
      ? root.dataset.theme === "dark"
      : matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = dark ? "light" : "dark";
    store.set("lgtm.theme", root.dataset.theme);
  }

  function toggleDialog(id) {
    const dialog = $(id);
    if (dialog.open) return dialog.close();
    document.querySelectorAll("dialog[open]").forEach((d) => d.close());
    dialog.showModal();
  }

  let toastTimer;
  function toast(message, warn = false) {
    const el = $("toast");
    el.textContent = message;
    el.classList.toggle("warn", warn);
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 1600);
  }

  /* ---------- wiring ---------- */

  const SHORTCUTS = {
    " ": flip,
    n: flip,
    c: () => copySnippet(),
    "1": () => setFormat("md"),
    "2": () => setFormat("html"),
    "3": () => setFormat("url"),
    t: toggleTheme,
    "?": () => toggleDialog("help"),
    i: () => toggleDialog("about"),
  };
  const DIALOG_KEYS = new Set(["?", "i"]);

  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (e.target.closest("input, textarea, select, [contenteditable]")) return;
    const key = e.key.toLowerCase();
    // While a dialog is open, only the dialog toggles work (Esc closes natively).
    if (document.querySelector("dialog[open]") && !DIALOG_KEYS.has(key)) return;
    const action = SHORTCUTS[key];
    if (!action) return;
    e.preventDefault(); // also stops Space from scrolling or clicking the focused button
    action();
  });
  // Space activates a focused button on keyup; swallow that so Space always means "flip".
  document.addEventListener("keyup", (e) => {
    if (e.key === " " && e.target.closest("button")) e.preventDefault();
  });

  $("flipBtn").addEventListener("click", flip);
  $("copyBtn").addEventListener("click", () => copySnippet());
  $("themeBtn").addEventListener("click", toggleTheme);
  $("helpBtn").addEventListener("click", () => toggleDialog("help"));
  $("aboutBtn").addEventListener("click", () => toggleDialog("about"));
  document.querySelectorAll("[data-format]").forEach((btn) => {
    btn.addEventListener("click", () => setFormat(btn.dataset.format));
  });

  /* ---------- boot ---------- */

  render();
  queueNext();
})();
