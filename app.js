(function () {
  const D = window.ANALYTICS;
  if (!D) return;

  const $ = (id) => document.getElementById(id);
  const totalKm = D.event.totalKm;
  const currentKm = D.current.km;

  // --- DOM init ---
  $("athlete-name").textContent = D.athlete.name;
  const ev = D.event;
  let evSub = ev.name + " · " + totalKm + " km";
  if (ev.firstGpsTime) {
    evSub += " · GPS desde " + ev.firstGpsTime.split(" ")[1];
  }
  if (ev.firstAlongRouteKm) {
    evSub += " (percurso ~km " + ev.firstAlongRouteKm + ")";
  }
  $("event-name").textContent = evSub;

  function renderLive() {
    const section = $("live-section");
    const Lv = D.live;
    if (!section || !Lv) {
      if (section) section.hidden = true;
      return;
    }
    section.hidden = false;
    const parts = (Lv.gpsTime || "").split(" ");
    $("live-gps-time").textContent = Lv.gpsTime ? parts.join(" · ") : "—";
    const lag = Lv.lagMinutes;
    $("live-gps-lag").textContent =
      lag != null
        ? lag <= 2
          ? "Quase em tempo real · " + (Lv.source || "position")
          : `Há ${lag} min · ${Lv.source || "position"}`
        : Lv.source || "—";
    const battEl = $("live-battery");
    if (battEl) {
      battEl.textContent = Lv.battery || "—";
      battEl.classList.remove("battery-low", "battery-warn");
      if (Lv.batteryPct != null && Lv.batteryPct <= 15) battEl.classList.add("battery-low");
      else if (Lv.batteryPct != null && Lv.batteryPct <= 30) battEl.classList.add("battery-warn");
    }
    $("live-status").textContent =
      [Lv.status, Lv.speed != null ? Lv.speed + " km/h" : null].filter(Boolean).join(" · ") || "—";
    const kmLive = Lv.alongRouteKm;
    $("live-position").textContent = kmLive != null ? `~km ${kmLive}` : `${Lv.lat}, ${Lv.lng}`;
    $("live-coords").textContent =
      kmLive != null
        ? `${Lv.lat}°, ${Lv.lng}°` + (Lv.alt != null ? ` · ${Lv.alt} m` : "")
        : Lv.alt != null
          ? `${Lv.alt} m`
          : "—";
    const logT = Lv.logTime || (D.map && D.map.current && D.map.current.logTime);
    $("live-log-time").textContent = logT ? logT.replace(" ", " · ") : "—";
  }
  renderLive();

  const updatedEl = $("updated-at");
  if (updatedEl) {
    let foot = "Dados: " + (D.updatedAt || "—");
    if (D.live && D.live.gpsTime) foot += " · GPS live " + D.live.gpsTime.split(" ")[1];
    updatedEl.textContent = foot;
  }

  $("progress-pct").textContent = D.current.progressPct + "%";
  $("progress-km").textContent = currentKm + " / " + totalKm + " km";
  $("progress-fill").style.width = D.current.progressPct + "%";

  const stats = [
    ["stat-km", currentKm + " km", "Último split: km " + currentKm],
    ["stat-remain", D.current.remainingKm + " km", "Faltam percorrer"],
    ["stat-elapsed", D.current.elapsed, "Desde as 11:00"],
    [
      "stat-pace",
      (D.prediction.performance?.weightedPaceMin || D.prediction.basePaceMin) + " min/km",
      "Pace ponderado (dados reais)",
    ],
  ];
  stats.forEach(([id, v, s]) => {
    const el = $(id);
    if (el) {
      el.querySelector(".value").textContent = v;
      el.querySelector(".sub").textContent = s;
    }
  });

  // --- Hybrid prediction (athlete performance + ultra science priors) ---
  const profileFull = D.routeProfileFull || D.routeProfile;
  const P = D.prediction;
  const perf = P.performance || {};
  const sci = P.science || {};
  const SCI = {
    climbSecPer100m: sci.climb_sec_per_100m || 18,
    distanceFatiguePerKm: sci.distance_fatigue_per_km || 0.0012,
    decayPer10km: sci.base_pace_decay_per_10km || 0.025,
    nightFactor: sci.night_pace_factor || 1.08,
    sleepOnsetH: sci.sleep_onset_hours || 36,
    sleepStopMinPer6h: sci.sleep_stop_min_per_6h || 25,
    paceFloor: sci.finish_pace_floor_factor || 2.8,
    optFactor: sci.optimistic_factor || 0.92,
    pesFactor: sci.pessimistic_factor || 1.14,
  };

  let params = {
    athleteWeightPct: Math.round((P.athleteWeight || 0.75) * 100),
    basePaceMin: perf.weightedPaceMin || P.basePaceMin,
    fatiguePerKm: (P.fatigueRatePerKm || 0.002) * 100,
    climbSecPer100m: P.climbSecPer100m || perf.climbSecPer100m || SCI.climbSecPer100m,
  };

  function isNight(d) {
    const h = d.getHours();
    return h >= 22 || h < 6;
  }

  function athleteWeightFromPct(pct) {
    return pct / 100;
  }

  function paceForKm(km, ahead, crossing, elapsedH, scenario) {
    const w = athleteWeightFromPct(params.athleteWeightPct);
    const baseS = params.basePaceMin * 60;
    const fatigueK = params.fatiguePerKm / 100;
    const seg = profileFull[km - 1] || { gain: 0, loss: 0 };

    let paceBase = baseS;
    let fatigue = fatigueK;
    let climb = params.climbSecPer100m;
    let nightF = 1 + (perf.nightSlowdownPct || 0) / 100;

    if (scenario === "optimistic") {
      paceBase = (perf.p25PaceMin || params.basePaceMin) * 60;
      fatigue *= 0.6;
      climb *= 0.85;
    } else if (scenario === "pessimistic") {
      paceBase = (perf.p75PaceMin || params.basePaceMin) * 60;
      fatigue *= 1.35;
      fatigue += SCI.distanceFatiguePerKm;
      climb *= 1.2;
      nightF = Math.max(SCI.nightFactor, nightF);
    }

    const scienceBase = paceBase * (1.04 + 0.00008 * Math.max(0, currentKm - 50));
    const blended = w * paceBase + (1 - w) * Math.min(scienceBase, paceBase * 1.18);

    let decay = w * (1 + fatigue * ahead) + (1 - w) * (1 + SCI.distanceFatiguePerKm * ahead);
    if (km > 100) {
      decay *= 1 + (1 - w) * SCI.decayPer10km * ((km - 100) / 10);
    }

    const terrain =
      climb * (seg.gain / 100) - 0.3 * climb * ((seg.loss || 0) / 100);
    let paceS = blended * decay + terrain;

    if (isNight(crossing)) paceS *= w * nightF + (1 - w) * SCI.nightFactor;

    if (elapsedH >= SCI.sleepOnsetH) {
      const extra = elapsedH - SCI.sleepOnsetH;
      paceS += ((SCI.sleepStopMinPer6h / 60) * (extra / 6) / Math.max(1, ahead)) * 60;
    }

    return Math.min(Math.max(paceS, blended * 0.75), blended * SCI.paceFloor);
  }

  function predictFinish(scenario) {
    let cum = 0;
    const forecast = [];
    const lastCross = new Date(D.current.lastCrossing.replace(" ", "T"));
    const start = new Date((D.event.startTime || D.current.lastCrossing).replace(" ", "T"));
    let t = lastCross;

    for (let km = currentKm + 1; km <= Math.floor(totalKm); km++) {
      const ahead = km - currentKm;
      const elapsedH = (t.getTime() - start.getTime()) / 3600000;
      const paceS = paceForKm(km, ahead, t, elapsedH, scenario || "main");
      cum += paceS;
      t = new Date(lastCross.getTime() + cum * 1000);
      if (ahead % 5 === 0 || km === Math.floor(totalKm)) {
        forecast.push({ km, paceMin: paceS / 60, gain: (profileFull[km - 1] || {}).gain || 0 });
      }
    }

    return {
      finish: t,
      hours: cum / 3600,
      forecast,
    };
  }

  function fmtDate(d) {
    return d.toLocaleString("pt-PT", {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function renderInsightPanels() {
    const perfEl = $("perf-stats");
    const sciEl = $("science-stats");
    const refsEl = $("science-refs");
    if (!perfEl || !sciEl) return;

    const perfRows = [
      ["Ritmo ponderado (30 km)", (perf.weightedPaceMin || "—") + " min/km"],
      ["Ritmo global corrido", (perf.overallPaceMin || "—") + " min/km"],
      ["Mediana em movimento", (perf.medianPaceMin || "—") + " min/km"],
      ["Faixa P25–P75", (perf.p25PaceMin || "—") + " – " + (perf.p75PaceMin || "—")],
      ["Fadiga início→fim", (perf.fatiguePctEarlyLate || "—") + "%"],
      ["Km com paragem", (perf.stopRatioPct || "—") + "%"],
      ["Paragem média", (perf.avgStopMin || "—") + " min"],
      ["Mais lento à noite", (perf.nightSlowdownPct || "0") + "%"],
      ["Subida aprendida", (perf.climbSecPer100m || P.climbSecPer100m || "—") + " s/100m D+"],
    ];
    perfEl.innerHTML = perfRows
      .map(([k, v]) => `<li><span>${k}</span><span>${v}</span></li>`)
      .join("");

    const sciRows = [
      ["Decaimento / 10 km (>100 km)", (SCI.decayPer10km * 100).toFixed(1) + "%"],
      ["Fadiga distância (literatura)", (SCI.distanceFatiguePerKm * 100).toFixed(2) + "%/km"],
      ["Subida referência", SCI.climbSecPer100m + " s/100m D+"],
      ["Factor nocturno", "+" + Math.round((SCI.nightFactor - 1) * 100) + "%"],
      ["Sono (após " + SCI.sleepOnsetH + " h)", "+" + SCI.sleepStopMinPer6h + " min/6h"],
    ];
    sciEl.innerHTML = sciRows
      .map(([k, v]) => `<li><span>${k}</span><span>${v}</span></li>`)
      .join("");

    if (refsEl && sci.sources) {
      refsEl.innerHTML = sci.sources
        .map((s) => `<li><strong>${s.id}</strong>: ${s.note}</li>`)
        .join("");
    }

    const conf = $("pred-confidence");
    const blend = $("pred-blend-label");
    if (conf) conf.textContent = "Confiança ~" + (P.confidencePct || "—") + "%";
    if (blend)
      blend.textContent =
        "Mix " +
        params.athleteWeightPct +
        "% real / " +
        (100 - params.athleteWeightPct) +
        "% literatura";
    const desc = $("model-desc");
    if (desc)
      desc.innerHTML =
        (P.model || "") +
        ". Com mais km percorridos, o peso dos <strong>dados reais</strong> aumenta. " +
        "Cenários otimista/pessimista usam P25/P75 do ritmo e fadiga ajustada.";
  }

  function updatePrediction() {
    const main = predictFinish("main");
    const opt = predictFinish("optimistic");
    const pes = predictFinish("pessimistic");

    $("finish-time").textContent = fmtDate(main.finish);
    $("finish-hours").textContent =
      "~" + main.hours.toFixed(1) + " h (" + (main.hours / 24).toFixed(1) + " dias)";
    $("finish-range").textContent =
      "Otimista: " +
      fmtDate(opt.finish) +
      " · Pessimista: " +
      fmtDate(pes.finish);
    const preview = $("prediction-preview");
    if (preview) {
      preview.textContent =
        fmtDate(main.finish) + " · ~" + main.hours.toFixed(0) + " h restantes";
    }
    drawForecastChart(main.forecast);
    renderInsightPanels();
  }

  function bindSlider(id, key, fmt) {
    const input = $(id);
    const label = $(id + "-val");
    if (!input || !label) return;
    input.value = params[key];
    label.textContent = fmt(params[key]);
    input.addEventListener("input", () => {
      params[key] = parseFloat(input.value);
      label.textContent = fmt(params[key]);
      updatePrediction();
    });
  }
  bindSlider("sl-blend", "athleteWeightPct", (v) => v + "%");
  bindSlider("sl-base", "basePaceMin", (v) => v.toFixed(1) + " min/km");
  bindSlider("sl-fatigue", "fatiguePerKm", (v) => v.toFixed(2) + "%/km");
  bindSlider("sl-climb", "climbSecPer100m", (v) => v.toFixed(0) + " s/100m D+");
  renderInsightPanels();
  updatePrediction();

  const predictionDetails = $("prediction-details");
  if (predictionDetails) {
    predictionDetails.addEventListener("toggle", () => {
      if (predictionDetails.open) updatePrediction();
    });
  }

  // --- Charts ---
  function setupCanvas(canvas, height) {
    const rect = canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = height * dpr;
    canvas.style.height = height + "px";
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    return { ctx, w: rect.width, h: height };
  }

  function drawPaceChart() {
    const canvas = $("chart-pace");
    const { ctx, w, h } = setupCanvas(canvas, 220);
    const splits = D.splits.filter((s) => !s.unavailable && !s.partial);
    const pad = { l: 44, r: 16, t: 16, b: 32 };
    const maxP = Math.max(...splits.map((s) => s.segment_time_s / 60), 12);
    const minKm = splits[0].km;
    const maxKm = splits[splits.length - 1].km;

    ctx.fillStyle = "#151920";
    ctx.fillRect(0, 0, w, h);

    // grid
    ctx.strokeStyle = "#2a3344";
    ctx.lineWidth = 1;
    for (let p = 0; p <= maxP; p += 5) {
      const y = pad.t + (1 - p / maxP) * (h - pad.t - pad.b);
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(w - pad.r, y);
      ctx.stroke();
      ctx.fillStyle = "#8b95a8";
      ctx.font = "10px sans-serif";
      ctx.fillText(p + " min", 4, y + 4);
    }

    const barW = Math.max(2, ((w - pad.l - pad.r) / splits.length) * 0.7);
    splits.forEach((s) => {
      const pace = s.segment_time_s / 60;
      const x =
        pad.l +
        ((s.km - minKm) / (maxKm - minKm)) * (w - pad.l - pad.r) -
        barW / 2;
      const bh = (pace / maxP) * (h - pad.t - pad.b);
      const y = h - pad.b - bh;
      ctx.fillStyle = s.categoryColor || "#3d8bfd";
      ctx.fillRect(x, y, barW, bh);
    });

    ctx.fillStyle = "#8b95a8";
    ctx.font = "11px sans-serif";
    ctx.fillText("Km", w / 2 - 10, h - 8);
    ctx.save();
    ctx.translate(12, h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("Tempo por km (min)", 0, 0);
    ctx.restore();
  }

  function drawElevChart() {
    const canvas = $("chart-elev");
    const { ctx, w, h } = setupCanvas(canvas, 200);
    const prof = D.routeProfile;
    const pad = { l: 44, r: 16, t: 16, b: 28 };
    const maxKm = prof[prof.length - 1].km;
    const alts = prof.map((p) => p.elevation);
    const minA = Math.min(...alts) - 20;
    const maxA = Math.max(...alts) + 20;

    ctx.fillStyle = "#151920";
    ctx.fillRect(0, 0, w, h);

    ctx.beginPath();
    prof.forEach((p, i) => {
      const x = pad.l + (p.km / maxKm) * (w - pad.l - pad.r);
      const y =
        pad.t + (1 - (p.elevation - minA) / (maxA - minA)) * (h - pad.t - pad.b);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.lineTo(pad.l + (w - pad.l - pad.r), h - pad.b);
    ctx.lineTo(pad.l, h - pad.b);
    ctx.closePath();
    ctx.fillStyle = "rgba(61, 139, 253, 0.2)";
    ctx.fill();
    ctx.strokeStyle = "#3d8bfd";
    ctx.lineWidth = 2;
    ctx.stroke();

    // current position
    const cx = pad.l + (currentKm / maxKm) * (w - pad.l - pad.r);
    ctx.strokeStyle = "#22c55e";
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(cx, pad.t);
    ctx.lineTo(cx, h - pad.b);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#22c55e";
    ctx.font = "10px sans-serif";
    ctx.fillText("Agora: km " + currentKm, Math.min(cx + 4, w - 80), pad.t + 12);

    ctx.fillStyle = "#8b95a8";
    ctx.font = "10px sans-serif";
    ctx.fillText("km", w / 2, h - 6);
    ctx.fillText("m", 8, pad.t + 10);
  }

  function drawForecastChart(forecast) {
    const canvas = $("chart-forecast");
    if (!forecast.length) return;
    const { ctx, w, h } = setupCanvas(canvas, 160);
    const pad = { l: 40, r: 12, t: 12, b: 28 };
    const maxP = Math.max(...forecast.map((f) => f.paceMin), 12);

    ctx.fillStyle = "#151920";
    ctx.fillRect(0, 0, w, h);
    const minK = forecast[0].km;
    const maxK = forecast[forecast.length - 1].km;

    ctx.strokeStyle = "#22c55e";
    ctx.lineWidth = 2;
    ctx.beginPath();
    forecast.forEach((f, i) => {
      const x = pad.l + ((f.km - minK) / (maxK - minK)) * (w - pad.l - pad.r);
      const y = pad.t + (1 - f.paceMin / maxP) * (h - pad.t - pad.b);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    ctx.fillStyle = "#8b95a8";
    ctx.font = "10px sans-serif";
    ctx.fillText("Ritmo previsto (min/km) — próximos km", pad.l, h - 6);
  }

  drawPaceChart();
  drawElevChart();

  window.addEventListener("resize", () => {
    drawPaceChart();
    drawElevChart();
    updatePrediction();
  });

  // --- Table ---
  const tbody = $("splits-body");
  let sortKey = "km";
  let sortDir = 1;

  const categoryFilter = $("filter-category");

  function renderTable(kmFilter, catFilter) {
    let rows = [...D.splits];
    if (kmFilter) {
      const q = kmFilter.toLowerCase();
      rows = rows.filter((r) => String(r.km).includes(q));
    }
    if (catFilter && catFilter !== "all") {
      rows = rows.filter((r) => r.category === catFilter);
    }
    rows.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "string") return av.localeCompare(bv) * sortDir;
      return (av - bv) * sortDir;
    });
    tbody.innerHTML = rows
      .map((r) => {
        if (r.unavailable) {
          return `<tr class="split-unavailable" data-km="${r.km}">
          <td>${r.km}</td>
          <td colspan="6" class="muted">Sem passagem GPS no percurso oficial</td>
        </tr>`;
        }
        if (r.partial) {
          const hour = r.crossing_time ? r.crossing_time.split(" ")[1] : "—";
          const batt = r.battery || "—";
          return `<tr class="split-partial" data-km="${r.km}">
          <td>${r.km}</td>
          <td class="muted">—</td>
          <td>${hour}</td>
          <td>${r.segment_time}</td>
          <td>${r.pace}</td>
          <td>${batt}</td>
          <td>${r.elapsed_time}</td>
        </tr>`;
        }
        let cls = r.category || "";
        if (r.km === currentKm) cls += " current";
        const badge = `<span class="cat-badge" style="background:${r.categoryColor}22;color:${r.categoryColor};border-color:${r.categoryColor}55">${r.categoryLabel || "—"}</span>`;
        const batt = r.battery || "—";
        const battCls =
          r.battery_pct != null && r.battery_pct <= 15
            ? "battery-low"
            : r.battery_pct != null && r.battery_pct <= 30
              ? "battery-warn"
              : "";
        const hour = r.crossing_time ? r.crossing_time.split(" ")[1] : "—";
        return `<tr class="${cls.trim()}" data-km="${r.km}" data-category="${r.category}" style="cursor:pointer">
          <td>${r.km}</td>
          <td>${badge}</td>
          <td>${hour}</td>
          <td>${r.segment_time}</td>
          <td>${r.pace}</td>
          <td class="${battCls}">${batt}</td>
          <td>${r.elapsed_time}</td>
        </tr>`;
      })
      .join("");
  }

  function renderCategoryLegend() {
    const el = $("category-legend");
    const sumEl = $("category-summary");
    if (!el || !D.categoryLegend) return;
    el.innerHTML = D.categoryLegend
      .map(
        (c) =>
          `<li><span class="swatch" style="background:${c.color}"></span>${c.label} <span class="muted">(${c.paceRange})</span></li>`
      )
      .join("");
    if (sumEl && D.categorySummary) {
      const pct = D.categorySummary.pct || {};
      sumEl.innerHTML = D.categoryLegend
        .map((c) => {
          const n = (D.categorySummary.counts || {})[c.id] || 0;
          const p = pct[c.id] || 0;
          return n
            ? `<span class="cat-chip" style="border-color:${c.color}55;color:${c.color}">${c.short} ${n} (${p}%)</span>`
            : "";
        })
        .filter(Boolean)
        .join("");
    }
    if (categoryFilter && !categoryFilter.dataset.filled) {
      categoryFilter.dataset.filled = "1";
      D.categoryLegend.forEach((c) => {
        const opt = document.createElement("option");
        opt.value = c.id;
        opt.textContent = c.label;
        categoryFilter.appendChild(opt);
      });
    }
  }

  function refreshTable() {
    renderTable($("search-km")?.value || "", categoryFilter?.value || "all");
  }

  renderCategoryLegend();
  refreshTable();
  $("search-km")?.addEventListener("input", refreshTable);
  categoryFilter?.addEventListener("change", refreshTable);
  document.querySelectorAll("thead th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      const k = th.dataset.sort;
      if (sortKey === k) sortDir *= -1;
      else {
        sortKey = k;
        sortDir = 1;
      }
      refreshTable();
    });
  });

  // Highlights
  const fast = D.stats.fastest;
  const slow = D.stats.slowest;
  $("fastest-km").textContent =
    "Km " + fast.km + " · " + fast.segment_time + " (" + fast.pace + ")" + (fast.categoryLabel ? " · " + fast.categoryLabel : "");
  $("slowest-km").textContent =
    "Km " + slow.km + " · " + slow.segment_time + " (" + slow.pace + ")" + (slow.categoryLabel ? " · " + slow.categoryLabel : "");

  document.getElementById("splits-body")?.addEventListener("click", (e) => {
    const tr = e.target.closest("tr");
    if (
      !tr ||
      !tr.dataset.km ||
      tr.classList.contains("split-unavailable") ||
      tr.classList.contains("split-partial")
    )
      return;
    const km = parseInt(tr.dataset.km, 10);
    if (window.highlightMapKm) window.highlightMapKm(km);
  });
})();
