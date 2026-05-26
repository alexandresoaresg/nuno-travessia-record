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
  const currentKm = D.current.km;
  const segments = M.categorySegments || [];

  const map = L.map("map", { zoomControl: true }).setView(
    [M.current.lat, M.current.lng],
    10
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
  }).addTo(map);

  const categoryGroup = L.layerGroup().addTo(map);
  const layersByKm = {};

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
  L.marker([M.current.lat, M.current.lng], {
    icon: currentIcon,
    zIndexOffset: 1000,
  })
    .addTo(map)
    .bindPopup(popup);

  if (M.bounds && M.bounds.length === 2) {
    map.fitBounds(M.bounds, { padding: [40, 40] });
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
  bindToggle("layer-route", routeLayer);
  bindToggle("layer-track", categoryGroup);

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
})();
