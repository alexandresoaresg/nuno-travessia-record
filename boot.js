(function () {
  const overlay = document.getElementById("data-refresh-overlay");
  const statusEl = document.getElementById("data-refresh-status");

  function setStatus(msg) {
    if (statusEl) statusEl.textContent = msg;
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

  async function boot() {
    document.body.classList.add("is-loading-data");
    if (overlay) overlay.hidden = false;
    setStatus("A ligar a API Stop&Go...");

    try {
      const res = await fetch("/api/refresh?force=1", { cache: "no-store" });
      const info = await res.json().catch(() => ({}));
      if (!res.ok && !info.ok) {
        setStatus("Erro ao actualizar — a usar ultimos dados guardados");
      } else if (info.skipped) {
        setStatus("Actualizado ha " + (info.nextRefreshInSec || 0) + "s");
      } else if (info.apiLive) {
        const live = info.liveGpsTime ? " · GPS " + info.liveGpsTime.split(" ")[1] : "";
        const logNote = info.apiLog ? "" : " · log em cache";
        setStatus("Ao vivo " + (info.updatedAt || "") + live + logNote);
      } else if (info.ok) {
        const live = info.liveGpsTime ? " · GPS " + info.liveGpsTime.split(" ")[1] : "";
        setStatus("Cache local " + (info.updatedAt || "") + live);
      } else {
        setStatus("Sem dados — corre ./update.sh");
      }
    } catch (err) {
      console.warn("Refresh:", err);
      setStatus("Sem servidor de refresh - ficheiros locais");
    }

    const v = Date.now();
    try {
      await loadScript("data.js?v=" + v);
      await loadScript("app.js?v=" + v);
      await loadScript("map.js?v=" + v);
    } catch (err) {
      setStatus("Erro: " + err.message);
      console.error(err);
    }

    document.body.classList.remove("is-loading-data");
    if (overlay) {
      setTimeout(() => {
        overlay.hidden = true;
      }, 400);
    }
  }

  boot();
})();
