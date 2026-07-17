import type { TestResult, WordResult } from "../types";
import { LANGS } from "../wordlist";
import { el, fmt, speedPercentile, speedShade } from "./common";

const SVG_NS = "http://www.w3.org/2000/svg";

type ResultHandlers = {
  onRestart: () => void;
  onPracticeWords: (words: string[]) => void;
  onDelete: () => void;
};

type ResultInfo = {
  newRecord: boolean;
};

function wordWpm(w: WordResult): number | null {
  if (w.timeMs === null || w.timeMs <= 0) return null;
  return (w.text.length / 5) / (w.timeMs / 60000);
}

export function renderResults(
  root: HTMLElement,
  result: TestResult,
  handlers: ResultHandlers,
  info: ResultInfo = { newRecord: false }
): void {
  root.innerHTML = "";

  // --- bannière nouveau record ---
  if (info.newRecord) {
    root.append(el("div", "record-banner gold-metal", "🏆 Nouveau record !"));
  }

  // --- tuiles ---
  const tiles = el("div", "result-tiles");
  const mk = (label: string, value: string, unit: string, hero = false) => {
    const tile = el("div", hero ? "tile hero" : "tile");
    if (hero && info.newRecord) tile.classList.add("record");
    tile.append(el("div", "label", label));
    const v = el("div", hero ? "value gold-metal" : "value", value);
    if (unit) v.append(el("span", "unit", unit));
    tile.append(v);
    return tile;
  };
  tiles.append(
    mk("wpm", fmt(result.wpm, 2), "", true),
    mk("précision", fmt(result.accuracy * 100), "%"),
    mk("brut", fmt(result.rawWpm, 2), "wpm"),
    mk("durée", fmt(result.durationMs / 1000, 1), "s"),
    mk(
      "mode",
      result.mode === "practice" ? "entraînement" : "normal",
      "",
    )
  );
  const langTile = mk("langue", LANGS[result.lang].label, "");
  tiles.append(langTile);
  root.append(tiles);

  // --- courbe wpm ---
  if (result.wpmSeries.length > 1) {
    root.append(buildChart(result));
  }

  // --- mots du test ---
  const wordsTitle = el("h3", "section-title", "Mots du test");
  root.append(wordsTitle);
  // échelle rouge→or propre à CE test : distribution des vitesses par mot
  const dist = result.words
    .map(wordWpm)
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);

  const chips = el("div", "result-words");
  const toReview = new Set<string>();
  for (const w of result.words) {
    const chip = el("span", "rw", w.text);
    const wpm = wordWpm(w);
    const parts: string[] = [];
    if (wpm !== null) parts.push(`${fmt(wpm)} wpm`);
    parts.push(w.errors === 0 ? "aucune erreur" : `${w.errors} erreur(s)`);
    chip.title = parts.join(" · ");
    if (w.errors > 0) {
      chip.classList.add("err");
      toReview.add(w.text);
    }
    if (wpm !== null) {
      // même encre que le test : rouge orangé (lent) → bronze → or (rapide),
      // calée sur la répartition des vitesses de ce test uniquement
      if (dist.length >= 3) {
        const { spd, redMix, gold } = speedShade(speedPercentile(wpm, dist));
        chip.classList.add("rw-spd");
        chip.style.setProperty("--spd", spd.toFixed(3));
        chip.style.setProperty("--spd-red-mix", redMix.toFixed(3));
        chip.style.setProperty("--spd-gold-mix", gold.toFixed(3));
      }
      if (wpm < result.wpm * 0.7) toReview.add(w.text);
    }
    chips.append(chip);
  }
  root.append(chips);

  // légende de l'échelle rouge→or, calée sur ce test
  if (dist.length >= 3) {
    const lo = dist[0] as number;
    const hi = dist[dist.length - 1] as number;
    const legend = el("div", "speed-legend");
    legend.innerHTML =
      `<span class="sl-label">${fmt(lo)}</span>` +
      '<span class="sl-bar"></span>' +
      `<span class="sl-label">${fmt(hi)} wpm</span>` +
      '<span class="sl-cap">— couleur des mots = vitesse sur ce test</span>';
    root.append(legend);
  }

  // --- actions ---
  const btns = el("div", "btn-row");
  const restart = el("button", "btn primary", "Recommencer (Tab)");
  restart.addEventListener("click", handlers.onRestart);
  btns.append(restart);
  if (toReview.size > 0) {
    const practice = el(
      "button",
      "btn",
      `⚑ S'entraîner sur ces ${toReview.size} mot(s)`
    );
    practice.addEventListener("click", () =>
      handlers.onPracticeWords([...toReview])
    );
    btns.append(practice);
  }
  // suppression du test : le retire entièrement des stats (mots, bigrammes,
  // historique, record, journal). Demande confirmation car c'est définitif.
  const del = el("button", "btn danger", "🗑 Supprimer ce test");
  del.title = "Retire ce test de toutes tes statistiques (définitif)";
  del.addEventListener("click", () => {
    if (del.classList.contains("confirm")) {
      handlers.onDelete();
      return;
    }
    del.classList.add("confirm");
    del.textContent = "Confirmer la suppression ?";
    window.setTimeout(() => {
      del.classList.remove("confirm");
      del.textContent = "🗑 Supprimer ce test";
    }, 3000);
  });
  btns.append(del);
  root.append(btns);
}

/** Courbe WPM net par seconde — série unique, crosshair + tooltip au survol */
function buildChart(result: TestResult): HTMLElement {
  const card = el("div", "chart-card");
  card.append(el("h3", undefined, "WPM au fil du test"));

  const W = 700;
  const H = 200;
  const M = { top: 10, right: 12, bottom: 24, left: 40 };
  const iw = W - M.left - M.right;
  const ih = H - M.top - M.bottom;

  const series = result.wpmSeries;
  const maxT = series[series.length - 1]?.t ?? 1;
  const maxWpm = Math.max(10, ...series.map((p) => p.wpm));
  const yMax = Math.ceil((maxWpm * 1.1) / 10) * 10;

  const x = (t: number) => M.left + (t / maxT) * iw;
  const y = (wpm: number) => M.top + ih - (wpm / yMax) * ih;

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.style.width = "100%";
  svg.style.display = "block";

  const addLine = (
    x1: number, y1: number, x2: number, y2: number, stroke: string
  ) => {
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", String(x1));
    line.setAttribute("y1", String(y1));
    line.setAttribute("x2", String(x2));
    line.setAttribute("y2", String(y2));
    line.setAttribute("stroke", stroke);
    line.setAttribute("stroke-width", "1");
    svg.append(line);
    return line;
  };
  const addText = (tx: number, ty: number, text: string, anchor: string) => {
    const node = document.createElementNS(SVG_NS, "text");
    node.setAttribute("x", String(tx));
    node.setAttribute("y", String(ty));
    node.setAttribute("fill", "#8a7d5c");
    node.setAttribute("font-size", "11");
    node.setAttribute("text-anchor", anchor);
    node.textContent = text;
    svg.append(node);
  };

  // grille horizontale + graduations y
  const ySteps = 4;
  for (let i = 0; i <= ySteps; i++) {
    const value = (yMax / ySteps) * i;
    const gy = y(value);
    addLine(M.left, gy, W - M.right, gy, i === 0 ? "#3a3320" : "#2b2619");
    addText(M.left - 8, gy + 4, fmt(value), "end");
  }
  // graduations x (secondes)
  const xTicks = Math.min(8, Math.floor(maxT));
  for (let i = 0; i <= xTicks; i++) {
    const t = (maxT / xTicks) * i;
    addText(x(t), H - 6, fmt(t) + "s", "middle");
  }

  // ligne de la série
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute(
    "d",
    series
      .map((p, i) => `${i === 0 ? "M" : "L"}${x(p.t)},${y(p.wpm)}`)
      .join(" ")
  );
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "#e6c15a");
  path.setAttribute("stroke-width", "2");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);

  // marqueurs de fautes : petit point rouge sur la courbe à l'instant de chaque
  // frappe fausse, pour voir si les erreurs cassent le rythme
  for (const et of result.errorTimes) {
    if (et < 0 || et > maxT) continue;
    let near = series[0];
    if (!near) break;
    for (const p of series) {
      if (Math.abs(p.t - et) < Math.abs(near.t - et)) near = p;
    }
    const dotErr = document.createElementNS(SVG_NS, "circle");
    dotErr.setAttribute("cx", String(x(et)));
    dotErr.setAttribute("cy", String(y(near.wpm)));
    dotErr.setAttribute("r", "2.5");
    dotErr.setAttribute("fill", "#c9482f");
    dotErr.setAttribute("opacity", "0.75");
    svg.append(dotErr);
  }

  // --- survol : crosshair + tooltip ---
  const crosshair = addLine(0, M.top, 0, M.top + ih, "#8a7d5c");
  crosshair.setAttribute("visibility", "hidden");
  const dot = document.createElementNS(SVG_NS, "circle");
  dot.setAttribute("r", "4");
  dot.setAttribute("fill", "#e6c15a");
  dot.setAttribute("stroke", "#1a160e");
  dot.setAttribute("stroke-width", "2");
  dot.setAttribute("visibility", "hidden");
  svg.append(dot);

  const tooltip = el("div", "chart-tooltip");
  tooltip.hidden = true;
  card.append(svg, tooltip);

  svg.addEventListener("mousemove", (e) => {
    const rect = svg.getBoundingClientRect();
    const scale = W / rect.width;
    const mx = (e.clientX - rect.left) * scale;
    const t = ((mx - M.left) / iw) * maxT;
    let nearest = series[0];
    if (!nearest) return;
    for (const p of series) {
      if (Math.abs(p.t - t) < Math.abs(nearest.t - t)) nearest = p;
    }
    const px = x(nearest.t);
    const py = y(nearest.wpm);
    crosshair.setAttribute("x1", String(px));
    crosshair.setAttribute("x2", String(px));
    crosshair.setAttribute("visibility", "visible");
    dot.setAttribute("cx", String(px));
    dot.setAttribute("cy", String(py));
    dot.setAttribute("visibility", "visible");
    tooltip.hidden = false;
    tooltip.textContent = `${fmt(nearest.t)}s — ${fmt(nearest.wpm)} wpm`;
    tooltip.style.left = `${px / scale}px`;
    tooltip.style.top = `${py / scale + svg.getBoundingClientRect().top - card.getBoundingClientRect().top}px`;
  });
  svg.addEventListener("mouseleave", () => {
    crosshair.setAttribute("visibility", "hidden");
    dot.setAttribute("visibility", "hidden");
    tooltip.hidden = true;
  });

  return card;
}
