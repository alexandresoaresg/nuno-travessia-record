(function () {
  const overlay = document.getElementById("data-refresh-overlay");
  const statusEl = document.getElementById("data-refresh-status");
  const countdownWrap = document.getElementById("footer-countdowns");
  const countdownLiveEl = document.getElementById("countdown-live");
  const countdownFullEl = document.getElementById("countdown-full");
  const LIVE_MS = 60 * 1000;
  const FULL_MS = 5 * 60 * 1000;
  const POLL_MS = 8 * 1000;

  let lastDataVersion = null;
  let lastLiveUpdatedAt = null;
  let pollTimer = null;
  let countdownTimer = null;
  let nextLiveAt = 0;
  let nextFullAt = 0;
  let pollingActive = false;

  function setStatus(msg) {
    if (statusEl) statusEl.textContent = msg;
  }

  function formatMmSs(sec) {
    const s = Math.max(0, Math.ceil(sec));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return m + ":" + String(r).padStart(2, "0");
  }

  function setCountdownEl(el, sec) {
    if (!el) return;
    el.textContent = formatMmSs(sec);
    el.classList.toggle("is-due", sec <= 3);
  }

  function showCountdowns(visible) {
    if (countdownWrap) countdownWrap.hidden = !visible;
  }

  function syncCountdownFromStatus(info) {
    if (!info || !info.ok) {
      showCountdowns(false);
      return;
    }
    showCountdowns(true);
    const now = Date.now();
    if (info.nextLiveInSec != null && Number.isFinite(info.nextLiveInSec)) {
      nextLiveAt = now + info.nextLiveInSec * 1000;
    }
    if (info.nextFullInSec != null && Number.isFinite(info.nextFullInSec)) {
      nextFullAt = now + info.nextFullInSec * 1000;
    }
    tickCountdowns();
  }

  function resetLiveCountdown() {
    nextLiveAt = Date.now() + LIVE_MS;
    tickCountdowns();
  }

  function resetFullCountdown() {
    nextFullAt = Date.now() + FULL_MS;
    tickCountdowns();
  }

  function initClientCountdowns() {
    const now = Date.now();
    if (!nextLiveAt) nextLiveAt = now + LIVE_MS;
    if (!nextFullAt) nextFullAt = now + FULL_MS;
    showCountdowns(true);
    tickCountdowns();
  }

  function tickCountdowns() {
    if (!pollingActive) return;
    const now = Date.now();
    if (nextLiveAt) setCountdownEl(countdownLiveEl, (nextLiveAt - now) / 1000);
    if (nextFullAt) setCountdownEl(countdownFullEl, (nextFullAt - now) / 1000);
  }

  function startCountdownTicker() {
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = setInterval(tickCountdowns, 1000);
    tickCountdowns();
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.async = false;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("Falha a carregar " + src));
      document.body.appendChild(s);
    });
  }

  async function fetchJson(url) {
    const res = await fetch(url, { cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  }

  function formatStatus(info) {
    if (!info || !info.ok) return "Sem dados — corre ./serve.sh";
    const live = info.liveGpsTime ? " · GPS " + String(info.liveGpsTime).split(" ")[1] : "";
    const err = info.lastError ? " · ERRO refresh" : "";
    if (info.scheduler) {
      return "Auto " + (info.updatedAt || "") + live + err;
    }
    return "Dados " + (info.updatedAt || "") + live + err;
  }

  async function loadAppScripts(cacheBust) {
    const v = cacheBust || Date.now();
    await loadScript("data.js?v=" + v);
    await loadScript("app.js?v=" + v);
    await loadScript("map.js?v=" + v);
    lastDataVersion = window.ANALYTICS && window.ANALYTICS.updatedAt;
    lastLiveUpdatedAt =
      (window.ANALYTICS && window.ANALYTICS.liveUpdatedAt) ||
      (window.ANALYTICS && window.ANALYTICS.live && window.ANALYTICS.live.gpsTime) ||
      null;
  }

  async function applyLivePatch(patch) {
    if (!patch || !patch.ok) return;
    if (window.travessiaApplyLivePatch) {
      window.travessiaApplyLivePatch(patch);
    }
  }

  async function applyFullAnalytics() {
    const res = await fetch("/api/analytics", { cache: "no-store" });
    if (!res.ok) return;
    const analytics = await res.json();
    lastDataVersion = analytics.updatedAt;
    if (window.travessiaReloadAnalytics) {
      window.travessiaReloadAnalytics(analytics);
    }
    resetFullCountdown();
  }

  async function pollUpdates() {
    try {
      const { data: status } = await fetchJson("/api/status");
      if (!status.ok) return;

      syncCountdownFromStatus(status);

      const liveVer = status.liveUpdatedAt || status.liveGpsTime;
      if (liveVer && liveVer !== lastLiveUpdatedAt) {
        lastLiveUpdatedAt = liveVer;
        const { data: patch } = await fetchJson("/api/live");
        if (patch.ok) {
          await applyLivePatch(patch);
          resetLiveCountdown();
        }
      }

      const ver = status.dataVersion || status.updatedAt;
      if (ver && ver !== lastDataVersion) {
        lastDataVersion = ver;
        await applyFullAnalytics();
        setStatus(formatStatus(status));
      }
    } catch (err) {
      console.warn("pollUpdates:", err);
    }
  }

  function startPolling() {
    pollingActive = true;
    if (pollTimer) clearInterval(pollTimer);
    initClientCountdowns();
    startCountdownTicker();
    pollTimer = setInterval(pollUpdates, POLL_MS);
  }

  async function boot() {
    document.body.classList.add("is-loading-data");
    if (overlay) overlay.hidden = false;
    setStatus("A carregar…");

    let status = {};
    let hasServer = false;
    try {
      const { res, data } = await fetchJson("/api/status");
      if (res.ok && data.ok) {
        hasServer = true;
        status = data;
        lastDataVersion = data.dataVersion || data.updatedAt;
        lastLiveUpdatedAt = data.liveUpdatedAt || data.liveGpsTime;
        syncCountdownFromStatus(data);
        setStatus(formatStatus(data));
      }
    } catch (err) {
      console.warn("status:", err);
      setStatus("Modo local (sem serve.py)");
      showCountdowns(false);
    }

    try {
      await loadAppScripts(status.dataVersion || Date.now());
    } catch (err) {
      setStatus("Erro: " + err.message);
      console.error(err);
      document.body.classList.remove("is-loading-data");
      return;
    }

    document.body.classList.remove("is-loading-data");
    if (overlay) {
      setTimeout(() => {
        overlay.hidden = true;
      }, 350);
    }

    if (hasServer) {
      startPolling();
      pollUpdates();
    }
  }

  boot();
})();
