(function () {
  let D = window.ANALYTICS;
  if (!D) return;

  const $ = (id) => document.getElementById(id);
  let totalKm = D.event.totalKm;
  let currentKm = D.current.km;

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
  updatePageTitle();

  function updatePageTitle() {
    const pct = D.current && D.current.progressPct != null ? D.current.progressPct : 0;
    const km = currentKm != null ? currentKm : 0;
    const total = totalKm != null ? totalKm : 642;
    document.title =
      D.athlete.name +
      " · km " +
      km +
      "/" +
      total +
      " (" +
      pct +
      "%) — Travessia";
  }

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
    if (tabId === "splits" || tabId === "prediction" || tabId === "days") {
      if (tabId === "prediction") {
        try {
          const lc = window.__travessiaLastConf;
          drawConfidenceEvolutionChart(lc && lc.cal, lc && lc.rec);
        } catch (err) {
          console.error("drawConfidenceEvolutionChart:", err);
        }
      }
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

  // --- Prediction model v4 (mirrors prediction_model.py) ---
  let profileFull = D.routeProfileFull || D.routeProfile;
  let P = D.prediction;
  let perf = P.performance || {};
  const V4 = {
    recentBlend: 0.65,
    postStopBlend: 0.78,
    shortHorizonKm: 24,
    staleHours: 3,
    staleCap: 45,
  };
  function getRegimeInfo() {
    return P.regime || {};
  }
  function getRegime() {
    return getRegimeInfo().regime || "normal";
  }

  function updateModelBadge() {
    const el = $("model-version");
    if (!el || !P) return;
    const stale =
      P.dataStaleHours != null && P.dataStaleHours > V4.staleHours
        ? ` · splits há ${fmtNum(P.dataStaleHours, 1)}h`
        : "";
    el.textContent =
      `Previsões: ${P.model || "modelo v4"} (v${P.modelVersion || 4})${stale}`;
  }

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
    const recent = perf.recentPaceSec || mov;
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
      recentPaceS: recent,
      fatiguePerKm: params.fatiguePerKm,
      stopProb: params.stopProb,
      avgStopS: params.avgStopSec,
      nightFactor: params.nightFactor,
      decayPer10k: 0,
    };
  }

  function effectiveMovingPaceS(p, ahead) {
    const globalP = p.movingPaceS;
    const recent = p.recentPaceS || globalP;
    const r = getRegime();
    if (r === "in_long_stop") return globalP;
    if (r === "post_stop") {
      return V4.postStopBlend * recent + (1 - V4.postStopBlend) * globalP;
    }
    if (ahead <= V4.shortHorizonKm) {
      return V4.recentBlend * recent + (1 - V4.recentBlend) * globalP;
    }
    return globalP;
  }

  function paceForKm(km, crossing, scenario, floorKmRef) {
    const p = { ...scenarioParams(scenario) };
    const ahead = km - floorKmRef;
    p.movingPaceS = effectiveMovingPaceS(p, ahead);
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

  function parseFinishDt(isoOrStr) {
    if (!isoOrStr) return null;
    const norm = String(isoOrStr).trim().replace(" ", "T");
    const d = new Date(norm.length <= 16 ? norm + ":00" : norm);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  /** Use server v4 outputs (single source of truth). */
  function finishFromServer(scenario) {
    if ((P.modelVersion || 0) < 4) return null;
    const sc = (P.scenarios && P.scenarios[scenario]) || {};
    let finishStr = P.finishTimeIso || P.finishTime;
    if (scenario === "optimistic") {
      finishStr = P.optimisticFinishIso || P.optimisticFinish;
    } else if (scenario === "pessimistic") {
      finishStr = P.pessimisticFinishIso || P.pessimisticFinish;
    }
    const finish = parseFinishDt(finishStr);
    if (!finish) return null;

    const projKm = P.projectionKm != null ? P.projectionKm : currentKm;
    const remainingKm = Math.max(0, totalKm - projKm);
    const hours = sc.hours ?? P.remainingHours ?? 0;
    const kmPerDay = sc.kmPerDay ?? P.kmPerDayProjected ?? 0;
    const clockMin =
      P.projectedClockPaceMin ??
      (remainingKm > 0 && hours > 0 ? (hours * 60) / remainingKm : null);

    const serverForecast = (P.forecast || [])
      .filter((f) => !f.scenario || f.scenario === scenario)
      .map((f) => ({
        km: f.km,
        paceMin: f.predicted_pace_min,
        gain: f.gain,
      }));

    return {
      finish,
      hours,
      days: hours / 24,
      forecast: serverForecast,
      fromServer: true,
      stats: {
        remainingKm,
        avgPaceMin: clockMin,
        kmPerDay,
        kmPerHour: hours > 0 ? remainingKm / hours : 0,
        nightKm: 0,
        nightKmPct: 0,
        climbSecTotal: 0,
        climbMinPerKm: 0,
      },
    };
  }

  function predictFinish(scenario) {
    const srv = finishFromServer(scenario);
    if (srv) return srv;

    let cum = 0;
    const forecast = [];
    const { projKm, projTime, floorKm } = projectionAnchor();
    if (P.forecastSuspended && scenario === "main") {
      const remainingKm = Math.max(0, totalKm - projKm);
      return {
        finish: projTime,
        hours: 0,
        days: 0,
        forecast: [],
        stats: {
          remainingKm,
          avgPaceMin: 0,
          kmPerDay: 0,
          kmPerHour: 0,
          nightKm: 0,
          nightKmPct: 0,
          climbSecTotal: 0,
          climbMinPerKm: 0,
        },
      };
    }
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
    const recent = perf.recentPaceMin || mov;
    const main = mainFinish || predictFinish("main");
    const clockProj = P.projectedClockPaceMin ?? main.stats.avgPaceMin;
    const clockReqStr = g?.requiredClockPaceCalendar || g?.requiredPaceCalendar;
    const reqKmDay = g?.kmPerDayCalendar;
    const projKmDay = P.kmPerDayProjected ?? main.stats.kmPerDay;
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
        "Recente " +
        fmtPaceMin(perf.recentPaceMin || mov) +
        " · mov. " +
        fmtPaceMin(mov) +
        " · relogio " +
        fmtPaceMin(perf.overallPaceMin);
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

  const HYBRID = {
    modelMin: 0.72,
    modelMax: 1.0,
    regime: { normal: 1, post_stop: 0.94, in_long_stop: 0.88 },
    staleHours: 3,
    dataStaleNoGps: 0.78,
    dataStaleGps: 0.94,
  };

  function modelReliabilityFactor(confidencePct) {
    if (confidencePct == null) return 0.88;
    const pct = Math.max(40, Math.min(92, confidencePct));
    return HYBRID.modelMin + ((pct - 40) / 52) * (HYBRID.modelMax - HYBRID.modelMin);
  }

  function regimeConfidenceFactor(regime, forecastSuspended) {
    let f = HYBRID.regime[regime] != null ? HYBRID.regime[regime] : 1;
    if (forecastSuspended) f = Math.min(f, 0.9);
    return f;
  }

  function dataReliabilityFactor(dataStaleHours, projectionAnchor) {
    if (dataStaleHours == null || dataStaleHours <= HYBRID.staleHours) return 1;
    if (projectionAnchor === "gps_live") return HYBRID.dataStaleGps;
    return HYBRID.dataStaleNoGps;
  }

  function applyGoalConfidenceHybrid(basePct, opts) {
    const modelF = modelReliabilityFactor(opts.modelReliabilityPct);
    const regimeF = regimeConfidenceFactor(opts.regime, opts.forecastSuspended);
    const dataF = dataReliabilityFactor(opts.dataStaleHours, opts.projectionAnchor);
    const pct = Math.round(
      Math.max(5, Math.min(92, basePct * modelF * regimeF * dataF))
    );
    return {
      pct,
      basePct: Math.round(basePct),
      modelReliabilityPct:
        opts.modelReliabilityPct != null ? Math.round(opts.modelReliabilityPct) : null,
      modelFactor: Math.round(modelF * 1000) / 1000,
      regimeFactor: Math.round(regimeF * 1000) / 1000,
      dataFactor: Math.round(dataF * 1000) / 1000,
    };
  }

  function regimeLabel(regime, forecastSuspended) {
    const labels = {
      normal: "Normal",
      post_stop: "Recuperação pós-paragem longa",
      in_long_stop: "Paragem longa activa",
    };
    let t = labels[regime] || regime || "Normal";
    if (forecastSuspended) t += " · previsão km a km suspensa";
    return t;
  }

  function computeGoalConfidence(opts) {
    const {
      deadlineStr,
      referenceKm,
      requiredPaceStr,
      requiredKmDay,
      finishes,
      dataStaleHours,
      projectionAnchor,
      modelReliabilityPct,
      regime,
      forecastSuspended,
    } = opts;
    const mOpt = marginMinutes(deadlineStr, finishes.optimistic.finish);
    const mMain = marginMinutes(deadlineStr, finishes.main.finish);
    const mPes = marginMinutes(deadlineStr, finishes.pessimistic.finish);

    const proven = provenPaceStats();
    const projectedKmDay = finishes.main?.stats?.kmPerDay;
    const demonstratedCandidates = [
      proven.kmDay40,
      proven.recentKmDay,
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

    const basePct = Math.round(Math.max(5, Math.min(92, pct)));
    const hybrid = applyGoalConfidenceHybrid(basePct, {
      modelReliabilityPct: modelReliabilityPct != null ? modelReliabilityPct : P.confidencePct,
      regime: regime || getRegime(),
      forecastSuspended: !!forecastSuspended,
      dataStaleHours,
      projectionAnchor,
    });
    pct = hybrid.pct;

    const factors = [
      {
        k: "Probabilidade face ao prazo (base)",
        v: basePct + "% antes do ajuste v4",
        cls: "warn",
      },
      {
        k: "Ajuste fiabilidade do ritmo",
        v:
          "×" +
          hybrid.modelFactor +
          (hybrid.modelReliabilityPct != null
            ? " (modelo " + hybrid.modelReliabilityPct + "%)"
            : ""),
        cls: hybrid.modelFactor >= 0.95 ? "good" : hybrid.modelFactor >= 0.85 ? "warn" : "bad",
      },
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

    if (perf.recentPaceMin != null) {
      factors.push({
        k: "Ritmo recente (15 km)",
        v:
          fmtPaceMin(perf.recentPaceMin) +
          " vs global " +
          fmtPaceMin(perf.weightedPaceMin),
        cls:
          perf.recentPaceMin <= (perf.weightedPaceMin || 99) * 1.05 ? "good" : "warn",
      });
    }

    if (hybrid.regimeFactor < 1) {
      factors.push({
        k: "Regime v4",
        v: regimeLabel(regime || getRegime(), forecastSuspended) + " ×" + hybrid.regimeFactor,
        cls: "warn",
      });
    }
    if (hybrid.dataFactor < 1) {
      factors.push({
        k: "Frescura dos dados",
        v:
          "×" +
          hybrid.dataFactor +
          (dataStaleHours != null
            ? " · último split há " + fmtNum(dataStaleHours, 1) + " h"
            : ""),
        cls: projectionAnchor === "gps_live" ? "warn" : "bad",
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
      basePct: hybrid.basePct,
      hybrid,
      level: confidenceLevel(pct),
      label: confidenceLabel(pct),
      verdictSub,
      factors,
      margins: { opt: mOpt, main: mMain, pes: mPes },
    };
  }

  function buildModelReliabilityPanel() {
    const pct = P.confidencePct;
    const perfLocal = P.performance || {};
    const factors = [];
    const p25 = perfLocal.p25PaceMin;
    const p75 = perfLocal.p75PaceMin;
    if (p25 != null && p75 != null) {
      const iqr = Math.round((p75 - p25) * 10) / 10;
      factors.push({
        k: "Variabilidade do ritmo (IQR)",
        v: iqr + " min/km",
        cls: iqr <= 4 ? "good" : iqr <= 7 ? "warn" : "bad",
      });
    }
    if (perfLocal.stopRatioPct != null) {
      factors.push({
        k: "Tempo em paragem",
        v: fmtNum(perfLocal.stopRatioPct, 1) + "% do percurso",
        cls:
          perfLocal.stopRatioPct <= 12
            ? "good"
            : perfLocal.stopRatioPct <= 18
              ? "warn"
              : "bad",
      });
    }
    factors.push({
      k: "Regime v4",
      v: regimeLabel(getRegime(), P.forecastSuspended),
      cls: getRegime() === "normal" && !P.forecastSuspended ? "good" : "warn",
    });
    if (P.dataStaleHours != null) {
      factors.push({
        k: "Idade dos splits",
        v:
          fmtNum(P.dataStaleHours, 1) +
          " h · âncora " +
          (P.projectionAnchor || "splits"),
        cls:
          P.dataStaleHours <= HYBRID.staleHours
            ? "good"
            : P.projectionAnchor === "gps_live"
              ? "warn"
              : "bad",
      });
    }
    let desc =
      "Estabilidade do ritmo medido e frescura dos dados — não mede directamente a probabilidade de cumprir 31/05.";
    if (pct != null && pct < 55) {
      desc += " Sinal fraco: os cartões de meta são ajustados para baixo.";
    } else if (
      P.dataStaleHours != null &&
      P.dataStaleHours > HYBRID.staleHours &&
      P.projectionAnchor !== "gps_live"
    ) {
      desc += " Splits antigos sem GPS live: confiança nas metas reduzida.";
    }
    return { pct: pct != null ? Math.round(pct) : null, desc, factors };
  }

  function upsertConfidenceCurvePoint(pts, km, calPct, recPct) {
    const out = pts.filter((p) => p.km !== km);
    out.push({
      km,
      calendarPct: calPct,
      recordPct: recPct,
      isCurrent: true,
    });
    out.sort((a, b) => a.km - b.km);
    return out;
  }

  function drawConfidenceEvolutionChart(calConf, recConf) {
    const canvas = $("chart-conf-evolution");
    const cap = $("conf-evolution-caption");
    const curve = D.confidenceCurve;
    if (!canvas) return;
    if (!curve || !curve.points || !curve.points.length) {
      if (cap) {
        cap.textContent =
          "Sem histórico por km — corre refresh_data.py ou aguarda a próxima actualização completa.";
      }
      return;
    }
    const kmNow =
      P.projectionKm != null ? Math.round(P.projectionKm * 10) / 10 : currentKm;
    let pts = curve.points.slice();
    if (calConf && recConf && calConf.pct != null) {
      pts = upsertConfidenceCurvePoint(pts, Math.round(kmNow), calConf.pct, recConf.pct);
    } else if (curve.current) {
      pts = upsertConfidenceCurvePoint(
        pts,
        curve.current.km,
        curve.current.calendarPct,
        curve.current.recordPct
      );
    }
    const s = setupCanvas(canvas, 220);
    if (!s) return;
    const { ctx, w, h } = s;
    const pad = { l: 44, r: 16, t: 28, b: 32 };
    const plotW = w - pad.l - pad.r;
    const plotH = h - pad.t - pad.b;
    const minKm = pts[0].km;
    const maxKm = Math.max(pts[pts.length - 1].km, kmNow, minKm + 1);

    ctx.fillStyle = "#151920";
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = "#2a3344";
    ctx.lineWidth = 1;
    ctx.font = "10px sans-serif";
    ctx.fillStyle = "#8b95a8";
    for (let pct = 0; pct <= 100; pct += 25) {
      const y = pad.t + (1 - pct / 100) * plotH;
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(w - pad.r, y);
      ctx.stroke();
      ctx.fillText(pct + "%", 6, y + 4);
    }

    const xAt = (km) => pad.l + ((km - minKm) / (maxKm - minKm)) * plotW;
    const yAt = (pct) => pad.t + (1 - pct / 100) * plotH;

    function drawLine(key, color, width) {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      let started = false;
      for (const p of pts) {
        const v = p[key];
        if (v == null) continue;
        const x = xAt(p.km);
        const y = yAt(v);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else ctx.lineTo(x, y);
      }
      if (started) ctx.stroke();
    }

    drawLine("recordPct", "rgba(96, 165, 250, 0.85)", 2);
    drawLine("calendarPct", "rgba(34, 197, 94, 0.95)", 2.5);

    const cx = xAt(kmNow);
    ctx.strokeStyle = "#22c55e";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(cx, pad.t);
    ctx.lineTo(cx, h - pad.b);
    ctx.stroke();
    ctx.setLineDash([]);

    const currentPt = pts.find((p) => p.isCurrent) || pts[pts.length - 1];
    const calNow =
      calConf && calConf.pct != null ? calConf.pct : currentPt.calendarPct;
    const recNow =
      recConf && recConf.pct != null ? recConf.pct : currentPt.recordPct;
    if (calNow != null) {
      ctx.fillStyle = "#22c55e";
      ctx.strokeStyle = "#0f172a";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, yAt(calNow), 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    if (recNow != null) {
      ctx.fillStyle = "#60a5fa";
      ctx.strokeStyle = "#0f172a";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, yAt(recNow), 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    ctx.font = "10px sans-serif";
    ctx.fillStyle = "#8b95a8";
    ctx.fillText("km", w / 2 - 8, h - 6);

    ctx.font = "11px sans-serif";
    ctx.fillStyle = "#22c55e";
    ctx.fillText("■ 31/05", pad.l, 14);
    ctx.fillStyle = "#60a5fa";
    ctx.fillText("■ Record", pad.l + 52, 14);

    if (cap) {
      let txt =
        (curve.label || "") +
        (curve.stepKm ? " Amostra a cada " + curve.stepKm + " km." : "");
      if (calConf && calConf.pct != null) {
        txt +=
          " Ponto km " +
          Math.round(kmNow) +
          ": cartões " +
          calConf.pct +
          "% / record " +
          (recConf && recConf.pct != null ? recConf.pct + "%" : "—") +
          ".";
      }
      cap.textContent = txt;
    }
  }

  function parseDataDate(s) {
    if (!s) return null;
    const d = new Date(String(s).replace(" ", "T"));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function fmtShortWhen(s) {
    const d = parseDataDate(s);
    if (!d) return "—";
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    return dd + "/" + mm + " " + hh + ":" + mi;
  }

  function fmtFinishShort(s) {
    const d = parseDataDate(s);
    if (!d) return "—";
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    return dd + "/" + mm + " " + hh + ":" + mi;
  }

  function renderPredictionEvolutionSummary(ev) {
    const el = $("pred-evolution-summary");
    if (!el) return;
    if (!ev || !ev.ok || !ev.summary) {
      el.innerHTML =
        '<span class="muted">' +
        (ev && ev.label ? ev.label : "Sem histórico — cada refresh completo grava um snapshot.") +
        "</span>";
      return;
    }
    const s = ev.summary;
    const rev = s.revisionTotalMin;
    const revTxt =
      rev == null
        ? "—"
        : rev === 0
          ? "estável"
          : rev > 0
            ? '<span class="warn">+' + Math.round(rev / 60) + "h" + (Math.abs(rev % 60) ? " " + Math.abs(rev % 60) + "m" : "") + " mais tarde</span>"
            : '<span class="good">' + fmtHM(rev) + " mais cedo</span>";
    const marginSwing =
      s.marginSwingMin != null ? fmtHM(s.marginSwingMin).replace("+", "±") : "—";
    el.innerHTML =
      "Desde <strong>" +
      fmtShortWhen(s.firstAt) +
      "</strong> (km " +
      (ev.timeline[0] && ev.timeline[0].km != null ? ev.timeline[0].km : "?") +
      ") a chegada prevista passou de <strong>" +
      fmtFinishShort(s.firstFinish) +
      "</strong> para <strong>" +
      fmtFinishShort(s.currentFinish) +
      "</strong> (" +
      revTxt +
      "). Oscilação de margem ao prazo: " +
      marginSwing +
      '. <span class="muted">' +
      (ev.label || "") +
      "</span>";
  }

  function drawPredictionEvolutionChart(ev) {
    const canvas = $("chart-pred-evolution");
    const cap = $("pred-evolution-caption");
    if (!canvas) return;
    const pts = (ev && ev.timeline) || [];
    if (!pts.length) {
      if (cap) {
        cap.textContent =
          "Sem snapshots — corre refresh_data.py (grava history/predictions.jsonl a cada actualização completa).";
      }
      return;
    }
    const margins = pts
      .map((p) => p.marginMainMin)
      .filter((v) => v != null && Number.isFinite(v));
    if (!margins.length) {
      if (cap) cap.textContent = "Snapshots sem margem ao prazo calculada.";
      return;
    }

    const s = setupCanvas(canvas, 200);
    if (!s) return;
    const { ctx, w, h } = s;
    const pad = { l: 48, r: 16, t: 24, b: 36 };
    const plotW = w - pad.l - pad.r;
    const plotH = h - pad.t - pad.b;

    const minM = Math.min(0, ...margins);
    const maxM = Math.max(0, ...margins);
    const span = Math.max(maxM - minM, 120);
    const yMin = minM - span * 0.08;
    const yMax = maxM + span * 0.08;

    ctx.fillStyle = "#151920";
    ctx.fillRect(0, 0, w, h);

    const xAt = (i) => pad.l + (i / Math.max(1, pts.length - 1)) * plotW;
    const yAt = (m) => pad.t + (1 - (m - yMin) / (yMax - yMin)) * plotH;

    const y0 = yAt(0);
    ctx.strokeStyle = "rgba(248, 113, 113, 0.55)";
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(pad.l, y0);
    ctx.lineTo(w - pad.r, y0);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = "10px sans-serif";
    ctx.fillStyle = "#f87171";
    ctx.fillText("Prazo 31/05", pad.l + 4, y0 - 4);

    ctx.strokeStyle = "#2a3344";
    ctx.fillStyle = "#8b95a8";
    for (let t = Math.ceil(yMin / 120) * 120; t <= yMax; t += 120) {
      const y = yAt(t);
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(w - pad.r, y);
      ctx.stroke();
      ctx.fillText(fmtHM(t), 4, y + 4);
    }

    ctx.strokeStyle = "rgba(250, 204, 21, 0.95)";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    let started = false;
    pts.forEach((p, i) => {
      if (p.marginMainMin == null) return;
      const x = xAt(i);
      const y = yAt(p.marginMainMin);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else ctx.lineTo(x, y);
    });
    if (started) ctx.stroke();

    pts.forEach((p, i) => {
      if (p.marginMainMin == null) return;
      const x = xAt(i);
      const y = yAt(p.marginMainMin);
      const good = p.marginMainMin >= 0;
      ctx.fillStyle = p.isCurrent ? "#facc15" : good ? "#22c55e" : "#f87171";
      ctx.strokeStyle = "#0f172a";
      ctx.lineWidth = p.isCurrent ? 2 : 1.5;
      ctx.beginPath();
      ctx.arc(x, y, p.isCurrent ? 6 : 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    });

    ctx.fillStyle = "#8b95a8";
    ctx.font = "10px sans-serif";
    const tickIdx = [0, Math.floor(pts.length / 2), pts.length - 1];
    tickIdx.forEach((i) => {
      if (!pts[i]) return;
      ctx.fillText(fmtShortWhen(pts[i].recordedAt), xAt(i) - 24, h - 8);
    });

    if (cap) {
      const last = pts[pts.length - 1];
      cap.textContent =
        (ev.label || "") +
        (last && last.marginMainMin != null
          ? " Margem actual: " + fmtHM(last.marginMainMin) + " vs 31/05."
          : "");
    }
  }

  function renderPredictionBacktestTable(ev) {
    const table = $("pred-backtest-table");
    if (!table) return;
    const rows = (ev && ev.backtest) || [];
    if (!rows.length) {
      table.innerHTML =
        '<p class="pred-backtest-empty">Ainda não há snapshots suficientes para backtest.</p>';
      return;
    }
    const head =
      '<div class="pred-backtest-row head"><span>Quando</span><span>Km</span><span>Previsto então</span><span>Previsto agora</span><span>Revisão</span><span>Ritmo real</span></div>';
    const body = rows
      .slice(-10)
      .reverse()
      .map((r) => {
        const rev = r.revisionMin;
        let revCls = "";
        let revTxt = "—";
        if (rev != null) {
          revTxt = fmtHM(rev);
          revCls = rev > 60 ? "bad" : rev < -60 ? "good" : rev > 0 ? "warn" : "good";
        }
        const pace =
          r.actualKmPerDay != null && r.kmSince > 0
            ? r.actualKmPerDay + " km/d"
            : r.kmSince === 0
              ? "parado"
              : "—";
        const paceCls =
          r.actualKmPerDay != null && r.actualKmPerDay >= 74 ? "good" : r.actualKmPerDay != null && r.actualKmPerDay < 65 ? "warn" : "";
        return (
          '<div class="pred-backtest-row">' +
          "<span>" +
          fmtShortWhen(r.recordedAt) +
          "</span>" +
          "<span>" +
          r.kmThen +
          "</span>" +
          "<span>" +
          fmtFinishShort(r.finishThen) +
          "</span>" +
          "<span>" +
          fmtFinishShort(r.finishNow) +
          "</span>" +
          '<span class="cell ' +
          revCls +
          '">' +
          revTxt +
          "</span>" +
          '<span class="cell ' +
          paceCls +
          '">' +
          pace +
          "</span></div>"
        );
      })
      .join("");
    table.innerHTML = head + body;
  }

  function renderPredictionEvolution() {
    const ev = D.predictionEvolution;
    renderPredictionEvolutionSummary(ev);
    drawPredictionEvolutionChart(ev);
    renderPredictionBacktestTable(ev);
  }

  function renderModelReliabilityPanel() {
    const panel = $("conf-model-reliability");
    if (!panel) return;
    const info = buildModelReliabilityPanel();
    const pctEl = $("conf-model-pct");
    if (pctEl) pctEl.textContent = info.pct != null ? info.pct + "%" : "—";
    const descEl = $("conf-model-desc");
    if (descEl) descEl.textContent = info.desc;
    const factorsEl = $("conf-model-factors");
    if (factorsEl) {
      factorsEl.innerHTML = info.factors
        .map(
          (f) =>
            `<li><span class="k">${f.k}</span><span class="v ${f.cls || ""}">${f.v}</span></li>`
        )
        .join("");
    }
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
    const recentMin = perf.recentPaceMin || params.basePaceMin;
    return {
      kmDayGlobal: elapsedH > 0 ? currentKm / (elapsedH / 24) : null,
      kmAt40,
      kmDay40: kmAt40 != null ? (kmAt40 / 40) * 24 : null,
      weightedKmDay: params.basePaceMin > 0 ? (24 * 60) / params.basePaceMin : null,
      recentKmDay: recentMin > 0 ? (24 * 60) / recentMin : null,
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
            [
              "Ritmo recente (15 km)",
              fmtPaceMin(perf.recentPaceMin) +
                " ≈ " +
                fmtNum(proven.recentKmDay, 1) +
                " km/dia",
            ],
            [
              "Ritmo global mov.",
              fmtPaceMin(params.basePaceMin) +
                " ≈ " +
                fmtNum(proven.weightedKmDay, 1) +
                " km/dia",
            ],
            ["Meta 31/05", (reqKmDayCal || "—") + " km/dia"],
          ],
        },
        {
          title: "Projectado (cenário principal v4)",
          rows: [
            ["Km/dia à frente", fmtNum(st.kmPerDay, 1) + " km/dia"],
            ["Ritmo relógio previsto", fmtPaceMin(P.projectedClockPaceMin ?? st.avgPaceMin)],
            ["Ritmo movimento (modelo)", fmtPaceMin(P.movingPaceMin || perf.recentPaceMin)],
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
      sampleRows: (P.forecast || main.forecast || [])
        .filter((f) => f.predicted_pace_min != null || f.paceMin != null)
        .slice(0, 12)
        .map((f) => {
          const pace = f.predicted_pace_min ?? f.paceMin;
          const t = f.predicted_crossing || f.predicted_crossing_iso || "";
          return `<tr><td>${f.km}</td><td>${fmtPaceMin(pace)}</td><td>${t ? t.split(" ")[1] || t : "—"}</td><td>${f.gain || 0} m</td></tr>`;
        })
        .join(""),
    };
  }

  function renderMainScenarioDetail(main) {
    const panel = $("conf-main-detail");
    if (!panel) return;
    const { blocks, sampleRows, proven, gapCal, reqKmDayCal } = buildMainScenarioDetail(main);
    const ri = getRegimeInfo();
    const regimeLine = ri.note
      ? `<p class="chart-caption warn">${ri.note}</p>`
      : "";
    const suspendedLine = P.forecastSuspended
      ? `<p class="chart-caption warn">Previsão km-a-km suspensa — paragem longa em curso.</p>`
      : "";
    panel.innerHTML = `<h3>Cenário principal — modelo v4</h3>
      ${regimeLine}${suspendedLine}
      <p class="chart-caption conf-callout">Calibrado no percurso do Nuno (${fmtNum(proven.kmDay40, 0)} km/dia nas primeiras 40 h). Projecta <strong>${fmtNum(main.stats.kmPerDay, 1)} km/dia</strong> — meta 31/05: ${reqKmDayCal} km/dia (${gapCal >= 0 ? "+" : ""}${fmtNum(gapCal, 1)} km/dia).</p>
      <p class="chart-caption">v4: janela recente 15 km no horizonte curto; paragens ≥60 min; âncora GPS se splits atrasados.</p>
      <div class="conf-detail-grid">${blocks.map((b) => `<div class="conf-detail-block"><h4>${b.title}</h4><ul class="conf-detail-rows">${b.rows.map(([k,v]) => `<li><span class="k">${k}</span><span class="v">${v}</span></li>`).join("")}</ul></div>`).join("")}</div>
      <details class="conf-detail-sample"><summary>Previsão km-a-km (modelo v4)</summary><table><thead><tr><th>Km</th><th>Ritmo</th><th>Hora</th><th>D+</th></tr></thead><tbody>${sampleRows || "<tr><td colspan=\"4\">Sem previsão (paragem ou dados em falta)</td></tr>"}</tbody></table></details>`;
  }

  function renderInsightPanels() {
    const perfEl = $("perf-stats");
    const sciEl = $("science-stats");
    const refsEl = $("science-refs");
    if (!perfEl || !sciEl) return;
    perfEl.innerHTML = [
      ["Ritmo recente (15 km)", (perf.recentPaceMin || "—") + " min/km"],
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
      desc.innerHTML = `<strong>${P.model || "Modelo v4"}</strong> (v${P.modelVersion || 4}). ${(P.modelParams && P.modelParams.description) || ""} Fontes com links abaixo.`;
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
      let regimeNote = "";
      const ri = getRegimeInfo();
      if (ri.note) {
        regimeNote = '<br><span class="warn">' + ri.note + "</span>";
      }
      if (P.forecastSuspended) {
        regimeNote +=
          '<br><span class="warn">Previsao km-a-km suspensa (paragem longa em curso).</span>';
      }
      marginsEl.innerHTML =
        'Margem vs <strong>31/05</strong>: <span class="' +
        calClass +
        '">' +
        fmtHM(mCal) +
        '</span> (principal) · vs <strong>record</strong>: <span class="' +
        recClass +
        '">' +
        fmtHM(mRec) +
        "</span>" +
        regimeNote;
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
    const confOpts = {
      finishes,
      dataStaleHours: P.dataStaleHours,
      projectionAnchor: P.projectionAnchor,
      modelReliabilityPct: P.confidencePct,
      regime: getRegime(),
      forecastSuspended: P.forecastSuspended,
    };
    const calConf = computeGoalConfidence({
      deadlineStr: g.calendarDeadline,
      referenceKm: g.calendarPaceNow?.km,
      requiredPaceStr: g.requiredPaceCalendar,
      requiredKmDay: g.kmPerDayCalendar,
      ...confOpts,
    });
    const recConf = computeGoalConfidence({
      deadlineStr: g.recordDeadlineFromStart,
      referenceKm: g.recordPaceNow?.km,
      requiredPaceStr: g.requiredPaceRecord,
      requiredKmDay: requiredKmPerDay(g.recordDeadlineFromStart, g.remainingKm),
      ...confOpts,
    });
    renderModelReliabilityPanel();
    renderConfidenceCard("conf-cal", calConf, "Prazo 31/05 23:59 · " + g.remainingKm + " km restantes");
    renderConfidenceCard("conf-rec", recConf, "Record " + (g.recordCurrent || "") + " · limite " + (g.recordDeadlineFromStart || "").replace(" ", " · "));
    window.__travessiaLastConf = { cal: calConf, rec: recConf };
    drawConfidenceEvolutionChart(calConf, recConf);
    renderPredictionEvolution();
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
    updateModelBadge();
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

  const elevProfile = () => D.routeProfile || [];
  const DEFAULT_ROUTE_LANDMARKS = [
    { km: 24, name: "Viana do Castelo", major: true },
    { km: 51, name: "Barcelos", major: false },
    { km: 92, name: "Porto", major: true },
    { km: 160, name: "Aveiro", major: true },
    { km: 220, name: "Figueira da Foz", major: false },
    { km: 271, name: "Leiria", major: true },
    { km: 342, name: "Santarém", major: true },
    { km: 479, name: "Grândola", major: false },
    { km: 571, name: "Zambujeira do Mar", major: false },
    { km: 642, name: "Sagres", major: true },
  ];
  function routeLandmarks() {
    return D.routeLandmarks && D.routeLandmarks.length ? D.routeLandmarks : DEFAULT_ROUTE_LANDMARKS;
  }

  /** Só cidades no percurso oficial (snapshot GPS); sem inventar pontos fora da rota. */
  function routeLandmarksForDays() {
    const lms = D.routeLandmarks && D.routeLandmarks.length ? D.routeLandmarks : DEFAULT_ROUTE_LANDMARKS;
    return lms
      .filter((lm) => lm.km != null && (lm.offRouteKm == null || lm.offRouteKm <= 12))
      .slice()
      .sort((a, b) => a.km - b.km);
  }
  let elevShowCities = true;
  try {
    elevShowCities = localStorage.getItem("travessiaElevCities") !== "0";
  } catch {}
  let elevLargeHoverKm = null;
  let elevLargeLayout = null;
  let elevPanCenterKm = null;
  let elevIsDragging = false;
  let elevDragStartClientX = null;
  let elevDragStartCenterKm = null;
  let elevDragStartKmAtX = null;
  const ELEV_X_ZOOM_MIN = 1;
  const ELEV_X_ZOOM_MAX = 24;
  const ELEV_X_ZOOM_MUL = 1.5;
  let elevXZoom = 1;
  try {
    const z = parseFloat(localStorage.getItem("travessiaElevZoomX") || "1");
    if (Number.isFinite(z)) elevXZoom = Math.max(ELEV_X_ZOOM_MIN, Math.min(ELEV_X_ZOOM_MAX, z));
  } catch {}

  function updateElevZoomUI() {
    const el = $("elev-zoom-value");
    if (!el) return;
    el.textContent = Math.round(elevXZoom * 100) + "%";
  }

  function setElevXZoom(next) {
    const clamped = Math.max(ELEV_X_ZOOM_MIN, Math.min(ELEV_X_ZOOM_MAX, next));
    if (Math.abs(clamped - elevXZoom) < 1e-6) return;
    elevXZoom = clamped;
    try {
      localStorage.setItem("travessiaElevZoomX", String(elevXZoom));
    } catch {}
    updateElevZoomUI();
    if ($("elev-modal") && !$("elev-modal").hidden) drawElevChartLarge();
  }

  function citiesForElevChart(large) {
    if (!elevShowCities) return [];
    const all = routeLandmarks();
    return large ? all : all.filter((c) => c.major);
  }

  function nearestLandmark(km, maxDelta) {
    let best = null;
    let bestD = maxDelta;
    for (const c of routeLandmarks()) {
      const d = Math.abs(c.km - km);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  }

  function drawElevCityMarkers(ctx, opts, layout, prof) {
    const cities = citiesForElevChart(opts.large);
    if (!cities.length) return;
    const { pad, w, h, xAtKm, yAtAlt } = layout;
    const plotH = h - pad.t - pad.b;
    let flip = false;
    for (const city of cities) {
      const x = xAtKm(city.km);
      const pt = elevAtKm(city.km, prof);
      const yOn = pt ? yAtAlt(pt.elevation) : pad.t + plotH * 0.35;

      ctx.save();
      ctx.strokeStyle = city.major ? "rgba(148, 163, 184, 0.45)" : "rgba(148, 163, 184, 0.28)";
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 5]);
      ctx.beginPath();
      ctx.moveTo(x, pad.t);
      ctx.lineTo(x, h - pad.b);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();

      const above = flip;
      flip = !flip;
      const fontSize = opts.large ? (city.major ? 11 : 10) : city.major ? 9 : 8;
      ctx.font = (city.major ? "600 " : "") + fontSize + "px sans-serif";
      ctx.fillStyle = city.major ? "#c5cee0" : "#7d8798";
      ctx.textAlign = "center";
      const label = city.name;
      const tw = ctx.measureText(label).width;
      let tx = x;
      if (tx - tw / 2 < pad.l) tx = pad.l + tw / 2 + 2;
      if (tx + tw / 2 > w - pad.r) tx = w - pad.r - tw / 2 - 2;
      const labelY = above ? pad.t + (opts.large ? 14 : 11) : h - pad.b - (opts.large ? 6 : 4);
      ctx.fillText(label, tx, labelY);
      if (opts.large) {
        ctx.font = "9px sans-serif";
        ctx.fillStyle = "#6b7280";
        ctx.fillText("km " + city.km, tx, above ? pad.t + 26 : h - pad.b + 14);
      }
      if (pt && opts.large) {
        ctx.fillStyle = "rgba(196, 206, 224, 0.9)";
        ctx.beginPath();
        ctx.arc(x, yOn, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.textAlign = "left";
  }

  function elevBounds(prof) {
    const alts = prof.map((p) => p.elevation);
    return {
      minA: Math.min(...alts) - 20,
      maxA: Math.max(...alts) + 20,
      maxKm: prof[prof.length - 1].km,
    };
  }

  function elevAtKm(km, prof) {
    if (!prof.length) return null;
    if (km <= prof[0].km) return { ...prof[0], km };
    const last = prof[prof.length - 1];
    if (km >= last.km) return { ...last, km };
    let i = 0;
    while (i < prof.length - 1 && prof[i + 1].km < km) i += 1;
    const a = prof[i];
    const b = prof[i + 1];
    const span = b.km - a.km || 1;
    const t = (km - a.km) / span;
    return {
      km: Math.round(km * 10) / 10,
      elevation: Math.round((a.elevation + t * (b.elevation - a.elevation)) * 10) / 10,
      gain: a.gain,
      loss: a.loss,
    };
  }

  function splitCategoryColorMap() {
    const m = {};
    (D.splits || []).forEach((s) => {
      if (!s || s.unavailable || s.partial) return;
      if (s.km == null) return;
      const k = Math.round(Number(s.km));
      if (!Number.isFinite(k)) return;
      if (s.categoryColor) m[k] = s.categoryColor;
    });
    return m;
  }

  function categoryColorAtKm(km, cmap) {
    const k = Math.round(km);
    return (cmap && cmap[k]) || null;
  }

  function elevKmFromClientX(canvas, clientX, layout) {
    if (!layout) return null;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const { pad, w, minKm, maxKm } = layout;
    const plotW = w - pad.l - pad.r;
    if (x < pad.l || x > pad.l + plotW) return null;
    const t = Math.max(0, Math.min(1, (x - pad.l) / plotW));
    return minKm + t * (maxKm - minKm);
  }

  function drawElevProfile(canvas, height, opts) {
    const prof = elevProfile();
    if (!prof.length || !canvas) return null;
    const s = setupCanvas(canvas, height);
    if (!s) return null;
    const { ctx, w, h } = s;
    const pad = opts.pad || { l: 44, r: 16, t: 16, b: 28 };
    const { minA, maxA, maxKm: fullMaxKm } = elevBounds(prof);
    const plotH = h - pad.t - pad.b;
    const plotW = w - pad.l - pad.r;

    const xZoomFactor = Number.isFinite(opts.xZoomFactor) ? Number(opts.xZoomFactor) : 1;
    const centerKm = opts.zoomCenterKm != null ? Number(opts.zoomCenterKm) : currentKm;
    const fullRangeKm = Math.max(1, fullMaxKm);
    const visibleRangeKm = Math.max(8, Math.min(fullRangeKm, fullRangeKm / Math.max(1, xZoomFactor)));
    let minKm = centerKm - visibleRangeKm / 2;
    let maxKm = centerKm + visibleRangeKm / 2;
    if (minKm < 0) {
      maxKm -= minKm;
      minKm = 0;
    }
    if (maxKm > fullMaxKm) {
      const over = maxKm - fullMaxKm;
      minKm = Math.max(0, minKm - over);
      maxKm = fullMaxKm;
    }
    if (maxKm - minKm < 1) {
      minKm = Math.max(0, maxKm - 1);
    }

    const xAtKm = (km) => pad.l + ((km - minKm) / (maxKm - minKm)) * plotW;
    const yAtAlt = (alt) => pad.t + (1 - (alt - minA) / (maxA - minA)) * plotH;

    ctx.fillStyle = "#151920";
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = "#2a3344";
    ctx.lineWidth = 1;
    const altStep = maxA - minA > 400 ? 100 : maxA - minA > 150 ? 50 : 25;
    for (let a = Math.ceil(minA / altStep) * altStep; a <= maxA; a += altStep) {
      const y = yAtAlt(a);
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(w - pad.r, y);
      ctx.stroke();
      ctx.fillStyle = "#8b95a8";
      ctx.font = (opts.large ? 11 : 10) + "px sans-serif";
      ctx.fillText(a + " m", 6, y + 4);
    }

    if (opts.large && (maxKm - minKm) > 40) {
      const spanKm = maxKm - minKm;
      const kmStep = spanKm > 400 ? 100 : spanKm > 180 ? 50 : spanKm > 80 ? 20 : 10;
      ctx.strokeStyle = "#2a3344";
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.fillStyle = "#8b95a8";
      ctx.font = "10px sans-serif";
      const firstTick = Math.ceil(minKm / kmStep) * kmStep;
      for (let km = firstTick; km <= maxKm; km += kmStep) {
        const x = xAtKm(km);
        ctx.beginPath();
        ctx.moveTo(x, pad.t);
        ctx.lineTo(x, h - pad.b);
        ctx.stroke();
        ctx.fillText(km, x - 8, h - 8);
      }
    }

    const layout = { pad, w, h, minKm, maxKm, minA, maxA, xAtKm, yAtAlt, plotH, plotW };
    drawElevCityMarkers(ctx, opts, layout, prof);

    ctx.beginPath();
    const profInView = prof.filter((p) => p.km >= minKm - 1e-6 && p.km <= maxKm + 1e-6);
    if (!profInView.length) return layout;
    profInView.forEach((p, i) => {
      const x = xAtKm(p.km);
      const y = yAtAlt(p.elevation);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.lineTo(xAtKm(maxKm), h - pad.b);
    ctx.lineTo(pad.l, h - pad.b);
    ctx.closePath();
    ctx.fillStyle = "rgba(61, 139, 253, 0.22)";
    ctx.fill();
    ctx.strokeStyle = "#3d8bfd";
    ctx.lineWidth = opts.large ? 2.5 : 2;
    ctx.stroke();

    // Overlay completed path using pace categories (per km).
    const cmap = splitCategoryColorMap();
    const completedKm = Math.max(0, Math.min(currentKm, fullMaxKm));
    if (completedKm > minKm + 1e-6) {
      const ptsDone = prof.filter((p) => p.km >= minKm - 1e-6 && p.km <= Math.min(maxKm, completedKm) + 1e-6);
      if (ptsDone.length >= 2) {
        const lw = opts.large ? 4 : 3;
        ctx.save();
        ctx.lineWidth = lw;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        for (let i = 0; i < ptsDone.length - 1; i++) {
          const a = ptsDone[i];
          const b = ptsDone[i + 1];
          const midKm = (a.km + b.km) / 2;
          const col = categoryColorAtKm(midKm, cmap);
          if (!col) continue;
          ctx.strokeStyle = col;
          ctx.beginPath();
          ctx.moveTo(xAtKm(a.km), yAtAlt(a.elevation));
          ctx.lineTo(xAtKm(b.km), yAtAlt(b.elevation));
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    const markerKm = opts.hoverKm != null ? opts.hoverKm : currentKm;
    const cx = xAtKm(markerKm);
    const isHover = opts.hoverKm != null;

    if (isHover) {
      const pt = elevAtKm(opts.hoverKm, prof);
      if (pt) {
        const hx = xAtKm(pt.km);
        const hy = yAtAlt(pt.elevation);
        ctx.strokeStyle = "rgba(245, 158, 11, 0.85)";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(hx, pad.t);
        ctx.lineTo(hx, h - pad.b);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "#f59e0b";
        ctx.beginPath();
        ctx.arc(hx, hy, opts.large ? 5 : 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (!isHover || Math.abs(markerKm - currentKm) > 0.5) {
      if (currentKm >= minKm - 1e-6 && currentKm <= maxKm + 1e-6) {
        const nowX = xAtKm(currentKm);
        ctx.strokeStyle = "#22c55e";
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(nowX, pad.t);
        ctx.lineTo(nowX, h - pad.b);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "#22c55e";
        ctx.font = (opts.large ? 11 : 10) + "px sans-serif";
        ctx.fillText(
          "Agora: km " + currentKm,
          Math.min(nowX + 4, w - 96),
          pad.t + 12
        );
      } else if (opts.large) {
        ctx.fillStyle = "#8b95a8";
        ctx.font = "10px sans-serif";
        ctx.fillText("Agora fora do zoom (km " + currentKm + ")", pad.l + 6, pad.t + 12);
      }
    }

    ctx.fillStyle = "#8b95a8";
    ctx.font = (opts.large ? 11 : 10) + "px sans-serif";
    ctx.fillText("km", w / 2 - 8, h - 6);
    if (!opts.large) ctx.fillText("m", 8, pad.t + 10);

    return layout;
  }

  function drawElevChart() {
    drawElevProfile($("chart-elev"), 200, { large: false, showCities: elevShowCities });
  }

  function formatElevTooltip(pt) {
    if (!pt) return "";
    let html =
      "<strong>km " +
      pt.km +
      "</strong> · " +
      fmtNum(pt.elevation, 1) +
      " m";
    if (pt.gain != null || pt.loss != null) {
      html +=
        "<br><span style='opacity:.85'>Δ +" +
        fmtNum(pt.gain || 0, 1) +
        " / −" +
        fmtNum(pt.loss || 0, 1) +
        " m</span>";
    }
    const rem = totalKm - pt.km;
    if (rem > 0) {
      html += "<br><span style='opacity:.75'>" + fmtNum(rem, 1) + " km até à meta</span>";
    }
    const near = nearestLandmark(pt.km, 4);
    if (near) {
      html += "<br><span style='opacity:.9'>Ref.: " + near.name + " (km " + near.km + ")</span>";
    }
    return html;
  }

  function positionElevTooltip(tip, chartEl, clientX, clientY) {
    if (!tip || !chartEl) return;
    const rect = chartEl.getBoundingClientRect();
    let left = clientX - rect.left + 14;
    let top = clientY - rect.top - 12;
    const maxL = rect.width - tip.offsetWidth - 8;
    const maxT = rect.height - tip.offsetHeight - 8;
    left = Math.max(8, Math.min(left, maxL));
    top = Math.max(8, Math.min(top, maxT));
    tip.style.left = left + "px";
    tip.style.top = top + "px";
  }

  function drawElevChartLarge() {
    const canvas = $("chart-elev-large");
    const height = Math.min(480, Math.max(320, Math.floor(window.innerHeight * 0.52)));
    if (elevPanCenterKm == null) elevPanCenterKm = currentKm;
    elevLargeLayout = drawElevProfile(canvas, height, {
      large: true,
      hoverKm: elevLargeHoverKm,
      showCities: elevShowCities,
      xZoomFactor: elevXZoom,
      zoomCenterKm: elevPanCenterKm,
      pad: { l: 52, r: 20, t: 28, b: 40 },
    });
    const meta = $("elev-modal-meta");
    if (meta && elevLargeHoverKm != null) {
      const pt = elevAtKm(elevLargeHoverKm, elevProfile());
      meta.textContent = pt
        ? "km " + pt.km + " · " + fmtNum(pt.elevation, 1) + " m · " + fmtNum(totalKm, 0) + " km total"
        : totalKm + " km · posição actual km " + currentKm;
    } else if (meta) {
      meta.textContent =
        totalKm + " km · posição actual km " + currentKm + " · passe o rato no gráfico";
    }
  }

  function openElevModal() {
    const modal = $("elev-modal");
    if (!modal) return;
    elevLargeHoverKm = null;
    elevPanCenterKm = currentKm;
    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("elev-modal-open");
    const tip = $("elev-tooltip");
    if (tip) tip.hidden = true;
    requestAnimationFrame(() => {
      drawElevChartLarge();
    });
  }

  function closeElevModal() {
    const modal = $("elev-modal");
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    modal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("elev-modal-open");
    elevLargeHoverKm = null;
    const tip = $("elev-tooltip");
    if (tip) tip.hidden = true;
  }

  function onElevLargeMove(ev) {
    const canvas = $("chart-elev-large");
    const chartEl = $("elev-modal-chart");
    const tip = $("elev-tooltip");
    if (!canvas || !chartEl) return;
    if (elevIsDragging) return;
    const km = elevKmFromClientX(canvas, ev.clientX, elevLargeLayout);
    if (km == null) {
      elevLargeHoverKm = null;
      if (tip) tip.hidden = true;
      drawElevChartLarge();
      return;
    }
    elevLargeHoverKm = km;
    drawElevChartLarge();
    const pt = elevAtKm(km, elevProfile());
    if (tip && pt) {
      tip.innerHTML = formatElevTooltip(pt);
      tip.hidden = false;
      positionElevTooltip(tip, chartEl, ev.clientX, ev.clientY);
    }
  }

  function onElevLargeDragStart(ev) {
    const canvas = $("chart-elev-large");
    if (!canvas) return;
    if (ev.button != null && ev.button !== 0) return;
    if (!elevLargeLayout) return;
    const kmAt = elevKmFromClientX(canvas, ev.clientX, elevLargeLayout);
    if (kmAt == null) return;
    elevIsDragging = true;
    elevDragStartClientX = ev.clientX;
    elevDragStartKmAtX = kmAt;
    elevDragStartCenterKm = elevPanCenterKm != null ? elevPanCenterKm : currentKm;
    const tip = $("elev-tooltip");
    if (tip) tip.hidden = true;
    canvas.style.cursor = "grabbing";
  }

  function onElevLargeDragMove(ev) {
    if (!elevIsDragging) return;
    const canvas = $("chart-elev-large");
    if (!canvas || !elevLargeLayout) return;
    const kmNow = elevKmFromClientX(canvas, ev.clientX, elevLargeLayout);
    if (kmNow == null || elevDragStartKmAtX == null) return;
    const deltaKm = kmNow - elevDragStartKmAtX;
    elevPanCenterKm = (elevDragStartCenterKm != null ? elevDragStartCenterKm : currentKm) - deltaKm;
    drawElevChartLarge();
  }

  function onElevLargeDragEnd() {
    if (!elevIsDragging) return;
    elevIsDragging = false;
    elevDragStartClientX = null;
    elevDragStartCenterKm = null;
    elevDragStartKmAtX = null;
    const canvas = $("chart-elev-large");
    if (canvas) canvas.style.cursor = "";
  }

  function setElevShowCities(on) {
    elevShowCities = !!on;
    try {
      localStorage.setItem("travessiaElevCities", on ? "1" : "0");
    } catch {}
    const ids = ["elev-show-cities", "elev-show-cities-modal"];
    ids.forEach((id) => {
      const el = $(id);
      if (el) el.checked = on;
    });
    drawElevChart();
    if ($("elev-modal") && !$("elev-modal").hidden) drawElevChartLarge();
  }

  function initElevCitiesToggle() {
    const ids = ["elev-show-cities", "elev-show-cities-modal"];
    ids.forEach((id) => {
      const el = $(id);
      if (!el) return;
      el.checked = elevShowCities;
      el.addEventListener("change", () => setElevShowCities(el.checked));
    });
  }
  initElevCitiesToggle();

  function initElevModal() {
    const box = $("chart-elev-box");
    const modal = $("elev-modal");
    const largeCanvas = $("chart-elev-large");
    const closeBtn = $("elev-modal-close");

    if (box) {
      box.addEventListener("click", (ev) => {
        if (ev.target.closest("a") || ev.target.closest(".elev-cities-toggle")) return;
        openElevModal();
      });
      box.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          openElevModal();
        }
      });
    }
    closeBtn?.addEventListener("click", closeElevModal);
    modal?.querySelectorAll("[data-elev-close]").forEach((el) => {
      el.addEventListener("click", closeElevModal);
    });

    updateElevZoomUI();
    $("elev-zoom-in")?.addEventListener("click", (ev) => {
      ev.preventDefault();
      setElevXZoom(elevXZoom * ELEV_X_ZOOM_MUL);
    });
    $("elev-zoom-out")?.addEventListener("click", (ev) => {
      ev.preventDefault();
      setElevXZoom(elevXZoom / ELEV_X_ZOOM_MUL);
    });

    largeCanvas?.addEventListener("mousemove", (ev) => {
      if (elevIsDragging) onElevLargeDragMove(ev);
      else onElevLargeMove(ev);
    });
    largeCanvas?.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      onElevLargeDragStart(ev);
    });
    window.addEventListener("mouseup", onElevLargeDragEnd);
    largeCanvas?.addEventListener(
      "wheel",
      (ev) => {
        ev.preventDefault();
        if (ev.deltaY < 0) setElevXZoom(elevXZoom * ELEV_X_ZOOM_MUL);
        else setElevXZoom(elevXZoom / ELEV_X_ZOOM_MUL);
      },
      { passive: false }
    );
    largeCanvas?.addEventListener("mouseleave", () => {
      onElevLargeDragEnd();
      elevLargeHoverKm = null;
      const tip = $("elev-tooltip");
      if (tip) tip.hidden = true;
      drawElevChartLarge();
    });
    window.addEventListener("keydown", (ev) => {
      const modalEl = $("elev-modal");
      if (!modalEl || modalEl.hidden) return;
      if (ev.key === "Escape") closeElevModal();
      if (ev.key === "+" || ev.key === "=") {
        ev.preventDefault();
        setElevXZoom(elevXZoom * ELEV_X_ZOOM_MUL);
      } else if (ev.key === "-") {
        ev.preventDefault();
        setElevXZoom(elevXZoom / ELEV_X_ZOOM_MUL);
      }
    });
    window.addEventListener("resize", () => {
      if ($("elev-modal") && !$("elev-modal").hidden) drawElevChartLarge();
    });
  }
  initElevModal();

  function fmtDayRange(start, end) {
    if (!start) return "—";
    const a = start.replace(" ", " · ");
    if (!end) return a + " → …";
    const d0 = start.slice(0, 10);
    const d1 = end.slice(0, 10);
    if (d0 === d1) {
      return d0 + " · " + start.split(" ")[1] + "–" + end.split(" ")[1];
    }
    return start.split(" ")[0] + " " + start.split(" ")[1] + " → " + end.split(" ")[0] + " " + end.split(" ")[1];
  }

  function getDaysPayload() {
    if (D.days && Array.isArray(D.days.days)) return D.days;
    return { days: [], nightStops: [], method: "", longStopThresholdMin: 60 };
  }

  function daysShowPredicted() {
    const predToggle = $("days-toggle-pred");
    let show = !!(predToggle && predToggle.checked);
    try {
      if (predToggle && !predToggle.dataset.initDone) {
        const saved = localStorage.getItem("travessiaDaysShowPred");
        predToggle.checked = saved === "1";
        predToggle.dataset.initDone = "1";
        show = predToggle.checked;
      }
    } catch {}
    return show;
  }

  function fmtDataDateTime(dt) {
    if (!(dt instanceof Date) || Number.isNaN(dt.getTime())) return null;
    const pad2 = (n) => String(n).padStart(2, "0");
    return (
      dt.getFullYear() +
      "-" +
      pad2(dt.getMonth() + 1) +
      "-" +
      pad2(dt.getDate()) +
      " " +
      pad2(dt.getHours()) +
      ":" +
      pad2(dt.getMinutes()) +
      ":" +
      pad2(dt.getSeconds())
    );
  }

  function fmtDurationFromHours(hours) {
    if (!Number.isFinite(hours) || hours <= 0) return "—";
    const mins = Math.max(0, Math.round(hours * 60));
    const hh = Math.floor(mins / 60);
    const mm = mins % 60;
    if (hh) return hh + "h " + (mm ? String(mm).padStart(2, "0") + "m" : "");
    return mm + "m";
  }

  function fmtDurationFromMin(min) {
    if (!Number.isFinite(min) || min <= 0) return "—";
    return fmtDurationFromHours(min / 60);
  }

  function forecastTimelineMain() {
    return (D.prediction?.forecast || [])
      .filter((f) => !f.scenario || f.scenario === "main")
      .map((f) => ({
        km: Number(f.km),
        t: parseDataDate(f.predicted_crossing_iso || f.predicted_crossing),
      }))
      .filter((p) => p.t && Number.isFinite(p.km))
      .sort((a, b) => a.km - b.km);
  }

  function interpForecastTime(km, pts) {
    if (!pts.length) return null;
    const k = Number(km);
    if (k <= pts[0].km) return pts[0].t;
    const last = pts[pts.length - 1];
    if (k >= last.km) return last.t;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      if (a.km <= k && k <= b.km) {
        const span = b.km - a.km;
        if (span <= 1e-6) return a.t;
        const f = (k - a.km) / span;
        return new Date(a.t.getTime() + f * (b.t.getTime() - a.t.getTime()));
      }
    }
    return last.t;
  }

  function interpForecastKmAtTime(dt, pts) {
    if (!dt || !pts.length) return null;
    const t = dt.getTime();
    if (t <= pts[0].t.getTime()) return Math.floor(pts[0].km);
    const last = pts[pts.length - 1];
    if (t >= last.t.getTime()) return Math.floor(last.km);
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const ta = a.t.getTime();
      const tb = b.t.getTime();
      if (ta <= t && t <= tb) {
        const span = tb - ta;
        if (span <= 1) return Math.floor(a.km);
        const f = (t - ta) / span;
        return Math.floor(a.km + f * (b.km - a.km));
      }
    }
    return Math.floor(last.km);
  }

  function avgCompletedDayKm(days) {
    const done = days.filter((d) => !d.inProgress && !d.isPredicted && (d.km || 0) > 0);
    if (!done.length) return 85;
    return done.reduce((s, d) => s + d.km, 0) / done.length;
  }

  /** Máximo de horas em movimento por dia (histórico real, teto 18h). */
  function maxMovingHoursFromHistory(days) {
    const hrs = days
      .filter((d) => !d.isPredicted && Number.isFinite(d.movingHours) && d.movingHours > 0)
      .map((d) => d.movingHours)
      .sort((a, b) => a - b);
    if (!hrs.length) return 18;
    const idx = Math.min(hrs.length - 1, Math.floor(hrs.length * 0.9));
    const p90 = hrs[idx];
    return Math.min(18, Math.max(14, Math.round(p90 * 10) / 10));
  }

  function nearestRouteLandmark(km) {
    const lms = routeLandmarksForDays();
    let best = null;
    let bestD = 1e18;
    for (const lm of lms) {
      const d = Math.abs(lm.km - km);
      if (d < bestD) {
        bestD = d;
        best = lm;
      }
    }
    return best && bestD <= 18 ? best : null;
  }

  /** Maior kmTo (>= fromKm+12) com horas de movimento <= budgetHours (forecast). */
  function kmCapForMovingBudget(fromKm, budgetHours, finishKm, timeline, refPaceMin, opts) {
    const from = Number(fromKm);
    const cap = Math.min(Number(finishKm), from + 130);
    let lo = from + 12;
    let hi = cap;
    const hiStats = movingStatsFromForecast(from, hi, timeline, refPaceMin, opts);
    const hiH =
      hiStats.movingHours != null ? hiStats.movingHours : ((hi - from) * refPaceMin) / 60;
    if (hiH <= budgetHours) return Math.floor(hi);
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      const st = movingStatsFromForecast(from, mid, timeline, refPaceMin, opts);
      const h = st.movingHours != null ? st.movingHours : ((mid - from) * refPaceMin) / 60;
      if (h <= budgetHours) lo = mid;
      else hi = mid;
    }
    return Math.floor(lo);
  }

  function planPredictedDayEnd(params) {
    const {
      fromKm,
      startDt,
      finishKm,
      finishDt,
      timeline,
      refPaceMin,
      maxMovingHours,
      maxDayKm,
      dayNo,
      cal,
    } = params;
    const opts = { segmentStartDt: startDt, finishTimeDt: finishDt };
    const fromK = Math.floor(Number(fromKm));
    const finK = Math.floor(Number(finishKm));
    const toFinish = movingStatsFromForecast(fromK, finK, timeline, refPaceMin, opts);
    if (
      toFinish.movingHours != null &&
      toFinish.movingHours > 0 &&
      toFinish.movingHours <= maxMovingHours * 1.02
    ) {
      const lm =
        pickNightLandmark(fromK, finK, finK, null, { strictMax: false }) ||
        nearestRouteLandmark(finK) || { km: finK, name: "Sagres", major: true };
      const stopLm = {
        km: finK,
        name: lm?.name || "Sagres",
        major: !!lm?.major,
      };
      return {
        kmTo: finK,
        landmark: stopLm,
        stats: toFinish,
        // For chegada, o display e cálculo coincidem.
        eveningDt: finishDt,
        eveningCalcDt: finishDt,
        isFinish: true,
      };
    }

    const capKm = kmCapForMovingBudget(
      fromK,
      maxMovingHours,
      finK,
      timeline,
      refPaceMin,
      opts
    );
    const maxAhead = Math.min(maxDayKm, Math.max(20, capKm - fromK));
    let lm = pickNightLandmark(fromK, capKm, finK, maxAhead, { strictMax: true });
    let kmTo = Math.floor(capKm);
    if (lm) {
      const cand = Math.min(Math.floor(lm.km) - 1, finK);
      const st = movingStatsFromForecast(fromK, cand, timeline, refPaceMin, opts);
      if (st.movingHours != null && st.movingHours <= maxMovingHours * 1.05) kmTo = cand;
    }
    if (!lm || kmTo >= capKm - 2) {
      lm = nearestRouteLandmark(kmTo) || { km: kmTo, name: "≈ km " + kmTo, major: false };
    }
    kmTo = Math.min(finK, Math.max(fromK + 1, Math.floor(kmTo)));
    const stats = movingStatsFromForecast(fromK, kmTo, timeline, refPaceMin, opts);
    // Cálculo (continuidade temporal): usa a hora real do forecast.
    const eveningCalcDt = stats.forecastEnd || null;
    // Display: força o texto a cair no intervalo 22h–01h.
    const eveningDt =
      parseDataDate(displayDayEndTime(stats.forecastEnd, dayNo)) || eveningStopOnDate(cal, dayNo);

    // Continuidade: a paragem noturna marca o próximo km do dia seguinte.
    const stopKm = Math.min(finK, Math.floor(Number(kmTo)) + 1);
    const nearest = nearestRouteLandmark(stopKm);
    const stopName =
      lm && lm.name && Math.abs(Number(lm.km) - stopKm) <= 18
        ? lm.name
        : nearest?.name || ("≈ km " + stopKm);
    const stopLm = {
      km: stopKm,
      name: stopName,
      major: !!(nearest?.major || lm?.major),
    };

    return {
      kmTo: Math.floor(kmTo),
      landmark: stopLm,
      stats,
      eveningDt,
      eveningCalcDt,
      isFinish: false,
    };
  }

  function medianNightStopMin(payload) {
    const nights = payload.nightStops || [];
    const mins = nights.map((n) => n.durationMin).filter((v) => Number.isFinite(v));
    if (!mins.length) return 400;
    mins.sort((a, b) => a - b);
    return mins[Math.floor(mins.length / 2)];
  }

  function profileGainLossRange(kmFrom, kmTo) {
    const prof = profileFull || D.routeProfile || [];
    let gainM = 0;
    let lossM = 0;
    const k0 = Math.ceil(kmFrom);
    const k1 = Math.floor(kmTo);
    for (let k = k0; k <= k1; k++) {
      const seg = prof[k - 1];
      if (!seg) continue;
      gainM += seg.gain || 0;
      lossM += seg.loss || 0;
    }
    return { gainM: Math.round(gainM), lossM: Math.round(lossM) };
  }

  function pickNightLandmark(fromKm, targetKm, finishKm, maxAheadKm, opts) {
    const strictMax = opts && opts.strictMax;
    const lms = routeLandmarksForDays()
      .filter((l) => l.km > fromKm)
      .sort((a, b) => a.km - b.km);
    if (!lms.length) return null;
    const cap = finishKm != null ? finishKm + 1 : 1e9;
    const cappedTarget =
      maxAheadKm != null && Number.isFinite(maxAheadKm)
        ? Math.min(targetKm, fromKm + maxAheadKm)
        : targetKm;
    let best = null;
    let bestScore = 1e18;
    for (const lm of lms) {
      if (lm.km > cap) break;
      const ahead = lm.km - fromKm;
      if (ahead < 20) continue;
      if (maxAheadKm != null && ahead > maxAheadKm + 5) continue;
      let score = Math.abs(lm.km - cappedTarget);
      if (lm.major) score -= 15;
      if (finishKm != null && Math.abs(lm.km - finishKm) <= 3) score -= 40;
      if (score < bestScore) {
        bestScore = score;
        best = lm;
      }
    }
    if (best) return best;
    if (maxAheadKm != null && !strictMax) {
      return pickNightLandmark(fromKm, targetKm, finishKm, null, opts);
    }
    if (strictMax) return null;
    const fallback = lms.find((l) => l.km <= cap && l.km - fromKm >= 20);
    return fallback || lms[lms.length - 1];
  }

  /** Paragem noturna entre 22h e 01h, no mesmo dia civil do movimento. */
  function eveningStopOnDate(dayDate, dayIndex) {
    const d = new Date(dayDate.getFullYear(), dayDate.getMonth(), dayDate.getDate());
    const slots = [
      [22, 30],
      [23, 0],
      [23, 30],
      [22, 45],
      [23, 15],
      [22, 15],
      [23, 45],
    ];
    const [hh, mm] = slots[((dayIndex % slots.length) + slots.length) % slots.length];
    d.setHours(hh, mm, 0, 0);
    return d;
  }

  function morningResumeAfterNight(eveningStopDt, nightMin) {
    const nightEnd = new Date(eveningStopDt.getTime() + nightMin * 60000);
    const h = nightEnd.getHours() + nightEnd.getMinutes() / 60;
    if (h >= 4.5 && h <= 8.5) return nightEnd;
    const d = new Date(eveningStopDt);
    d.setDate(d.getDate() + 1);
    d.setHours(5, 30, 0, 0);
    return d;
  }

  function calendarDateFromDt(dt) {
    if (!dt || Number.isNaN(dt.getTime())) return new Date();
    return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
  }

  function referenceMovingPaceMin() {
    const p = (D.prediction && D.prediction.performance) || perf || {};
    const fromPerf = p.recentPaceMin || p.weightedPaceMin || p.medianPaceMin;
    if (fromPerf && fromPerf > 0) return fromPerf;
    const mov = D.prediction?.movingPaceMin || D.prediction?.basePaceMin;
    return mov && mov > 0 ? mov : 11;
  }

  function movingStatsFromForecast(kmFrom, kmTo, timeline, refPaceMin, opts) {
    const km = Math.max(0, Number(kmTo) - Number(kmFrom));
    if (!timeline.length || km <= 0) {
      return {
        km,
        movingHours: null,
        movingPaceMin: refPaceMin,
        kmPerDay: null,
        forecastStart: null,
        forecastEnd: null,
      };
    }
    const first = timeline[0];
    const lastPt = timeline[timeline.length - 1];
    let t0 =
      kmFrom < first.km - 0.5
        ? opts?.segmentStartDt || first.t
        : interpForecastTime(kmFrom, timeline);
    let t1 = interpForecastTime(kmTo, timeline);
    if (kmTo > lastPt.km + 0.5) {
      t1 = opts?.finishTimeDt || lastPt.t;
    }
    let movingHours = null;
    if (t0 && t1 && t1 > t0) {
      movingHours = (t1 - t0) / 3600000;
    } else if (refPaceMin && km > 0) {
      movingHours = (km * refPaceMin) / 60;
      // Se o forecast estiver "para trás" (t1 <= t0), força timeline monotónica.
      if (t0 && (!t1 || t1 <= t0)) t1 = new Date(t0.getTime() + movingHours * 3600000);
    }
    // Última segurança: nunca devolver forecastEnd anterior ao start.
    if (t0 && t1 && t1 <= t0) {
      t1 = new Date(t0.getTime() + Math.max(0.01, (movingHours || 0.01)) * 3600000);
    }
    const movingPaceMin =
      km > 0 && movingHours && movingHours > 0 ? (movingHours * 60) / km : refPaceMin;
    const kmPerDay =
      km > 0 && movingHours && movingHours > 0 ? (km / movingHours) * 24 : null;
    return {
      km,
      movingHours,
      movingPaceMin,
      kmPerDay,
      forecastStart: t0,
      forecastEnd: t1,
    };
  }

  /** Hora de paragem: usa forecast; se fora de 22h–01h, mostra noite típica desse dia civil. */
  function displayDayEndTime(forecastEndDt, dayIndex) {
    if (!forecastEndDt) return null;
    const h = forecastEndDt.getHours() + forecastEndDt.getMinutes() / 60;
    if (h >= 21.5 || h <= 1.5) return fmtDataDateTime(forecastEndDt);
    return fmtDataDateTime(eveningStopOnDate(forecastEndDt, dayIndex));
  }

  function buildNightAfter(landmark, endMoveDt, nightMin) {
    const resumeDt = morningResumeAfterNight(endMoveDt, nightMin);
    return {
      kmFrom: landmark.km,
      kmTo: landmark.km,
      durationMin: Math.round(nightMin * 10) / 10,
      duration: fmtDurationFromMin(nightMin),
      endCrossing: fmtDataDateTime(resumeDt),
      placeName: landmark.name,
    };
  }

  function buildPredictedDay(opts) {
    const {
      dayNo,
      kmFrom,
      kmTo,
      startTime,
      endTime,
      goalKm,
      timeline,
      refPaceMin,
      isLast,
      inProgress,
    } = opts;
    const startDt = parseDataDate(startTime);
    const endDt = parseDataDate(endTime);
    const stats = movingStatsFromForecast(kmFrom, kmTo, timeline, refPaceMin, {
      segmentStartDt: startDt,
      finishTimeDt: isLast ? endDt : null,
    });
    const km = stats.km;
    const movingHours = stats.movingHours;
    const kmPerDay = stats.kmPerDay;
    const movingPaceMin = stats.movingPaceMin;
    const spanHours =
      startDt && endDt && endDt > startDt ? (endDt - startDt) / 3600000 : movingHours;
    const gl = profileGainLossRange(kmFrom, kmTo);
    const day = {
      day: dayNo,
      label: "Dia " + dayNo + (inProgress ? " · em curso" : "") + (isLast ? " · meta" : ""),
      kmFrom,
      kmTo,
      km,
      startTime,
      endTime: inProgress ? null : endTime,
      spanHours: spanHours != null ? Math.round(spanHours * 100) / 100 : null,
      movingHours: movingHours != null ? Math.round(movingHours * 100) / 100 : null,
      movingTime: fmtDurationFromHours(movingHours),
      movingPace: movingPaceMin != null ? fmtPaceMin(movingPaceMin) : "—",
      kmPerDay: kmPerDay != null ? Math.round(kmPerDay * 10) / 10 : null,
      gainM: gl.gainM,
      lossM: gl.lossM,
      inProgress: !!inProgress,
      categories: {},
      splitsFromKm: kmFrom,
      splitsToKm: kmTo,
      isPredicted: !inProgress,
    };
    if (goalKm != null && day.kmPerDay != null) {
      day.vsGoalKmDay = Math.round((day.kmPerDay - goalKm) * 10) / 10;
    }
    return day;
  }

  function applyDaysWithPredictions(baseDays, payload) {
    const pred = D.prediction || {};
    const timeline = forecastTimelineMain();
    const finishKm = Math.floor(D.event?.totalKm || totalKm);
    const finishDt =
      parseDataDate(pred.finishTimeIso || pred.finishTime) ||
      parseFinishDt(pred.finishTimeIso || pred.finishTime);
    if (!finishDt || !timeline.length || !baseDays.length) return baseDays.map((d) => ({ ...d }));

    const goalKm = D.event?.goal?.kmPerDayCalendar;
    const refPaceMin = referenceMovingPaceMin();
    const nightMin = medianNightStopMin(payload);
    const maxMovingHours = maxMovingHoursFromHistory(baseDays);
    const days = baseDays.map((d) => ({ ...d }));
    const last = days[days.length - 1];
    const projKm = Math.floor(Number(pred.projectionKm != null ? pred.projectionKm : currentKm));
    const projTime = parseDataDate(pred.projectionTime) || new Date();
    let dayNo = last.day != null ? Number(last.day) : days.length;

    const nearestStopLabel = (km) => {
      const lk = Math.floor(Number(km));
      const lm = nearestRouteLandmark(lk);
      if (lm && Math.abs(Number(lm.km) - lk) <= 18) return lm.name;
      return "≈ km " + lk;
    };

    const calcEndFromBudget = (startDt, budgetHours) => {
      if (!startDt || !Number.isFinite(budgetHours) || budgetHours <= 0) return startDt;
      const dt = new Date(startDt.getTime() + budgetHours * 3600000);
      if (dt > finishDt) return finishDt;
      return dt;
    };

    // 1) Dia em curso: projetar só o que falta hoje.
    let cursorKm = Math.floor(Number(last.kmTo)) + 1;
    let cursorTime = projTime;
    if (last.inProgress) {
      const startDt = parseDataDate(last.startTime) || projTime;
      const doneStats = movingStatsFromForecast(Math.floor(Number(last.kmFrom)), projKm, timeline, refPaceMin, {
        segmentStartDt: startDt,
      });
      const doneHours = doneStats.movingHours != null ? Math.max(0, doneStats.movingHours) : 0;
      const remainBudget = Math.max(1.5, maxMovingHours - doneHours);
      const endCalcDt = calcEndFromBudget(projTime, remainBudget);
      let kmTo = interpForecastKmAtTime(endCalcDt, timeline);
      if (kmTo == null) kmTo = projKm;
      kmTo = Math.max(projKm, Math.min(finishKm, Math.floor(kmTo)));

      const statsFull = movingStatsFromForecast(Math.floor(Number(last.kmFrom)), kmTo, timeline, refPaceMin, {
        segmentStartDt: startDt,
      });
      const statsRemain = movingStatsFromForecast(projKm, kmTo, timeline, refPaceMin, {
        segmentStartDt: projTime,
      });
      const endDisplay =
        parseDataDate(displayDayEndTime(endCalcDt, dayNo)) || eveningStopOnDate(calendarDateFromDt(endCalcDt), dayNo);
      const stopKm = Math.min(finishKm, kmTo + 1);
      const nightAfter = buildNightAfter(
        { km: stopKm, name: nearestStopLabel(stopKm), major: false },
        endCalcDt,
        nightMin
      );
      last.projected = {
        kmTo,
        km: statsFull.km,
        endTime: fmtDataDateTime(endDisplay),
        movingHours: statsFull.movingHours != null ? Math.round(statsFull.movingHours * 100) / 100 : null,
        movingTime: fmtDurationFromHours(statsFull.movingHours),
        kmPerDay: statsFull.kmPerDay != null ? Math.round(statsFull.kmPerDay * 10) / 10 : null,
        movingPace: statsRemain.movingPaceMin != null ? fmtPaceMin(statsRemain.movingPaceMin) : "—",
        nightAfter,
      };
      if (goalKm != null && last.projected.kmPerDay != null) {
        last.projected.vsGoalKmDay = Math.round((last.projected.kmPerDay - goalKm) * 10) / 10;
      }

      if (kmTo >= finishKm) return days;
      cursorKm = kmTo + 1;
      cursorTime = parseDataDate(nightAfter.endCrossing) || morningResumeAfterNight(endCalcDt, nightMin);
    } else {
      const night = last.nightAfter;
      cursorKm = Math.floor(Number(last.kmTo)) + 1;
      cursorTime = parseDataDate(night?.endCrossing) || projTime;
    }

    // 2) Dias futuros: blocos temporais fixos (maxMovingHours) até finishTimeIso.
    const extra = [];
    let guard = 0;
    while (cursorKm <= finishKm && cursorTime < finishDt && guard < 24) {
      guard += 1;
      dayNo += 1;
      const startDt = cursorTime;
      const endCalcDt = calcEndFromBudget(startDt, maxMovingHours);
      const isLast = endCalcDt >= finishDt || cursorKm >= finishKm;

      let kmTo = isLast ? finishKm : interpForecastKmAtTime(endCalcDt, timeline);
      if (kmTo == null) kmTo = finishKm;
      kmTo = Math.max(cursorKm, Math.min(finishKm, Math.floor(kmTo)));

      if (kmTo <= cursorKm && !isLast) {
        kmTo = Math.min(finishKm, cursorKm + 1);
      }

      const endDisplay = isLast
        ? finishDt
        : parseDataDate(displayDayEndTime(endCalcDt, dayNo)) ||
          eveningStopOnDate(calendarDateFromDt(endCalcDt), dayNo);
      const day = buildPredictedDay({
        dayNo,
        kmFrom: cursorKm,
        kmTo,
        startTime: fmtDataDateTime(startDt),
        endTime: fmtDataDateTime(endDisplay),
        goalKm,
        timeline,
        refPaceMin,
        isLast,
        inProgress: false,
      });

      if (isLast || kmTo >= finishKm) {
        day.nightAfter = {
          kmFrom: finishKm,
          kmTo: finishKm,
          durationMin: 0,
          duration: "—",
          endCrossing: fmtDataDateTime(finishDt),
          placeName: "Sagres",
        };
        extra.push(day);
        break;
      }

      const stopKm = Math.min(finishKm, kmTo + 1);
      day.nightAfter = buildNightAfter(
        { km: stopKm, name: nearestStopLabel(stopKm), major: false },
        endCalcDt,
        nightMin
      );
      extra.push(day);
      cursorKm = kmTo + 1;
      cursorTime = parseDataDate(day.nightAfter.endCrossing) || morningResumeAfterNight(endCalcDt, nightMin);
    }

    return days.concat(extra);
  }

  function renderDays() {
    const grid = $("days-grid");
    const lead = $("days-lead");
    if (!grid) return;
    const payload = getDaysPayload();
    const baseDays = payload.days || [];
    const goalKm = D.event?.goal?.kmPerDayCalendar;
    const showPredicted = daysShowPredicted();

    let days = baseDays;
    if (showPredicted) {
      try {
        days = applyDaysWithPredictions(baseDays, payload);
      } catch (err) {
        console.error("applyDaysWithPredictions:", err);
      }
    }

    if (lead) {
      lead.textContent =
        payload.method ||
        "Cada dia corresponde ao período de movimento entre paragens noturnas longas (≥60 min).";
      if (showPredicted) {
        const fin = D.prediction?.finishTimeIso || D.prediction?.finishTime;
        const maxH = maxMovingHoursFromHistory(baseDays);
        lead.textContent +=
          " Com previsão: cada dia até ~" +
          fmtNum(maxH, 0) +
          " h em movimento (como os dias já feitos); paragem 22h–01h; retoma ~05h30; paragens em cidades no percurso ou ≈km quando o troço é longo" +
          (fin ? " (" + String(fin).replace(" ", " · ") + ")." : ".");
      }
      if (goalKm != null) {
        lead.textContent += " Meta 31/05: ~" + fmtNum(goalKm, 1) + " km/dia em movimento.";
      }
      lead.textContent +=
        " Temperatura min/máx em movimento via Open-Meteo (ar a 2 m, horas sobrepostas ao ritmo).";
    }

    if (!days.length) {
      grid.innerHTML = '<p class="chart-caption">Sem dias calculados — actualiza os dados completos.</p>';
      return;
    }

    const catMap = {};
    (D.categoryLegend || []).forEach((c) => {
      catMap[c.id] = c;
    });

    function nightStopHtml(night, predicted) {
      if (!night) return "";
      const place = night.placeName || "";
      const predTag = predicted ? " <span class='muted'>(previsto)</span>" : "";
      if (!night.durationMin || night.durationMin <= 0) {
        return (
          `<div class="day-night${predicted ? " predicted" : ""}"><strong>Chegada</strong> ${place}` +
          (place ? " · " : "") +
          "km " +
          night.kmFrom +
          (night.endCrossing ? " · " + night.endCrossing.replace(" ", " · ") : "") +
          predTag +
          "</div>"
        );
      }
      return (
        `<div class="day-night${predicted ? " predicted" : ""}"><strong>Paragem noite</strong> ${place ? place + " · " : ""}km ${night.kmFrom}` +
        (night.kmTo !== night.kmFrom ? "–" + night.kmTo : "") +
        " · " +
        night.duration +
        (night.endCrossing ? " · fim " + night.endCrossing.split(" ")[1] : "") +
        predTag +
        "</div>"
      );
    }

    grid.innerHTML = days
      .map((day) => {
        const proj = day.projected;
        const displayKm = proj && proj.km != null ? proj.km : day.km;
        const vsVal = proj && proj.vsGoalKmDay != null ? proj.vsGoalKmDay : day.vsGoalKmDay;
        let vsCls = "warn";
        if (vsVal != null) vsCls = vsVal >= 0 ? "good" : "bad";
        const kmPerDayVal = proj && proj.kmPerDay != null ? proj.kmPerDay : day.kmPerDay;

        let nightHtml = "";
        if (day.nightAfter) nightHtml = nightStopHtml(day.nightAfter, false);
        else if (proj && proj.nightAfter) nightHtml = nightStopHtml(proj.nightAfter, true);
        else if (day.inProgress && showPredicted)
          nightHtml = '<div class="day-night muted">A calcular paragem noturna prevista…</div>';
        else if (day.inProgress)
          nightHtml = '<div class="day-night">Dia em curso — paragem noturna ainda não registada.</div>';

        const kmRange =
          proj && proj.kmTo != null
            ? `km ${day.kmFrom}–${day.kmTo} → <strong>${proj.kmTo}</strong>`
            : `km ${day.kmFrom}–${day.kmTo}`;
        const timeRange =
          proj && proj.endTime
            ? fmtDayRange(day.startTime, proj.endTime)
            : fmtDayRange(day.startTime, day.endTime);

        const cats = Object.entries(day.categories || {})
          .map(([id, n]) => {
            const c = catMap[id];
            const label = c ? c.short : id;
            const col = c ? c.color : "#8b95a8";
            return `<span class="cat-chip" style="border-color:${col}55;color:${col}">${label} ${n}</span>`;
          })
          .join("");

        const kmBig =
          proj && day.km !== displayKm
            ? `${day.km} → <strong>${displayKm}</strong> km`
            : `${displayKm} km`;

        return (
          `<article class="day-card${day.inProgress ? " in-progress" : ""}${day.isPredicted ? " predicted" : ""}">` +
          `<header class="day-card-head">` +
          `<div><h3>${day.label}</h3>` +
          `<p class="day-card-meta">${kmRange}` +
          (day.splitsFromKm != null && day.splitsFromKm > day.kmFrom
            ? ` · splits desde km ${day.splitsFromKm}`
            : day.kmFrom === 0 && day.splitsFromKm
              ? ` · splits desde km ${day.splitsFromKm}`
              : "") +
          ` · ${timeRange}</p></div>` +
          `<div class="day-km-big">${kmBig}</div></header>` +
          `<div class="day-stats">` +
          `<div><span class="k">Tempo em movimento</span><span class="v">${
            proj && proj.movingTime
              ? (day.movingTime || "—") + " → " + proj.movingTime + " (prev.)"
              : (day.movingTime || "—") + " (" + fmtNum(day.movingHours, 1) + " h)"
          }</span></div>` +
          `<div><span class="k">Ritmo em movimento</span><span class="v">${(proj && proj.movingPace) || day.movingPace || "—"}</span></div>` +
          `<div><span class="k">Km/dia (extrapolado)</span><span class="v ${vsCls}">${kmPerDayVal != null ? fmtNum(kmPerDayVal, 1) : "—"}</span></div>` +
          `<div><span class="k">vs meta 31/05</span><span class="v ${vsCls}">${vsVal != null ? (vsVal >= 0 ? "+" : "") + fmtNum(vsVal, 1) + " km/d" : "—"}</span></div>` +
          `<div><span class="k">Relógio (início→fim)</span><span class="v">${day.spanHours != null ? fmtNum(day.spanHours, 1) + " h" : "—"}</span></div>` +
          `<div><span class="k">D+ / D−</span><span class="v">+${day.gainM || 0} / −${day.lossM || 0} m</span></div>` +
          `<div><span class="k">Temperatura (mov.)</span><span class="v">${
            day.tempMinC != null && day.tempMaxC != null
              ? fmtNum(day.tempMinC, 1) + "° – " + fmtNum(day.tempMaxC, 1) + "°C"
              : "—"
          }</span></div>` +
          `</div>` +
          (cats ? `<div class="day-cats">${cats}</div>` : "") +
          nightHtml +
          `</article>`
        );
      })
      .join("");

    drawDaysKmChart(days, goalKm);
  }

  function drawDaysKmChart(days, goalKm) {
    const canvas = $("chart-days-km");
    const s = setupCanvas(canvas, 160);
    if (!s || !days.length) return;
    const { ctx, w, h } = s;
    const pad = { l: 40, r: 12, t: 16, b: 36 };
    const maxKm = Math.max(
      ...days.map((d) =>
        d.inProgress && d.projected && d.projected.km != null ? d.projected.km : d.km
      ),
      goalKm || 0,
      1
    );
    const barGap = 12;
    const plotW = w - pad.l - pad.r;
    const barW = Math.min(72, (plotW - barGap * (days.length + 1)) / days.length);
    const plotH = h - pad.t - pad.b;

    ctx.fillStyle = "#151920";
    ctx.fillRect(0, 0, w, h);

    if (goalKm != null && goalKm > 0) {
      const gy = pad.t + (1 - goalKm / maxKm) * plotH;
      ctx.strokeStyle = "rgba(245, 158, 11, 0.55)";
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(pad.l, gy);
      ctx.lineTo(w - pad.r, gy);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#f59e0b";
      ctx.font = "9px sans-serif";
      ctx.fillText("meta " + Math.round(goalKm) + " km", pad.l + 4, gy - 4);
    }

    days.forEach((day, i) => {
      const x = pad.l + barGap + i * (barW + barGap);
      const chartKm =
        day.inProgress && day.projected && day.projected.km != null ? day.projected.km : day.km;
      const bh = (chartKm / maxKm) * plotH;
      const y = h - pad.b - bh;
      if (day.inProgress) ctx.fillStyle = "rgba(34, 197, 94, 0.75)";
      else if (day.isPredicted) ctx.fillStyle = "rgba(167, 139, 250, 0.65)";
      else ctx.fillStyle = "rgba(61, 139, 253, 0.75)";
      ctx.fillRect(x, y, barW, bh);
      ctx.fillStyle = "#8b95a8";
      ctx.font = "10px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("D" + day.day, x + barW / 2, h - 8);
      ctx.fillText(String(chartKm), x + barW / 2, y - 4);
    });
    ctx.textAlign = "left";
  }

  try {
    // Listener do toggle (sem recarregar página).
    const predToggle = $("days-toggle-pred");
    if (predToggle) {
      predToggle.addEventListener("change", () => {
        try {
          localStorage.setItem("travessiaDaysShowPred", predToggle.checked ? "1" : "0");
        } catch {}
        renderDays();
      });
    }
    renderDays();
  } catch (err) {
    console.error("renderDays:", err);
  }

  window.__travessiaRedrawCharts = function () {
    drawPaceChart();
    drawElevChart();
    try {
      renderDays();
    } catch (err) {
      console.error("renderDays:", err);
    }
    if ($("elev-modal") && !$("elev-modal").hidden) drawElevChartLarge();
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

  window.travessiaApplyLivePatch = function (patch) {
    if (!patch || !patch.ok) return;
    if (patch.live) {
      D.live = patch.live;
      D.liveUpdatedAt = patch.liveUpdatedAt;
    }
    if (patch.goal && D.event) D.event.goal = patch.goal;
    if (patch.mapCurrent && D.map) D.map.current = patch.mapCurrent;
    renderLive();
    if (patch.updatedAt) {
      const updatedEl = $("updated-at");
      if (updatedEl) {
        let foot = "Dados: " + patch.updatedAt;
        if (D.live && D.live.gpsTime) foot += " · GPS live " + D.live.gpsTime.split(" ")[1];
        updatedEl.textContent = foot;
      }
    }
    if (window.travessiaUpdateMapLive) window.travessiaUpdateMapLive(patch);
  };

  window.travessiaReloadAnalytics = function (next) {
    if (!next) return;
    window.ANALYTICS = next;
    D = next;
    totalKm = D.event.totalKm;
    currentKm = D.current.km;
    profileFull = D.routeProfileFull || D.routeProfile;
    P = D.prediction;
    perf = P.performance || {};
    profileFull = D.routeProfileFull || D.routeProfile;
    params.basePaceMin = perf.weightedPaceMin || P.basePaceMin;
    params.climbSecPer100m = P.climbSecPer100m || perf.climbSecPer100m || CAPS.climbPrior;
    params.fatiguePerKm = perf.fatiguePerKm ?? P.fatigueRatePerKm ?? 0;
    params.stopProb = perf.stopProbPerKm ?? (perf.stopRatioPct || 0) / 100;
    params.avgStopSec =
      perf.medianStopSec ?? perf.avgStopSec ?? (perf.medianStopMin || perf.avgStopMin || 0) * 60;
    params.nightFactor = perf.nightFactor ?? 1 + (perf.nightSlowdownPct || 0) / 100;
    params.decayPer10k = perf.decayPer10kmAfter100 ?? 0;

    $("athlete-name").textContent = D.athlete.name;
    updatePageTitle();
    $("progress-pct").textContent = D.current.progressPct + "%";
    $("progress-km").textContent = currentKm + " / " + totalKm + " km";
    $("progress-fill").style.width = D.current.progressPct + "%";

    renderLive();
    try {
      updateConfidence();
      updateModelBadge();
    } catch (err) {
      console.error("updateConfidence:", err);
    }
    refreshTable();
    const fast = D.stats && D.stats.fastest;
    const slow = D.stats && D.stats.slowest;
    if (fast && $("fastest-km")) {
      $("fastest-km").textContent =
        "Km " + fast.km + " · " + fast.segment_time + " (" + fast.pace + ")" +
        (fast.categoryLabel ? " · " + fast.categoryLabel : "");
    }
    if (slow && $("slowest-km")) {
      $("slowest-km").textContent =
        "Km " + slow.km + " · " + slow.segment_time + " (" + slow.pace + ")" +
        (slow.categoryLabel ? " · " + slow.categoryLabel : "");
    }
    if (window.travessiaMapReload) window.travessiaMapReload(D.map);
    try {
      renderDays();
    } catch (err) {
      console.error("renderDays:", err);
    }
    const updatedEl = $("updated-at");
    if (updatedEl && D.updatedAt) {
      let foot = "Dados: " + D.updatedAt;
      if (D.live && D.live.gpsTime) foot += " · GPS live " + D.live.gpsTime.split(" ")[1];
      updatedEl.textContent = foot;
    }
  };
})();
