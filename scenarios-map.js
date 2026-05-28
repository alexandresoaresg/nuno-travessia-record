(function () {
  const D = window.ANALYTICS;
  const mapEl = document.getElementById("scenarios-map");
  const legendEl = document.getElementById("scenarios-map-legend");
  const fitBtn = document.getElementById("scenarios-map-fit-all");
  if (!mapEl || !D || !D.map) return;

  if (typeof L === "undefined") {
    mapEl.innerHTML =
      '<p style="padding:1.5rem;color:#8b95a8">Mapa indispon\u00edvel: Leaflet n\u00e3o carregou.</p>';
    return;
  }

  let map = null;
  let routeLayer = null;
  const markerById = {};
  let lastPayload = null;

  function makePinIcon(color, isCurrent) {
    return L.divIcon({
      className: "scenario-map-pin",
      html:
        '<div class="scenario-map-pin-inner' +
        (isCurrent ? " is-current" : "") +
        '" style="background:' +
        color +
        '"></div>',
      iconSize: [0, 0],
      iconAnchor: [0, 0],
    });
  }

  function initMap() {
    if (map) return;
    const cur = D.map.current;
    const lat = cur && cur.lat != null ? cur.lat : 41.5;
    const lng = cur && cur.lng != null ? cur.lng : -8.5;
    map = L.map("scenarios-map", { zoomControl: true, attributionControl: true }).setView(
      [lat, lng],
      9
    );
    const carto = L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
      {
        attribution: '&copy; OSM &copy; <a href="https://carto.com/">CARTO</a>',
        subdomains: "abcd",
        maxZoom: 19,
      }
    );
    const osm = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
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
    if (D.map.route && D.map.route.length >= 2) {
      routeLayer = L.polyline(D.map.route, {
        color: "#5a6a82",
        weight: 2,
        opacity: 0.45,
        dashArray: "6 8",
      }).addTo(map);
    }
    if (fitBtn) {
      fitBtn.addEventListener("click", () => fitAllMarkers(true));
    }
  }

  function popupHtml(pt) {
    const km =
      pt.km != null && Number.isFinite(pt.km) ? "km " + Number(pt.km).toFixed(1) : "";
    return (
      "<b>" +
      (pt.label || "-") +
      "</b>" +
      (km ? "<br>" + km : "") +
      (pt.hint ? '<br><span style="opacity:.8;font-size:12px">' + pt.hint + "</span>" : "")
    );
  }

  function updateLegend(points) {
    if (!legendEl) return;
    if (!points || !points.length) {
      legendEl.innerHTML = "";
      return;
    }
    legendEl.innerHTML = points
      .map((pt) => {
        const km =
          pt.km != null && Number.isFinite(pt.km)
            ? " &middot; <strong>km " + Number(pt.km).toFixed(1) + "</strong>"
            : "";
        return (
          '<li><span class="dot' +
          (pt.kind === "current" ? " is-current" : "") +
          '" style="background:' +
          pt.color +
          '"></span><span>' +
          pt.label +
          km +
          "</span></li>"
        );
      })
      .join("");
  }

  function fitAllMarkers(animate) {
    if (!map || !lastPayload) return;
    const latlngs = (lastPayload.points || [])
      .filter((p) => p.lat != null && p.lng != null)
      .map((p) => [p.lat, p.lng]);
    if (latlngs.length < 1) return;
    if (latlngs.length === 1) {
      map.setView(latlngs[0], Math.max(map.getZoom(), 10), { animate: !!animate });
      return;
    }
    const bounds = L.latLngBounds(latlngs).pad(0.18);
    map.fitBounds(bounds, {
      maxZoom: 12,
      animate: !!animate,
      duration: animate ? 0.4 : 0,
    });
  }

  function refresh(payload) {
    initMap();
    if (!map || !payload) return;
    lastPayload = payload;

    if (payload.route && payload.route.length >= 2) {
      if (routeLayer) {
        routeLayer.setLatLngs(payload.route);
      } else {
        routeLayer = L.polyline(payload.route, {
          color: "#5a6a82",
          weight: 2,
          opacity: 0.45,
          dashArray: "6 8",
        }).addTo(map);
      }
    }

    const seen = {};
    (payload.points || []).forEach((pt) => {
      if (pt.lat == null || pt.lng == null) return;
      seen[pt.id] = true;
      const isCurrent = pt.kind === "current";
      const icon = makePinIcon(pt.color || "#94a3b8", isCurrent);
      if (markerById[pt.id]) {
        markerById[pt.id].setLatLng([pt.lat, pt.lng]);
        markerById[pt.id].setIcon(icon);
        markerById[pt.id].setPopupContent(popupHtml(pt));
      } else {
        markerById[pt.id] = L.marker([pt.lat, pt.lng], { icon })
          .bindPopup(popupHtml(pt))
          .addTo(map);
      }
    });

    Object.keys(markerById).forEach((id) => {
      if (!seen[id]) {
        map.removeLayer(markerById[id]);
        delete markerById[id];
      }
    });

    updateLegend(payload.points || []);
    fitAllMarkers(false);
  }

  window.travessiaRefreshScenariosMap = refresh;
  window.__travessiaScenariosMapFitAll = function () {
    fitAllMarkers(true);
  };
  window.__travessiaScenariosMapInvalidate = function () {
    if (map) {
      map.invalidateSize({ pan: false });
      fitAllMarkers(false);
    }
  };
})();
