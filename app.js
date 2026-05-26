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


  // --- Tabs ---
  function setActiveTab(tabId) {
    document.querySelectorAll(".tab").forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === tabId);
    });
    document.querySelectorAll(".tab-panel").forEach((p) => {
      p.hidden = p.dataset.panel !== tabId;
    });
    try {
      localStorage.setItem("travessiaTab", tabId);
    } catch {}
    if (tabId === "map") {
      setTimeout(() => {
        if (window.__travessiaMapInvalidate) window.__travessiaMapInvalidate();
        if (window.__travessiaMapRecenter) window.__travessiaMapRecenter();
      }, 50);
    }
    if (tabId === "splits" || tabId === "prediction") {
      setTimeout(() => {
        if (window.__travessiaRedrawCharts) window.__travessiaRedrawCharts();
      }, 50);
    }
  }
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => setActiveTab(btn.dataset.tab));
  });
  let initialTab = "overview";
  try {
    const saved = localStorage.getItem("travessiaTab");
    if (saved) initialTab = saved;
  } catch {}
  setActiveTab(initialTab);

  $("progress-pct").textContent = D.current.progressPct + "%";
  $("progress-km").textContent = currentKm + " / " + totalKm + " km";
  $("progress-fill").style.width = D.current.progressPct + "%";

  // --- Prediction model v3 (mirrors prediction_model.py) ---
  const profileFull = D.routeProfileFull || D.routeProfile;
  const P = D.prediction;
  const perf = P.performance || {};
  const sci = P.science || {};
  const caps = sci.caps || {};
  const CAPS = {
    fatiguePerKmMax: caps.fatigue_per_km_max ?? 0.0035,
    decayPer10kmMax: caps.decay_per_10km_after_100_max ?? 0.035,
    climbPrior: caps.climb_sec_per_100m_prior ?? 18,
  };
  const params = {
    basePaceMin: perf.weightedPaceMin || P.basePaceMin,
    climbSecPer100m: P.climbSecPer100m || perf.climbSecPer100m || CAPS.climbPrior,
    fatiguePerKm: perf.fatiguePerKm ?? P.fatigueRatePerKm ?? 0,
    stopProb: perf.stopProbPerKm ?? (perf.stopRatioPct || 0) / 100,
    avgStopSec: perf.medianStopSec ?? perf.avgStopSec ?? (perf.medianStopMin || perf.avgStopMin || 0) * 60,
    nightFactor: perf.nightFactor ?? 1 + (perf.nightSlowdownPct || 0) / 100,
    decayPer10k: perf.decayPer10kmAfter100 ?? 0,
  };

  function isNight(d) {
    const h = d.getHours();
    return h >= 22 || h < 6;
  }

  function scenarioParams(scenario) {
    const mov = perf.movingPaceSec || (perf.weightedPaceMin || P.basePaceMin) * 60 || 700;
    if (scenario === "optimistic") {
      return {
        movingPaceS: perf.optimisticPaceSec || (perf.p25PaceMin || 0) * 60 || mov * 0.92,
        fatiguePerKm: Math.min(CAPS.fatiguePerKmMax, params.fatiguePerKm * 0.55),
        stopProb: Math.min(0.25, params.stopProb * 0.75),
        avgStopS: params.avgStopSec * 0.85,
        nightFactor: 1 + (params.nightFactor - 1) * 0.6,
        decayPer10k: params.decayPer10k * 0.6,
      };
    }
    if (scenario === "pessimistic") {
      return {
        movingPaceS: perf.pessimisticPaceSec || (perf.p75PaceMin || 0) * 60 || mov * 1.12,
        fatiguePerKm: Math.min(CAPS.fatiguePerKmMax, params.fatiguePerKm * 1.35),
        stopProb: Math.min(0.25, params.stopProb * 1.35),
        avgStopS: (perf.avgStopSec || params.avgStopSec) * 1.15,
        nightFactor: Math.max(params.nightFactor, 1.05),
        decayPer10k: CAPS.decayPer10kmMax * 0.6,
      };
    }
    return {
      movingPaceS: mov,
      fatiguePerKm: params.fatiguePerKm,
      stopProb: params.stopProb,
      avgStopS: params.avgStopSec,
      nightFactor: params.nightFactor,
      decayPer10k: 0,
    };
  }

  function paceForKm(km, crossing, scenario, floorKmRef) {
    const p = scenarioParams(scenario);
    const ahead = km - floorKmRef;
    const seg = profileFull[km - 1] || { gain: 0, loss: 0 };
    let fatigueMult = Math.min(1.4, 1 + p.fatiguePerKm * ahead);
    if (scenario === "pessimistic" && km > 100 && p.decayPer10k > 0) {
      const bands = Math.min(12, (km - 100) / 10);
      fatigueMult = Math.min(1.55, fatigueMult * (1 + p.decayPer10k * 0.15 * bands));
    }
    const climb = params.climbSecPer100m;
    const terrain = climb * ((seg.gain || 0) / 100) - 0.25 * climb * ((seg.loss || 0) / 100);
    let paceS = (1 - p.stopProb) * p.movingPaceS * fatigueMult + p.stopProb * p.avgStopS + terrain;
    if (isNight(crossing)) paceS *= p.nightFactor;
    return Math.min(Math.max(paceS, p.movingPaceS * 0.85), p.movingPaceS * 3);
  }

  function projectionAnchor() {
    const projKm = P.projectionKm != null ? P.projectionKm : currentKm;
    const projStr =
      P.projectionTime ||
      (D.live && D.live.gpsTime) ||
      D.current.lastCrossing;
    const projTime = new Date(String(projStr).replace(" ", "T"));
    const floorKm = Math.floor(projKm);
    return { projKm, projTime, floorKm };
  }

  function predictFinish(scenario) {
    let cum = 0;
    const forecast = [];
    const { projKm, projTime, floorKm } = projectionAnchor();
    let t = projTime;
    const remainingKm = Math.max(0, totalKm - projKm);
    let nightKm = 0;
    let climbSecTotal = 0;
    const sc = scenario || "main";

    const nextKm = Math.floor(projKm) + 1;
    if (nextKm <= Math.floor(totalKm)) {
      const distKm = nextKm - projKm;
      if (distKm > 1e-6) {
        const paceS = paceForKm(nextKm, t, sc, floorKm);
        cum += paceS * distKm;
        t = new Date(projTime.getTime() + cum * 1000);
      }
    }

    for (let km = nextKm + 1; km <= Math.floor(totalKm); km++) {
      const ahead = km - floorKm;
      const paceS = paceForKm(km, t, sc, floorKm);
      cum += paceS;
      if (isNight(t)) nightKm += 1;
      const seg = profileFull[km - 1] || { gain: 0, loss: 0 };
      climbSecTotal += params.climbSecPer100m * ((seg.gain || 0) / 100);
      t = new Date(projTime.getTime() + cum * 1000);
      if (ahead % 5 === 0 || km === Math.floor(totalKm)) {
        forecast.push({ km, paceMin: paceS / 60, gain: seg.gain || 0 });
      }
    }
    const hours = cum / 3600;
    return {
      finish: t,
      hours,
      days: hours / 24,
      forecast,
      stats: {
        remainingKm,
        avgPaceMin: remainingKm > 0 ? cum / 60 / remainingKm : 0,
        kmPerDay: hours > 0 ? remainingKm / (hours / 24) : 0,
        kmPerHour: hours > 0 ? remainingKm / hours : 0,
        nightKm,
        nightKmPct: remainingKm > 0 ? (nightKm / remainingKm) * 100 : 0,
        climbSecTotal,
        climbMinPerKm: remainingKm > 0 ? climbSecTotal / 60 / remainingKm : 0,
      },
    };
  }

  function fmtPaceMin(min) {
    if (!Number.isFinite(min) || min <= 0) return "—";
    const m = Math.floor(min);
    const s = Math.round((min - m) * 60);
    return m + ":" + String(s).padStart(2, "0") + "/km";
  }

  function fmtNum(n, d) {
    return Number.isFinite(n) ? n.toFixed(d) : "—";
  }

  function updateOverviewStats(mainFinish) {
    const g = D.event && D.event.goal;
    const mov = perf.weightedPaceMin || P.movingPaceMin || P.basePaceMin;
    const main = mainFinish || predictFinish("main");
    const clockProj = main.stats.avgPaceMin;
    const clockReqStr = g?.requiredClockPaceCalendar || g?.requiredPaceCalendar;
    const reqKmDay = g?.kmPerDayCalendar;
    const projKmDay = main.stats.kmPerDay;
    const gapKmDay = reqKmDay != null && projKmDay != null ? projKmDay - reqKmDay : null;

    const kmEl = $("stat-km");
    if (kmEl) {
      kmEl.querySelector(".value").textContent = currentKm + " km";
      kmEl.querySelector(".sub").textContent = "Último split: km " + currentKm;
    }
    const remEl = $("stat-remain");
    if (remEl) {
      remEl.querySelector(".value").textContent = D.current.remainingKm + " km";
      remEl.querySelector(".sub").textContent = "Faltam percorrer";
    }
    const elEl = $("stat-elapsed");
    if (elEl) {
      elEl.querySelector(".value").textContent = D.current.elapsed;
      elEl.querySelector(".sub").textContent = "Desde as 11:00";
    }
    const paceEl = $("stat-pace");
    if (paceEl) {
      paceEl.querySelector(".value").textContent = fmtPaceMin(mov);
      paceEl.querySelector(".sub").textContent =
        "Só km em movimento · global corrido " + fmtPaceMin(perf.overallPaceMin);
    }
    const goalEl = $("stat-goal");
    if (goalEl && g) {
      goalEl.querySelector(".value").textContent =
        fmtNum(projKmDay, 1) + " vs " + fmtNum(reqKmDay, 1) + " km/dia";
      const gapTxt =
        gapKmDay != null
          ? (gapKmDay >= 0 ? "+" : "") + fmtNum(gapKmDay, 1) + " km/dia · "
          : "";
      goalEl.querySelector(".sub").textContent =
        gapTxt +
        "Relógio previsto " +
        fmtPaceMin(clockProj) +
        " · orçamento 31/05 " +
        (clockReqStr || "—");
    }
  }

  function fmtHM(mins) {
    const m = Math.abs(mins);
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return (mins < 0 ? "−" : "+") + h + "h" + (mm ? " " + mm + "m" : "");
  }

  function marginMinutes(deadlineStr, finishDt) {
    return Math.round(
      (new Date(deadlineStr.replace(" ", "T")) - finishDt) / 60000
    );
  }

  function probFromMargin(marginMin, scaleMin) {
    return 1 / (1 + Math.exp((-marginMin / scaleMin) * 4));
  }

  function confidenceLevel(pct) {
    if (pct >= 65) return "high";
    if (pct >= 35) return "mid";
    return "low";
  }

  function confidenceLabel(pct) {
    if (pct >= 65) return "Boa confiança";
    if (pct >= 35) return "Confiança moderada";
    return "Baixa confiança";
  }

  function requiredKmPerDay(deadlineStr, remainingKm) {
    const dl = new Date(deadlineStr.replace(" ", "T"));
    const hoursLeft = (dl - new Date()) / 3600000;
    if (hoursLeft <= 0 || !remainingKm) return null;
    return remainingKm / (hoursLeft / 24);
  }

  function computeGoalConfidence(opts) {
    const { deadlineStr, referenceKm, requiredPaceStr, requiredKmDay, finishes } = opts;
    const mOpt = marginMinutes(deadlineStr, finishes.optimistic.finish);
    const mMain = marginMinutes(deadlineStr, finishes.main.finish);
    const mPes = marginMinutes(deadlineStr, finishes.pessimistic.finish);

    const proven = provenPaceStats();
    const projectedKmDay = finishes.main?.stats?.kmPerDay;
    const demonstratedCandidates = [
      proven.kmDay40,
      proven.kmDayGlobal,
      projectedKmDay,
    ].filter((v) => v != null && Number.isFinite(v) && v > 0);
    const demonstrated =
      demonstratedCandidates.length > 0
        ? Math.min(...demonstratedCandidates)
        : null;
    const reqKmDay = requiredKmDay;

    let pct;

    if (mPes >= 720) {
      pct = 92 + Math.min(5, Math.floor((mPes - 720) / 360));
    } else if (mPes >= 360) {
      pct = 86 + Math.min(6, Math.floor((mPes - 360) / 60));
    } else if (mPes >= 180) {
      pct = 78 + Math.min(8, Math.floor((mPes - 180) / 30));
    } else if (mPes >= 60) {
      pct = 68 + Math.min(10, Math.floor((mPes - 60) / 12));
    } else if (mPes >= 0) {
      pct = 58 + Math.min(10, Math.floor(mPes / 6));
    } else if (mPes >= -180) {
      pct = 42 + Math.min(18, Math.floor((mMain + 180) / 25));
    } else if (mPes >= -720) {
      pct = 22 + Math.min(22, Math.floor((mMain + 360) / 30));
    } else if (mMain >= 0) {
      pct = 36 + Math.min(22, Math.floor(mMain / 12));
    } else {
      pct = 8 + Math.min(14, Math.floor(Math.max(0, mMain + 720) / 90));
    }

    if (demonstrated != null && reqKmDay != null && reqKmDay > 0) {
      const demoRatio = demonstrated / reqKmDay;
      if (mPes >= 0) {
        if (demoRatio >= 1.2) pct += 6;
        else if (demoRatio >= 1.05) pct += 3;
        else if (demoRatio >= 0.92) pct += 0;
        else if (demoRatio >= 0.8) pct -= 8;
        else pct -= 18;
      } else if (mPes >= -360) {
        if (demoRatio >= 1.15) pct += 3;
        else if (demoRatio < 0.9) pct -= 10;
      } else {
        if (demoRatio < 1.0) pct -= 12;
      }
    }

    const reqSec = requiredPaceStr ? parsePaceStr(requiredPaceStr) : null;
    const projClockMin = finishes.main?.stats?.avgPaceMin;
    const projSec = projClockMin != null ? projClockMin * 60 : null;
    if (reqSec && projSec) {
      const headroom = (reqSec - projSec) / reqSec;
      if (headroom > 0.08) pct += 6;
      else if (headroom > 0.02) pct += 3;
      else if (headroom < -0.08) pct -= Math.min(18, Math.round(-headroom * 35));
    }

    if (
      mPes >= 0 &&
      mMain >= 0 &&
      demonstrated != null &&
      reqKmDay != null &&
      demonstrated >= reqKmDay * 1.05
    ) {
      const floorDemo =
        52 +
        Math.min(28, Math.floor(mMain / 15) + (demonstrated / reqKmDay - 1) * 22);
      pct = Math.max(pct, floorDemo);
    }

    if (mPes < 0) {
      let cap = 72;
      if (mPes < -180) cap = mMain >= 0 ? 65 : 50;
      if (mPes < -720) cap = mMain >= 0 ? 58 : 40;
      if (mPes < -1200) cap = mMain >= 0 ? 52 : 34;
      if (mMain < 0) cap = Math.min(cap, 30);
      pct = Math.min(pct, cap);
    }

    if (mPes < 180 && perf.stopRatioPct > 12) {
      pct -= Math.min(8, Math.round((perf.stopRatioPct - 12) * 1.2));
    }

    pct = Math.round(Math.max(5, Math.min(92, pct)));

    const factors = [
      {
        k: "Cenário pessimista",
        v: fmtHM(mPes) + " vs prazo",
        cls: mPes >= 180 ? "good" : mPes >= 0 ? "warn" : "bad",
      },
      {
        k: "Cenário principal",
        v: fmtHM(mMain) + " vs prazo",
        cls: mMain >= 0 ? "good" : mMain >= -180 ? "warn" : "bad",
      },
    ];

    if (demonstrated != null && reqKmDay != null) {
      const demoRatio = demonstrated / reqKmDay;
      factors.push({
        k: "Km/dia (conservador) vs meta",
        v:
          fmtNum(demonstrated, 1) +
          " km/dia vs " +
          fmtNum(reqKmDay, 1) +
          " necessários (" +
          (demoRatio >= 1 ? "+" : "") +
          Math.round((demoRatio - 1) * 100) +
          "%)",
        cls: demoRatio >= 1.1 ? "good" : demoRatio >= 0.9 ? "warn" : "bad",
      });
    }

    if (reqSec && projSec) {
      const gapPct = Math.round(((projSec - reqSec) / reqSec) * 100);
      factors.push({
        k: "Ritmo de relógio (previsão vs orçamento)",
        v:
          fmtPaceMin(projClockMin) +
          " vs " +
          requiredPaceStr +
          (gapPct ? ` (${gapPct > 0 ? "+" : ""}${gapPct}% mais lento)` : ""),
        cls: gapPct <= 3 ? "good" : gapPct <= 12 ? "warn" : "bad",
      });
    }

    if (referenceKm != null) {
      const kmAhead = currentKm - referenceKm;
      factors.push({
        k: "Posição no percurso",
        v: (kmAhead >= 0 ? "+" : "") + kmAhead.toFixed(1) + " km vs ritmo alvo",
        cls: kmAhead >= 5 ? "good" : kmAhead >= -5 ? "warn" : "bad",
      });
    }

    let verdictSub;
    if (pct >= 80) {
      verdictSub =
        mPes >= 0
          ? "Até no pior cenário ainda chegas com folga ao prazo."
          : "Cenário principal a tempo, mas o pessimista falha o prazo — incerteza relevante.";
    } else if (pct >= 60) {
      verdictSub =
        "Boa probabilidade para um amador nesta distância, com alguma incerteza em fadiga ou paragens.";
    } else if (pct >= 40) {
      verdictSub = "Possível, mas é preciso manter ritmo e evitar atrasos longos.";
    } else {
      verdictSub = "Risco elevado: ritmo demonstrado ou cenários abaixo do necessário.";
    }

    return {
      pct,
      level: confidenceLevel(pct),
      label: confidenceLabel(pct),
      verdictSub,
      factors,
      margins: { opt: mOpt, main: mMain, pes: mPes },
    };
  }

  function parsePaceStr(s) {
    const m = String(s).match(/(\d+):(\d+)\/km/);
    return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
  }

  function renderConfidenceCard(prefix, conf, deadlineLabel) {
    const ring = $(prefix + "-ring");
    if (ring) ring.dataset.level = conf.level;
    const pctEl = $(prefix + "-pct");
    if (pctEl) pctEl.textContent = conf.pct + "%";
    const verdict = $(prefix + "-verdict");
    if (verdict) verdict.textContent = conf.label;
    const sub = $(prefix + "-verdict-sub");
    if (sub) sub.textContent = conf.verdictSub;
    const meter = $(prefix + "-meter");
    if (meter) meter.style.width = conf.pct + "%";
    const dl = $(prefix + "-deadline");
    if (dl) dl.textContent = deadlineLabel;
    const factorsEl = $(prefix + "-factors");
    if (factorsEl) {
      factorsEl.innerHTML = conf.factors
        .map((f) => `<li><span class="k">${f.k}</span><span class="v ${f.cls || ""}">${f.v}</span></li>`)
        .join("");
    }
  }

  function provenPaceStats() {
    const start = new Date((D.event.startTime || D.current.lastCrossing).replace(" ", "T"));
    const lastCross = new Date(D.current.lastCrossing.replace(" ", "T"));
    const elapsedH = (lastCross - start) / 3600000;
    let kmAt40 = null;
    for (const s of D.splits || []) {
      if (s.unavailable || s.partial || !s.crossing_time) continue;
      const h = (new Date(s.crossing_time.replace(" ", "T")) - start) / 3600000;
      if (h <= 40) kmAt40 = s.km;
    }
    return {
      kmDayGlobal: elapsedH > 0 ? currentKm / (elapsedH / 24) : null,
      kmAt40,
      kmDay40: kmAt40 != null ? (kmAt40 / 40) * 24 : null,
      weightedKmDay: params.basePaceMin > 0 ? (24 * 60) / params.basePaceMin : null,
    };
  }

  function buildMainScenarioDetail(main) {
    const g = D.event.goal;
    const st = main.stats;
    const mainP = scenarioParams("main");
    const proven = provenPaceStats();
    const reqKmDayCal = g?.kmPerDayCalendar;
    const gapCal = reqKmDayCal != null && st.kmPerDay != null ? st.kmPerDay - reqKmDayCal : null;
    const mCal = g?.calendarDeadline ? marginMinutes(g.calendarDeadline, main.finish) : null;
    const mRec = g?.recordDeadlineFromStart ? marginMinutes(g.recordDeadlineFromStart, main.finish) : null;
    return {
      proven,
      gapCal,
      reqKmDayCal,
      blocks: [
        {
          title: "O que já demonstrou (GPS)",
          rows: [
            ["Média global", fmtNum(proven.kmDayGlobal, 1) + " km/dia"],
            ["Primeiras ~40 h", fmtNum(proven.kmAt40, 0) + " km · " + fmtNum(proven.kmDay40, 1) + " km/dia"],
            ["Ritmo recente", fmtPaceMin(params.basePaceMin) + " ≈ " + fmtNum(proven.weightedKmDay, 1) + " km/dia"],
            ["Meta 31/05", (reqKmDayCal || "—") + " km/dia"],
          ],
        },
        {
          title: "Projectado (cenário principal v3)",
          rows: [
            ["Km/dia à frente", fmtNum(st.kmPerDay, 1) + " km/dia"],
            ["Ritmo médio efectivo", fmtPaceMin(st.avgPaceMin)],
            ["Chegada", main.finish.toLocaleString("pt-PT", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })],
            ["vs 31/05", mCal != null ? fmtHM(mCal) : "—"],
            ["vs record", mRec != null ? fmtHM(mRec) : "—"],
          ],
        },
        {
          title: "Parâmetros medidos",
          rows: [
            ["Paragens", (mainP.stopProb * 100).toFixed(1) + "% × " + fmtNum(mainP.avgStopS / 60, 0) + " min (mediana)"],
            ["Fadiga", (mainP.fatiguePerKm * 100).toFixed(3) + "%/km (cap lit. " + (CAPS.fatiguePerKmMax * 100).toFixed(2) + "%)"],
            ["Noite", "×" + fmtNum(mainP.nightFactor, 2)],
            ["Subida", params.climbSecPer100m + " s/100m D+"],
          ],
        },
      ],
      sampleRows: (main.forecast || []).slice(0, 8).map((f) => `<tr><td>${f.km}</td><td>${fmtPaceMin(f.paceMin)}</td><td>${f.gain || 0} m</td></tr>`).join(""),
    };
  }

  function renderMainScenarioDetail(main) {
    const panel = $("conf-main-detail");
    if (!panel) return;
    const { blocks, sampleRows, proven, gapCal, reqKmDayCal } = buildMainScenarioDetail(main);
    panel.innerHTML = `<h3>Cenário principal — modelo v3</h3>
      <p class="chart-caption conf-callout">Calibrado no percurso do Nuno (${fmtNum(proven.kmDay40, 0)} km/dia nas primeiras 40 h). Projecta <strong>${fmtNum(main.stats.kmPerDay, 1)} km/dia</strong> — meta 31/05: ${reqKmDayCal} km/dia (${gapCal >= 0 ? "+" : ""}${fmtNum(gapCal, 1)} km/dia).</p>
      <p class="chart-caption">E[min/km] = (1−p_paragem)×ritmo×fadiga×noite + p_paragem×duração + subida. Sem penalização fixa de sono.</p>
      <div class="conf-detail-grid">${blocks.map((b) => `<div class="conf-detail-block"><h4>${b.title}</h4><ul class="conf-detail-rows">${b.rows.map(([k,v]) => `<li><span class="k">${k}</span><span class="v">${v}</span></li>`).join("")}</ul></div>`).join("")}</div>
      <details class="conf-detail-sample"><summary>Ritmo de 5 em 5 km</summary><table><thead><tr><th>Km</th><th>Ritmo</th><th>D+</th></tr></thead><tbody>${sampleRows}</tbody></table></details>`;
  }

  function renderInsightPanels() {
    const perfEl = $("perf-stats");
    const sciEl = $("science-stats");
    const refsEl = $("science-refs");
    if (!perfEl || !sciEl) return;
    perfEl.innerHTML = [
      ["Ritmo ponderado", (perf.weightedPaceMin || "—") + " min/km"],
      ["Mediana movimento", (perf.medianPaceMin || "—") + " min/km"],
      ["P25–P75", (perf.p25PaceMin || "—") + " – " + (perf.p75PaceMin || "—")],
      ["Paragens", (perf.stopRatioPct || "—") + "% · mediana " + (perf.medianStopMin || perf.avgStopMin || "—") + " min"],
      ["Fadiga medida", ((perf.fatiguePerKm || 0) * 100).toFixed(3) + "%/km"],
      ["Noite", "+" + (perf.nightSlowdownPct || 0) + "%"],
      ["Subida", (perf.climbSecPer100m || P.climbSecPer100m) + " s/100m D+"],
    ].map(([k, v]) => `<li><span>${k}</span><span>${v}</span></li>`).join("");
    sciEl.innerHTML = [
      ["Cap fadiga", (CAPS.fatiguePerKmMax * 100).toFixed(2) + "%/km"],
      ["Cap decaimento >100 km", (CAPS.decayPer10kmMax * 100).toFixed(1) + "%/10 km"],
      ["Subida prior (Minetti)", CAPS.climbPrior + " s/100m"],
    ].map(([k, v]) => `<li><span>${k}</span><span>${v}</span></li>`).join("");
    if (refsEl && sci.sources) {
      refsEl.innerHTML = sci.sources
        .map((s) => {
          const t = s.title || s.id;
          const link = s.url ? `<a href="${s.url}" target="_blank" rel="noopener noreferrer">${t}</a>` : `<strong>${t}</strong>`;
          return `<li>${link}: ${s.note}</li>`;
        })
        .join("");
    }
    const desc = $("model-desc");
    if (desc) {
      desc.innerHTML = `<strong>${P.model || "Modelo v3"}</strong> (v${P.modelVersion || 3}). ${(P.modelParams && P.modelParams.description) || ""} Fontes com links abaixo.`;
    }
  }

  function fmtFinishDate(dt) {
    if (!dt || !(dt instanceof Date) || Number.isNaN(dt.getTime())) return "—";
    try {
      const datePart = dt.toLocaleDateString("pt-PT", {
        weekday: "long",
        day: "numeric",
        month: "long",
      });
      const timePart = dt.toLocaleTimeString("pt-PT", {
        hour: "2-digit",
        minute: "2-digit",
      });
      return datePart.charAt(0).toUpperCase() + datePart.slice(1) + " · " + timePart;
    } catch {
      return String(dt).replace("T", " · ");
    }
  }

  function renderFinishHero(finishes, g) {
    if (!$("conf-finish-hero") || !finishes?.main) return;
    const main = finishes.main;
    const opt = finishes.optimistic;
    const pes = finishes.pessimistic;
    const mCal = marginMinutes(g.calendarDeadline, main.finish);
    const mRec = marginMinutes(g.recordDeadlineFromStart, main.finish);

    $("conf-finish-main").textContent = fmtFinishDate(main.finish);
    $("conf-finish-sub").textContent =
      "~" +
      fmtNum(main.hours, 1) +
      " h restantes (" +
      fmtNum(main.days, 1) +
      " dias) · km " +
      currentKm +
      " / " +
      totalKm;

    $("conf-finish-hours").textContent =
      fmtNum(main.hours, 1) + " h · " + fmtNum(main.days, 1) + " dias";
    $("conf-finish-kmday").textContent = fmtNum(main.stats.kmPerDay, 1) + " km/dia";
    $("conf-finish-range").textContent =
      fmtFinishDate(opt.finish) + " → " + fmtFinishDate(pes.finish);

    const marginsEl = $("conf-finish-margins");
    if (marginsEl) {
      const calClass = mCal >= 0 ? "" : mCal >= -180 ? "warn" : "bad";
      const recClass = mRec >= 0 ? "" : mRec >= -180 ? "warn" : "bad";
      marginsEl.innerHTML =
        'Margem vs <strong>31/05</strong>: <span class="' +
        calClass +
        '">' +
        fmtHM(mCal) +
        '</span> (principal) · vs <strong>record</strong>: <span class="' +
        recClass +
        '">' +
        fmtHM(mRec) +
        "</span>";
    }
  }

  function updateConfidence() {
    const g = D.event && D.event.goal;
    if (!g) return;
    const finishes = {
      main: predictFinish("main"),
      optimistic: predictFinish("optimistic"),
      pessimistic: predictFinish("pessimistic"),
    };
    renderFinishHero(finishes, g);
    const calConf = computeGoalConfidence({ deadlineStr: g.calendarDeadline, referenceKm: g.calendarPaceNow?.km, requiredPaceStr: g.requiredPaceCalendar, requiredKmDay: g.kmPerDayCalendar, finishes });
    const recConf = computeGoalConfidence({ deadlineStr: g.recordDeadlineFromStart, referenceKm: g.recordPaceNow?.km, requiredPaceStr: g.requiredPaceRecord, requiredKmDay: requiredKmPerDay(g.recordDeadlineFromStart, g.remainingKm), finishes });
    renderConfidenceCard("conf-cal", calConf, "Prazo 31/05 23:59 · " + g.remainingKm + " km restantes");
    renderConfidenceCard("conf-rec", recConf, "Record " + (g.recordCurrent || "") + " · limite " + (g.recordDeadlineFromStart || "").replace(" ", " · "));
    const table = $("conf-scenario-table");
    if (table) {
      const row = (label, a, b) => `<div class="conf-scenario-row"><span>${label}</span><span class="cell ${a >= 0 ? "good" : "bad"}">31/05: ${fmtHM(a)}</span><span class="cell ${b >= 0 ? "good" : "bad"}">Record: ${fmtHM(b)}</span></div>`;
      table.innerHTML = `<div class="conf-scenario-row head"><span>Cenário</span><span>vs 31/05</span><span>vs record</span></div>` + row("Optimista", calConf.margins.opt, recConf.margins.opt) + row("Principal", calConf.margins.main, recConf.margins.main) + row("Pessimista", calConf.margins.pes, recConf.margins.pes);
    }
    renderMainScenarioDetail(finishes.main);
    renderInsightPanels();
    updateOverviewStats(finishes.main);
  }

  try {
    updateConfidence();
  } catch (err) {
    console.error("updateConfidence:", err);
  }

  // --- Charts ---
  function setupCanvas(canvas, height) {
    if (!canvas || !canvas.parentElement) return null;
    const rect = canvas.parentElement.getBoundingClientRect();
    if (!rect.width || rect.width < 80) return null;
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
    const s = setupCanvas(canvas, 220);
    if (!s) return;
    const { ctx, w, h } = s;
    const splits = D.splits.filter((x) => !x.unavailable && !x.partial);
    if (!splits.length) return;
    const pad = { l: 44, r: 16, t: 16, b: 32 };
    const paces = splits.map((x) => x.segment_time_s / 60);
    const sorted = [...paces].sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    const maxP = Math.max(p95 * 1.05, 12);
    const minKm = splits[0].km;
    const maxKm = splits[splits.length - 1].km;

    ctx.fillStyle = "#151920";
    ctx.fillRect(0, 0, w, h);

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
    splits.forEach((seg) => {
      const pace = seg.segment_time_s / 60;
      const x =
        pad.l +
        ((seg.km - minKm) / (maxKm - minKm)) * (w - pad.l - pad.r) -
        barW / 2;
      const bh = (pace / maxP) * (h - pad.t - pad.b);
      const y = h - pad.b - bh;
      ctx.fillStyle = seg.categoryColor || "#3d8bfd";
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
    const s = setupCanvas(canvas, 200);
    if (!s) return;
    const { ctx, w, h } = s;
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

  window.__travessiaRedrawCharts = function () {
    drawPaceChart();
    drawElevChart();
    try {
      updateConfidence();
    } catch (err) {
      console.error("updateConfidence:", err);
    }
  };

  window.__travessiaRedrawCharts();

  window.addEventListener("resize", () => {
    window.__travessiaRedrawCharts();
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
