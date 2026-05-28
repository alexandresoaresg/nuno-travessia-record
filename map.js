(function () {
  const D = window.ANALYTICS;
  if (!D || !D.map) return;

  const mapEl = document.getElementById("map");
  if (!mapEl) return;
  if (typeof L === "undefined") {
    mapEl.innerHTML =
      '<p style="padding:2rem;color:#8b95a8">Mapa indisponível: Leaflet não carregou. Verifica ligação à internet e recarrega a página.</p>';
    return;
  }

  const M = D.map;
  const pred = D.prediction || {};
  const modelVer = pred.modelVersion || 4;
  const currentKm = D.current.km;
  const segments = M.categorySegments || [];

  const map = L.map("map", { zoomControl: true }).setView(
    [M.current.lat, M.current.lng],
    12
  );

  const carto = L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    attribution: '&copy; OSM &copy; <a href="https://carto.com/">CARTO</a>',
    subdomains: "abcd",
    maxZoom: 19,
  });
  const osm = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
  });
  carto.addTo(map);
  let tileFallback = false;
  carto.on("tileerror", () => {
    if (tileFallback) return;
    tileFallback = true;
    map.removeLayer(carto);
    osm.addTo(map);
  });

  const routeLayer = L.polyline(M.route, {
    color: "#5a6a82",
    weight: 2,
    opacity: 0.5,
    dashArray: "6 8",
  });
  const routeGroup = L.layerGroup([routeLayer]).addTo(map);

  const categoryGroup = L.layerGroup().addTo(map);
  const layersByKm = {};

  // Base continuous track (always connects points)
  if (M.track && M.track.length >= 2) {
    const baseTrack = L.polyline(
      M.track.map((p) => [p[0], p[1]]),
      {
        color: "#8b95a8",
        weight: 3,
        opacity: 0.35,
        lineCap: "round",
        lineJoin: "round",
        smoothFactor: 1.0,
      }
    );
    baseTrack.addTo(categoryGroup);
  }

  segments.forEach((seg) => {
    if (!seg.points || seg.points.length < 2) return;
    const line = L.polyline(seg.points, {
      color: seg.color || "#3d8bfd",
      weight: 7,
      opacity: 0.95,
      lineCap: "round",
      lineJoin: "round",
      smoothFactor: 1.0,
    });
    const label = seg.categoryLabel || "—";
    const kmLabel =
      seg.fromKm === seg.toKm ? `Km ${seg.toKm}` : `Km ${seg.fromKm}–${seg.toKm}`;
    line.bindPopup(
      `<b>${kmLabel}</b> · ${label}<br>` +
        (seg.fromKm !== seg.toKm ? `${seg.fromKm} → ${seg.toKm} km<br>` : "") +
        `Último km: <b>${seg.segment}</b> (${seg.pace})`
    );
    line.on("click", () => highlightKm(seg.toKm));
    line.addTo(categoryGroup);
    const kms = seg.kms || [seg.km];
    kms.forEach((k) => {
      layersByKm[k] = line;
    });
  });

  const currentIcon = L.divIcon({
    className: "current-pin",
    html: '<div class="pin-core"></div>',
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
  const liveKm = M.current.alongRouteKm;
  const kmLabel =
    liveKm != null
      ? `Km percurso ~${liveKm} (split oficial: ${currentKm})`
      : `Km split oficial: ${currentKm}`;
  let popup =
    `<b>Posição actual</b> (${M.current.source || "GPS"})<br>` +
    `${kmLabel}<br>` +
    `GPS: <b>${M.current.time || "—"}</b><br>` +
    `Alt: ${M.current.alt} m`;
  if (M.current.battery) popup += `<br>Bateria: ${M.current.battery}`;
  if (M.current.speed != null) popup += `<br>Vel.: ${M.current.speed} km/h`;
  if (M.current.logTime && M.current.source !== "trackersLog") {
    popup += `<br><span style="opacity:.75">Últ. trackersLog: ${M.current.logTime}</span>`;
  }
  const currentMarker = L.marker([M.current.lat, M.current.lng], {
    icon: currentIcon,
    zIndexOffset: 1000,
  })
    .addTo(map)
    .bindPopup(popup);

  const viewerIcon = L.divIcon({
    className: "viewer-pin",
    html: '<span class="pin-ring"></span><div class="pin-core"></div>',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
  let viewerMarker = null;
  let viewerAccuracyCircle = null;
  let viewerLastPos = null;
  const viewerStatusEl = document.getElementById("map-viewer-status");
  const viewerCenterBtn = document.getElementById("map-center-viewer");

  function setViewerStatus(text, visible) {
    if (!viewerStatusEl) return;
    viewerStatusEl.textContent = text || "";
    viewerStatusEl.hidden = !visible;
  }

  function viewerPopupHtml(lat, lng, accuracyM, updatedAt) {
    let html =
      "<b>Onde estás</b> (este dispositivo)<br>" +
      `Lat: ${lat.toFixed(5)}, lng: ${lng.toFixed(5)}`;
    if (accuracyM != null && Number.isFinite(accuracyM)) {
      html += `<br>Precisão: ~${Math.round(accuracyM)} m`;
    }
    if (updatedAt) html += `<br>Actualizado: ${updatedAt}`;
    return html;
  }

  function updateViewerPosition(lat, lng, accuracyM) {
    viewerLastPos = { lat, lng, accuracyM };
    const updatedAt = new Date().toLocaleString("pt-PT", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    if (!viewerMarker) {
      viewerMarker = L.marker([lat, lng], {
        icon: viewerIcon,
        zIndexOffset: 1100,
      })
        .addTo(map)
        .bindPopup(viewerPopupHtml(lat, lng, accuracyM, updatedAt));
      if (viewerCenterBtn) viewerCenterBtn.hidden = false;
      setViewerStatus(
        `Localização activa · ${lat.toFixed(4)}, ${lng.toFixed(4)}` +
          (accuracyM != null ? ` (±${Math.round(accuracyM)} m)` : ""),
        true
      );
    } else {
      viewerMarker.setLatLng([lat, lng]);
      viewerMarker.setPopupContent(viewerPopupHtml(lat, lng, accuracyM, updatedAt));
    }
    if (accuracyM != null && accuracyM > 0 && accuracyM < 5000) {
      if (!viewerAccuracyCircle) {
        viewerAccuracyCircle = L.circle([lat, lng], {
          radius: accuracyM,
          color: "#ec4899",
          weight: 1,
          fillColor: "#ec4899",
          fillOpacity: 0.12,
          interactive: false,
        }).addTo(map);
      } else {
        viewerAccuracyCircle.setLatLng([lat, lng]);
        viewerAccuracyCircle.setRadius(accuracyM);
      }
    }
  }

  function centerOnViewer() {
    if (!viewerLastPos) return;
    const z = viewerLastPos.accuracyM && viewerLastPos.accuracyM < 200 ? 14 : 12;
    map.setView([viewerLastPos.lat, viewerLastPos.lng], z, { animate: true });
    if (viewerMarker) viewerMarker.openPopup();
  }

  if (viewerCenterBtn) {
    viewerCenterBtn.addEventListener("click", centerOnViewer);
  }

  if (navigator.geolocation) {
    setViewerStatus("A pedir localização deste dispositivo…", true);
    navigator.geolocation.watchPosition(
      (pos) => {
        updateViewerPosition(
          pos.coords.latitude,
          pos.coords.longitude,
          pos.coords.accuracy
        );
      },
      (err) => {
        const msg =
          err.code === 1
            ? "Localização recusada — activa permissão no browser para ver onde estás."
            : err.code === 3
              ? "Tempo esgotado ao obter GPS deste dispositivo."
              : "Não foi possível obter a tua localização.";
        setViewerStatus(msg, true);
      },
      { enableHighAccuracy: true, maximumAge: 20000, timeout: 20000 }
    );
  } else {
    setViewerStatus("Geolocalização não suportada neste browser.", true);
  }

  function livePopupHtml(cur) {
    const liveKm = cur.alongRouteKm;
    const kmLabel =
      liveKm != null
        ? `Km percurso ~${liveKm} (split oficial: ${currentKm})`
        : `Km split oficial: ${currentKm}`;
    let html =
      `<b>Posição actual</b> (${cur.source || "GPS"})<br>` +
      `${kmLabel}<br>` +
      `GPS: <b>${cur.time || cur.gpsTime || "—"}</b><br>` +
      `Alt: ${cur.alt} m`;
    if (cur.battery) html += `<br>Bateria: ${cur.battery}`;
    if (cur.speed != null) html += `<br>Vel.: ${cur.speed} km/h`;
    return html;
  }

  window.travessiaUpdateMapLive = function (patch) {
    const cur = patch.mapCurrent || patch;
    if (!cur || !cur.lat) return;
    currentMarker.setLatLng([cur.lat, cur.lng]);
    currentMarker.setPopupContent(livePopupHtml(cur));
    M.current = cur;
  };

  window.travessiaMapReload = function (mapData) {
    if (!mapData) return;
    Object.assign(M, mapData);
    if (mapData.current) {
      currentMarker.setLatLng([mapData.current.lat, mapData.current.lng]);
      currentMarker.setPopupContent(livePopupHtml(mapData.current));
    }
  };

  // Record pace marker (where the current record would be right now)
  if (M.recordPace && M.recordPace.lat && M.recordPace.lng) {
    const recIcon = L.divIcon({
      className: "record-pin",
      html: '<div class="pin-core"></div>',
      iconSize: [16, 16],
      iconAnchor: [8, 8],
    });
    L.marker([M.recordPace.lat, M.recordPace.lng], {
      icon: recIcon,
      zIndexOffset: 900,
    })
      .addTo(map)
      .bindPopup(
        `<b>Ritmo do record (referência)</b><br>` +
          `Km ~${M.recordPace.km}<br>` +
          `Hora: ${M.recordPace.time}<br>` +
          `Alt: ${M.recordPace.alt} m`
      );
  }

  // Calendar goal marker (where he would need to be now to finish by 31 May)
  if (M.calendarPace && M.calendarPace.lat && M.calendarPace.lng) {
    const goalIcon = L.divIcon({
      className: "goal-pin",
      html: '<div class="pin-core"></div>',
      iconSize: [16, 16],
      iconAnchor: [8, 8],
    });
    L.marker([M.calendarPace.lat, M.calendarPace.lng], {
      icon: goalIcon,
      zIndexOffset: 880,
    })
      .addTo(map)
      .bindPopup(
        `<b>Meta 31/05 (referência)</b><br>` +
          `Onde teria de estar agora<br>` +
          `Km ~${M.calendarPace.km}<br>` +
          `Deadline: ${M.calendarPace.deadline}<br>`
      );
  }

  // Calendar goal marker (realistic, using the prediction model)
  if (M.calendarPaceRealistic && M.calendarPaceRealistic.lat && M.calendarPaceRealistic.lng) {
    const goalRealIcon = L.divIcon({
      className: "goal-real-pin",
      html: '<div class="pin-core"></div>',
      iconSize: [16, 16],
      iconAnchor: [8, 8],
    });
    L.marker([M.calendarPaceRealistic.lat, M.calendarPaceRealistic.lng], {
      icon: goalRealIcon,
      zIndexOffset: 875,
    })
      .addTo(map)
      .bindPopup(
        `<b>Meta 31/05 (realista)</b><br>` +
          `Onde teria de estar agora (modelo v${modelVer})<br>` +
          `Km ~${M.calendarPaceRealistic.km}<br>` +
          `Deadline: ${M.calendarPaceRealistic.deadline}<br>`
      );
  }

  function recenterCurrent() {
    map.setView([M.current.lat, M.current.lng], Math.max(map.getZoom(), 12), {
      animate: true,
    });
  }

  function refreshMapSize() {
    map.invalidateSize(true);
  }
  map.whenReady(refreshMapSize);
  requestAnimationFrame(refreshMapSize);
  setTimeout(refreshMapSize, 100);
  setTimeout(refreshMapSize, 500);
  window.addEventListener("resize", refreshMapSize);
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(refreshMapSize).observe(mapEl);
  }

  const slider = document.getElementById("map-timeline");
  const tlLabel = document.getElementById("map-timeline-label");
  if (slider && M.track && M.track.length) {
    slider.max = String(M.track.length - 1);
    slider.value = String(M.track.length - 1);
    const scrubMarker = L.circleMarker([M.current.lat, M.current.lng], {
      radius: 8,
      color: "#fbbf24",
      fillColor: "#fbbf24",
      fillOpacity: 0.5,
      weight: 2,
    }).addTo(map);

    function updateScrub(i) {
      const p = M.track[i];
      if (!p) return;
      scrubMarker.setLatLng([p[0], p[1]]);
      if (tlLabel) tlLabel.textContent = `${p[3]} · ${p[4]} km/h · ${p[2]} m`;
    }
    updateScrub(M.track.length - 1);
    slider.addEventListener("input", () => updateScrub(parseInt(slider.value, 10)));
  }

  function bindToggle(id, layer) {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("change", () => {
      if (el.checked) map.addLayer(layer);
      else map.removeLayer(layer);
    });
  }
  // Hover on future route → predicted crossing time (model v4 forecast, GPS anchor)
  const futureRoute = M.futureRoute || {};
  const futurePts = futureRoute.points || [];
  const futureLine = futureRoute.line || futurePts.map((p) => [p.lat, p.lng]);
  let futureGroup = null;
  let clearEtaHoverFn = null;

  if (futurePts.length >= 2 && futureLine.length >= 2) {
    futureGroup = L.layerGroup().addTo(map);

    const futureVisibleLine = L.polyline(futureLine, {
      color: "#34d399",
      weight: 6,
      opacity: 0.72,
      dashArray: "10 8",
      lineCap: "round",
      lineJoin: "round",
      interactive: false,
      className: "future-route-visible",
    });
    const futureHitLine = L.polyline(futureLine, {
      color: "#34d399",
      weight: 32,
      opacity: 0.001,
      interactive: true,
      className: "future-route-hit",
    });
    futureGroup.addLayer(futureVisibleLine);
    futureGroup.addLayer(futureHitLine);
    futureHitLine.bringToFront();

    const etaTooltip = L.tooltip({
      permanent: false,
      sticky: true,
      direction: "top",
      offset: [0, -12],
      className: "map-eta-tooltip",
    });

    let hoverRaf = null;
    let lastHoverKey = null;
    let hoverActive = false;
    const projKm = futureRoute.projectionKm ?? currentKm;

    function parseMapTime(s) {
      if (!s) return null;
      const norm = String(s).trim().replace(" ", "T");
      const d = new Date(norm.length <= 16 ? norm + ":00" : norm);
      return Number.isNaN(d.getTime()) ? null : d;
    }

    function fmtRelativeFromNow(ms) {
      if (ms < 0) return "já passou (actualizar dados)";
      const h = Math.floor(ms / 3600000);
      const m = Math.round((ms % 3600000) / 60000);
      if (h >= 48) return "daqui a " + Math.round(h / 24) + " dias";
      if (h >= 1) return "daqui a " + h + "h" + (m ? " " + m + "m" : "");
      if (m >= 1) return "daqui a " + m + " min";
      return "daqui a <1 min";
    }

    function snapRadiusM() {
      return Math.max(280, 650 / Math.max(map.getZoom(), 9));
    }

    function closestOnSegment(latlng, a, b) {
      const A = map.latLngToLayerPoint(a);
      const B = map.latLngToLayerPoint(b);
      const P = map.latLngToLayerPoint(latlng);
      const abx = B.x - A.x;
      const aby = B.y - A.y;
      const ab2 = abx * abx + aby * aby;
      let t = ab2 === 0 ? 0 : ((P.x - A.x) * abx + (P.y - A.y) * aby) / ab2;
      t = Math.max(0, Math.min(1, t));
      const H = L.point(A.x + abx * t, A.y + aby * t);
      return { latlng: map.layerPointToLatLng(H), t };
    }

    function hitTestFuture(latlng) {
      const snapM = snapRadiusM();
      let best = null;
      let bestD = snapM + 1;
      for (let i = 0; i < futurePts.length - 1; i++) {
        const a = futurePts[i];
        const b = futurePts[i + 1];
        const { latlng: closest, t } = closestOnSegment(
          latlng,
          L.latLng(a.lat, a.lng),
          L.latLng(b.lat, b.lng)
        );
        const d = map.distance(latlng, closest);
        if (d >= bestD) continue;
        bestD = d;
        const km = a.km + t * (b.km - a.km);
        const ta = parseMapTime(a.timeIso || a.time);
        const tb = parseMapTime(b.timeIso || b.time);
        let timeMs = ta ? ta.getTime() : 0;
        if (ta && tb) {
          timeMs = ta.getTime() + t * (tb.getTime() - ta.getTime());
        }
        best = {
          lat: closest.lat,
          lng: closest.lng,
          km: Math.round(km * 10) / 10,
          timeMs,
          timeShort: ta
            ? new Date(timeMs).toLocaleString("pt-PT", {
                weekday: "short",
                day: "numeric",
                month: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })
            : "—",
        };
      }
      return best;
    }

    function fmtEtaContent(p) {
      const remain = Math.max(0, p.km - projKm);
      const rel = fmtRelativeFromNow(p.timeMs - Date.now());
      const sub = pred.forecastSuspended
        ? `Forecast suspenso (paragem longa) · modelo v${modelVer}`
        : `+${remain.toFixed(1)} km · ritmo recente + paragens · v${modelVer}`;
      return (
        `<div class="map-eta-inner">` +
        `<div class="map-eta-km">Km ${p.km}</div>` +
        `<div class="map-eta-label">Passagem prevista (v${modelVer})</div>` +
        `<div class="map-eta-time">${p.timeShort}</div>` +
        `<div class="map-eta-rel">${rel}</div>` +
        `<div class="map-eta-sub">${sub}</div>` +
        `</div>`
      );
    }

    function showEtaHit(hit) {
      const key = hit.km + "|" + hit.timeMs;
      if (key !== lastHoverKey) {
        etaTooltip
          .setLatLng([hit.lat, hit.lng])
          .setContent(fmtEtaContent(hit))
          .addTo(map);
        lastHoverKey = key;
      } else {
        etaTooltip.setLatLng([hit.lat, hit.lng]);
      }
      map.getContainer().style.cursor = "crosshair";
      hoverActive = true;
    }

    function onFutureHover(e) {
      if (hoverRaf) return;
      hoverRaf = requestAnimationFrame(() => {
        hoverRaf = null;
        const hit = hitTestFuture(e.latlng);
        if (!hit) {
          if (hoverActive) clearEtaHover();
          return;
        }
        showEtaHit(hit);
      });
    }

    function clearEtaHover() {
      if (hoverRaf) {
        cancelAnimationFrame(hoverRaf);
        hoverRaf = null;
      }
      map.closeTooltip(etaTooltip);
      lastHoverKey = null;
      hoverActive = false;
      map.getContainer().style.cursor = "";
    }
    clearEtaHoverFn = clearEtaHover;

    map.on("mousemove", onFutureHover);
    map.on("mouseout", clearEtaHover);
    futureHitLine.on("mousemove", onFutureHover);
    futureHitLine.on("mouseout", clearEtaHover);
  }

  bindToggle("layer-route", routeGroup);
  bindToggle("layer-track", categoryGroup);
  if (futureGroup) {
    const futureToggle = document.getElementById("layer-future");
    bindToggle("layer-future", futureGroup);
    if (futureToggle) {
      futureToggle.addEventListener("change", () => {
        if (!futureToggle.checked && clearEtaHoverFn) clearEtaHoverFn();
      });
    }
  }

  const splitsToggle = document.getElementById("layer-splits");
  if (splitsToggle) {
    splitsToggle.closest("label").style.display = "none";
  }

  window.highlightMapKm = function (km) {
    highlightKm(km);
  };

  function highlightKm(km) {
    const row = (D.splits || []).find((s) => s.km === km);
    if (row && (row.unavailable || row.partial)) return;
    const line = layersByKm[km];
    if (!line) return;
    map.fitBounds(line.getBounds(), { padding: [60, 60], maxZoom: 14 });
    const seg = segments.find(
      (s) => (s.kms && s.kms.includes(km)) || s.km === km || (s.fromKm <= km && s.toKm >= km)
    );
    if (seg) {
      const label = seg.categoryLabel || "—";
      const kmLabel =
        seg.fromKm === seg.toKm ? `Km ${seg.toKm}` : `Km ${seg.fromKm}–${seg.toKm}`;
      line.setPopupContent(
        `<b>${kmLabel}</b> · ${label}<br>` +
          `Km seleccionado: <b>${km}</b><br>` +
          `Tempo km ${km}: consulta tabela`
      );
    }
    line.openPopup();
    document.querySelectorAll("#splits-body tr").forEach((tr) => {
      const k = parseInt(tr.dataset.km || tr.cells[0]?.textContent, 10);
      tr.classList.toggle("map-active", k === km);
    });
  }

  window.__travessiaMap = map;
  window.__travessiaMapInvalidate = refreshMapSize;
  window.__travessiaMapRecenter = recenterCurrent;
  window.__travessiaMapCenterViewer = centerOnViewer;
})();
