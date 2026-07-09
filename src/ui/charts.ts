// Boîte à outils de graphiques (d3), cohérente avec le thème sombre du projet.
// Chaque graphique renvoie une carte (.chart-card) autonome avec sa couche de
// survol (crosshair / tooltip / mise en avant) par défaut.

import {
  scaleLinear,
  scaleBand,
  axisBottom,
  axisLeft,
  select,
  pointer,
  line as d3line,
  curveMonotoneX,
  bin as d3bin,
  extent,
  max as d3max,
  mean as d3mean,
  quantile,
  interpolateRgb,
  quadtree,
  type Selection,
} from "d3";
import { hexbin as d3hexbin } from "d3-hexbin";

const NS = "http://www.w3.org/2000/svg";

// ---- palette (variables du thème) -----------------------------------------
const INK = "#eceae6";
const INK_2 = "#c3c2b7";
const MUTED = "#898781";
const GRID = "#2c2c2a";
const BASELINE = "#383835";
const SURFACE = "#1a1a19";
export const ACCENT = "#3987e5";
export const PACE = "#9085e9";
export const STATUS = {
  good: "#0ca30c",
  warning: "#fab219",
  serious: "#ec835a",
  critical: "#d03b3b",
};

const numFmt = (n: number, d = 0) =>
  n.toLocaleString("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d });

/** Rampe séquentielle : t (0..1) → du fond sombre vers la teinte forte. */
export function ramp(t: number, hue: string): string {
  const c = Math.max(0, Math.min(1, t));
  return interpolateRgb("#181712", hue)(0.1 + 0.9 * c);
}

// ---- carte + tooltip partagés ---------------------------------------------
type SvgSel = Selection<SVGSVGElement, unknown, null, undefined>;

interface Card {
  card: HTMLDivElement;
  svg: (w: number, h: number) => SvgSel;
  showTip: (event: MouseEvent, html: string) => void;
  hideTip: () => void;
}

function makeCard(title: string, subtitle?: string): Card {
  const card = document.createElement("div");
  card.className = "chart-card";
  const head = document.createElement("div");
  head.className = "chart-head";
  const h = document.createElement("h3");
  h.textContent = title;
  head.append(h);
  if (subtitle) {
    const sub = document.createElement("span");
    sub.className = "chart-sub";
    sub.textContent = subtitle;
    head.append(sub);
  }
  card.append(head);

  const tip = document.createElement("div");
  tip.className = "chart-tooltip";
  tip.hidden = true;
  card.append(tip);

  const showTip = (event: MouseEvent, html: string) => {
    const [px, py] = pointer(event, card);
    const rect = card.getBoundingClientRect();
    tip.innerHTML = html;
    tip.hidden = false;
    const left = Math.max(64, Math.min(rect.width - 64, px));
    tip.style.left = `${left}px`;
    tip.style.top = `${py}px`;
  };
  const hideTip = () => {
    tip.hidden = true;
  };

  const svg = (w: number, h: number): SvgSel => {
    const node = document.createElementNS(NS, "svg") as SVGSVGElement;
    const sel = select(node);
    sel.attr("viewBox", `0 0 ${w} ${h}`).style("width", "100%").style("height", "auto").style("display", "block");
    return sel;
  };

  return { card, svg, showTip, hideTip };
}

function styleAxis(g: Selection<SVGGElement, unknown, null, undefined>): void {
  g.selectAll("text").attr("fill", MUTED).attr("font-size", 11);
  g.selectAll("line").attr("stroke", GRID);
  g.select(".domain").attr("stroke", BASELINE);
}

// ===========================================================================
//  Progression : nuage (normal / entraînement) + moyenne mobile
// ===========================================================================
export type SeriesPoint = { y: number; label: string; category: string };

export function progressionChart(opts: {
  title: string;
  subtitle?: string;
  points: SeriesPoint[];
  categories: { key: string; label: string; color: string }[];
  yFormat?: (y: number) => string;
  maWindow?: number;
}): HTMLElement {
  const yFormat = opts.yFormat ?? ((y) => numFmt(y));
  const win = opts.maWindow ?? Math.max(3, Math.round(opts.points.length / 12));
  const c = makeCard(opts.title, opts.subtitle);
  c.card.append(legend(opts.categories.concat([{ key: "ma", label: `moyenne mobile (${win})`, color: INK }])));
  const pts = opts.points;
  if (pts.length < 2) return withEmpty(c.card);

  const W = 720, H = 250;
  const m = { top: 12, right: 16, bottom: 26, left: 46 };
  const svg = c.svg(W, H);

  const x = scaleLinear([0, pts.length - 1], [m.left, W - m.right]);
  const yExtent = extent(pts, (p) => p.y) as [number, number];
  const pad = (yExtent[1] - yExtent[0]) * 0.12 || 5;
  const y = scaleLinear([Math.max(0, yExtent[0] - pad), yExtent[1] + pad], [H - m.bottom, m.top]);

  // grille + axes
  const yAxis = svg.append("g").attr("transform", `translate(${m.left},0)`)
    .call(axisLeft(y).ticks(5).tickSize(-(W - m.left - m.right)).tickFormat((d) => yFormat(+d)));
  styleAxis(yAxis as never);
  const xAxis = svg.append("g").attr("transform", `translate(0,${H - m.bottom})`)
    .call(axisBottom(x).ticks(Math.min(8, pts.length)).tickFormat((d) => `#${+d + 1}`));
  styleAxis(xAxis as never);

  // moyenne mobile
  const ma = pts.map((_, i) => {
    const a = Math.max(0, i - win + 1);
    const slice = pts.slice(a, i + 1);
    return d3mean(slice, (p) => p.y)!;
  });
  svg.append("path")
    .attr("fill", "none").attr("stroke", INK).attr("stroke-width", 2).attr("opacity", 0.85)
    .attr("d", d3line<number>().x((_, i) => x(i)).y((v) => y(v)).curve(curveMonotoneX)(ma));

  const colorOf = (cat: string) => opts.categories.find((k) => k.key === cat)?.color ?? ACCENT;
  svg.append("g").selectAll("circle").data(pts).join("circle")
    .attr("cx", (_, i) => x(i)).attr("cy", (p) => y(p.y)).attr("r", 3.2)
    .attr("fill", (p) => colorOf(p.category)).attr("stroke", SURFACE).attr("stroke-width", 1);

  // survol
  const cross = svg.append("line").attr("y1", m.top).attr("y2", H - m.bottom)
    .attr("stroke", MUTED).attr("stroke-dasharray", "3 3").style("visibility", "hidden");
  const hi = svg.append("circle").attr("r", 5.5).attr("fill", "none").attr("stroke-width", 2).style("visibility", "hidden");
  svg.append("rect").attr("x", m.left).attr("y", m.top)
    .attr("width", W - m.left - m.right).attr("height", H - m.top - m.bottom)
    .attr("fill", "transparent")
    .on("mousemove", (event) => {
      const mx = pointer(event)[0];
      let i = Math.round(x.invert(mx));
      i = Math.max(0, Math.min(pts.length - 1, i));
      const p = pts[i]!;
      cross.attr("x1", x(i)).attr("x2", x(i)).style("visibility", "visible");
      hi.attr("cx", x(i)).attr("cy", y(p.y)).attr("stroke", colorOf(p.category)).style("visibility", "visible");
      c.showTip(event, `<b>${yFormat(p.y)}</b> · <span class="t-dim">moy. ${yFormat(ma[i]!)}</span><br>${p.label}`);
    })
    .on("mouseleave", () => {
      cross.style("visibility", "hidden");
      hi.style("visibility", "hidden");
      c.hideTip();
    });

  c.card.append(svg.node()!);
  return c.card;
}

// ===========================================================================
//  Histogramme (distribution) + repères statistiques
// ===========================================================================
export function histogramChart(opts: {
  title: string;
  subtitle?: string;
  values: number[];
  bins?: number;
  unit?: string;
  markers?: { value: number; label: string; color: string }[];
}): HTMLElement {
  const c = makeCard(opts.title, opts.subtitle);
  const vals = opts.values;
  if (vals.length < 3) return withEmpty(c.card);

  const W = 720, H = 230;
  const m = { top: 12, right: 16, bottom: 34, left: 40 };
  const svg = c.svg(W, H);

  const domain = extent(vals) as [number, number];
  const x = scaleLinear(domain, [m.left, W - m.right]).nice();
  const thresholds = opts.bins ?? Math.min(20, Math.max(6, Math.round(Math.sqrt(vals.length))));
  const bins = d3bin().domain(x.domain() as [number, number]).thresholds(thresholds)(vals);
  const y = scaleLinear([0, d3max(bins, (b) => b.length)!], [H - m.bottom, m.top]);

  const yAxis = svg.append("g").attr("transform", `translate(${m.left},0)`)
    .call(axisLeft(y).ticks(4).tickSize(-(W - m.left - m.right)));
  styleAxis(yAxis as never);
  const xAxis = svg.append("g").attr("transform", `translate(0,${H - m.bottom})`).call(axisBottom(x).ticks(6));
  styleAxis(xAxis as never);

  svg.append("g").selectAll("rect").data(bins).join("rect")
    .attr("x", (b) => x(b.x0!) + 1)
    .attr("y", (b) => y(b.length))
    .attr("width", (b) => Math.max(1, x(b.x1!) - x(b.x0!) - 2))
    .attr("height", (b) => y(0) - y(b.length))
    .attr("rx", 3)
    .attr("fill", (b) => {
      const t = (((b.x0! + b.x1!) / 2) - domain[0]) / ((domain[1] - domain[0]) || 1);
      return ramp(0.35 + 0.5 * t, ACCENT);
    })
    .on("mousemove", (event, b) =>
      c.showTip(event, `<b>${b.length}</b> test(s)<br><span class="t-dim">${numFmt(b.x0!)} – ${numFmt(b.x1!)}${opts.unit ? " " + opts.unit : ""}</span>`))
    .on("mouseleave", c.hideTip);

  for (const mk of opts.markers ?? []) {
    svg.append("line").attr("x1", x(mk.value)).attr("x2", x(mk.value)).attr("y1", m.top).attr("y2", H - m.bottom)
      .attr("stroke", mk.color).attr("stroke-width", 1.5).attr("stroke-dasharray", "4 3");
    svg.append("text").attr("x", x(mk.value)).attr("y", m.top + 10).attr("fill", mk.color)
      .attr("font-size", 10).attr("text-anchor", "middle").text(mk.label);
  }

  c.card.append(svg.node()!);
  return c.card;
}

// ===========================================================================
//  Nuage générique : quadrants, bulles, tendance (moindres carrés)
// ===========================================================================
export type ScatterPoint = { x: number; y: number; r?: number; tint?: string; tip: string };

export function scatterChart(opts: {
  title: string;
  subtitle?: string;
  points: ScatterPoint[];
  xLabel: string;
  yLabel: string;
  xFormat?: (v: number) => string;
  yFormat?: (v: number) => string;
  vLines?: { x: number; color?: string }[];
  hLines?: { y: number; color?: string }[];
  quadrants?: { xAt: "min" | "max"; yAt: "min" | "max"; label: string; tint: string }[];
  trendline?: boolean;
  height?: number;
}): HTMLElement {
  const xFormat = opts.xFormat ?? ((v) => numFmt(v));
  const yFormat = opts.yFormat ?? ((v) => numFmt(v));
  const c = makeCard(opts.title, opts.subtitle);
  const pts = opts.points;
  if (pts.length < 2) return withEmpty(c.card);

  const W = 720, H = opts.height ?? 320;
  const m = { top: 14, right: 18, bottom: 42, left: 54 };
  const svg = c.svg(W, H);

  const extraX = [...(opts.vLines?.map((l) => l.x) ?? [])];
  const extraY = [...(opts.hLines?.map((l) => l.y) ?? [])];
  const xd = extent([...pts.map((p) => p.x), ...extraX]) as [number, number];
  const yd = extent([...pts.map((p) => p.y), ...extraY]) as [number, number];
  const x = scaleLinear(xd, [m.left, W - m.right]).nice();
  const y = scaleLinear(yd, [H - m.bottom, m.top]).nice();

  const yAxis = svg.append("g").attr("transform", `translate(${m.left},0)`)
    .call(axisLeft(y).ticks(5).tickSize(-(W - m.left - m.right)).tickFormat((d) => yFormat(+d)));
  styleAxis(yAxis as never);
  const xAxis = svg.append("g").attr("transform", `translate(0,${H - m.bottom})`)
    .call(axisBottom(x).ticks(6).tickSize(-(H - m.top - m.bottom)).tickFormat((d) => xFormat(+d)));
  styleAxis(xAxis as never);

  // seuils
  for (const l of opts.vLines ?? [])
    svg.append("line").attr("x1", x(l.x)).attr("x2", x(l.x)).attr("y1", m.top).attr("y2", H - m.bottom)
      .attr("stroke", l.color ?? BASELINE).attr("stroke-width", 1.5).attr("stroke-dasharray", "5 4");
  for (const l of opts.hLines ?? [])
    svg.append("line").attr("x1", m.left).attr("x2", W - m.right).attr("y1", y(l.y)).attr("y2", y(l.y))
      .attr("stroke", l.color ?? BASELINE).attr("stroke-width", 1.5).attr("stroke-dasharray", "5 4");

  // étiquettes de quadrant (dans les coins)
  const xr = x.range(), yr = y.range();
  for (const q of opts.quadrants ?? []) {
    const qx = q.xAt === "min" ? xr[0]! + 8 : xr[1]! - 8;
    const qy = q.yAt === "max" ? yr[1]! + 14 : yr[0]! - 8;
    svg.append("text").attr("x", qx).attr("y", qy).attr("fill", q.tint).attr("font-size", 11)
      .attr("font-weight", 600).attr("opacity", 0.85)
      .attr("text-anchor", q.xAt === "min" ? "start" : "end").text(q.label);
  }

  // tendance
  if (opts.trendline && pts.length >= 3) {
    const mx = d3mean(pts, (p) => p.x)!;
    const my = d3mean(pts, (p) => p.y)!;
    let num = 0, den = 0;
    for (const p of pts) { num += (p.x - mx) * (p.y - my); den += (p.x - mx) ** 2; }
    if (den !== 0) {
      const slope = num / den, b = my - slope * mx;
      const [x0, x1] = x.domain() as [number, number];
      svg.append("line").attr("x1", x(x0)).attr("y1", y(slope * x0 + b)).attr("x2", x(x1)).attr("y2", y(slope * x1 + b))
        .attr("stroke", INK).attr("stroke-width", 1.5).attr("stroke-dasharray", "2 3").attr("opacity", 0.6);
    }
  }

  // points + survol par plus proche voisin (quadtree)
  const g = svg.append("g");
  g.selectAll("circle").data(pts).join("circle")
    .attr("cx", (p) => x(p.x)).attr("cy", (p) => y(p.y)).attr("r", (p) => 3 + (p.r ?? 1) * 2.2)
    .attr("fill", (p) => p.tint ?? ACCENT).attr("fill-opacity", 0.72)
    .attr("stroke", SURFACE).attr("stroke-width", 1);

  const tree = quadtree<ScatterPoint>().x((p) => x(p.x)).y((p) => y(p.y)).addAll(pts);
  const hi = svg.append("circle").attr("fill", "none").attr("stroke", INK).attr("stroke-width", 2).style("visibility", "hidden");
  svg.append("rect").attr("x", m.left).attr("y", m.top)
    .attr("width", W - m.left - m.right).attr("height", H - m.top - m.bottom).attr("fill", "transparent")
    .on("mousemove", (event) => {
      const [mx, my] = pointer(event);
      const p = tree.find(mx, my, 40);
      if (!p) { hi.style("visibility", "hidden"); c.hideTip(); return; }
      hi.attr("cx", x(p.x)).attr("cy", y(p.y)).attr("r", 4 + (p.r ?? 1) * 2.2).style("visibility", "visible");
      c.showTip(event, p.tip);
    })
    .on("mouseleave", () => { hi.style("visibility", "hidden"); c.hideTip(); });

  // titres d'axes
  svg.append("text").attr("x", (m.left + W - m.right) / 2).attr("y", H - 4).attr("fill", INK_2)
    .attr("font-size", 11).attr("text-anchor", "middle").text(opts.xLabel);
  svg.append("text").attr("x", 12).attr("y", (m.top + H - m.bottom) / 2).attr("fill", INK_2)
    .attr("font-size", 11).attr("text-anchor", "middle")
    .attr("transform", `rotate(-90 12 ${(m.top + H - m.bottom) / 2})`).text(opts.yLabel);

  c.card.append(svg.node()!);
  return c.card;
}

// ===========================================================================
//  Densité (hexbin) — carte de densité vitesse × précision des tests
// ===========================================================================
export function densityHexbin(opts: {
  title: string;
  subtitle?: string;
  points: { x: number; y: number }[];
  xLabel: string;
  yLabel: string;
  xFormat?: (v: number) => string;
  yFormat?: (v: number) => string;
  hue?: string;
}): HTMLElement {
  const xFormat = opts.xFormat ?? ((v) => numFmt(v));
  const yFormat = opts.yFormat ?? ((v) => numFmt(v));
  const hue = opts.hue ?? ACCENT;
  const c = makeCard(opts.title, opts.subtitle);
  const pts = opts.points;
  if (pts.length < 8) return withEmpty(c.card, "Il faut une dizaine de tests pour dessiner la densité.");

  const W = 720, H = 320;
  const m = { top: 14, right: 18, bottom: 42, left: 54 };
  const svg = c.svg(W, H);

  const x = scaleLinear(extent(pts, (p) => p.x) as [number, number], [m.left, W - m.right]).nice();
  const y = scaleLinear(extent(pts, (p) => p.y) as [number, number], [H - m.bottom, m.top]).nice();

  const yAxis = svg.append("g").attr("transform", `translate(${m.left},0)`)
    .call(axisLeft(y).ticks(5).tickSize(-(W - m.left - m.right)).tickFormat((d) => yFormat(+d)));
  styleAxis(yAxis as never);
  const xAxis = svg.append("g").attr("transform", `translate(0,${H - m.bottom})`)
    .call(axisBottom(x).ticks(6).tickFormat((d) => xFormat(+d)));
  styleAxis(xAxis as never);

  const hb = d3hexbin<{ x: number; y: number }>()
    .x((p) => x(p.x)).y((p) => y(p.y)).radius(20)
    .extent([[m.left, m.top], [W - m.right, H - m.bottom]]);
  const bins = hb(pts);
  const maxCount = d3max(bins, (b) => b.length) ?? 1;

  svg.append("g").attr("clip-path", "none").selectAll("path").data(bins).join("path")
    .attr("d", hb.hexagon())
    .attr("transform", (b) => `translate(${b.x},${b.y})`)
    .attr("fill", (b) => ramp(0.2 + 0.8 * (b.length / maxCount), hue))
    .attr("stroke", SURFACE).attr("stroke-width", 0.5)
    .on("mousemove", (event, b) =>
      c.showTip(event, `<b>${b.length}</b> test(s)<br><span class="t-dim">≈ ${xFormat(x.invert(b.x))} · ${yFormat(y.invert(b.y))}</span>`))
    .on("mouseleave", c.hideTip);

  svg.append("text").attr("x", (m.left + W - m.right) / 2).attr("y", H - 4).attr("fill", INK_2)
    .attr("font-size", 11).attr("text-anchor", "middle").text(opts.xLabel);
  svg.append("text").attr("x", 12).attr("y", (m.top + H - m.bottom) / 2).attr("fill", INK_2)
    .attr("font-size", 11).attr("text-anchor", "middle")
    .attr("transform", `rotate(-90 12 ${(m.top + H - m.bottom) / 2})`).text(opts.yLabel);

  c.card.append(svg.node()!);
  c.card.append(rampLegend(1, maxCount, hue, (v) => numFmt(v) + " test(s)"));
  return c.card;
}

// ===========================================================================
//  Heatmap (matrice) — bigrammes lettre × lettre
// ===========================================================================
export function heatmap(opts: {
  title: string;
  subtitle?: string;
  rows: string[];
  cols: string[];
  value: (row: string, col: string) => number | null;
  tip: (row: string, col: string, v: number) => string;
  hue: string;
  legendFormat?: (v: number) => string;
}): HTMLElement {
  const c = makeCard(opts.title, opts.subtitle);
  const { rows, cols } = opts;
  if (rows.length === 0 || cols.length === 0) return withEmpty(c.card);

  let vMin = Infinity, vMax = -Infinity;
  for (const r of rows) for (const col of cols) {
    const v = opts.value(r, col);
    if (v !== null) { vMin = Math.min(vMin, v); vMax = Math.max(vMax, v); }
  }
  if (!isFinite(vMin)) return withEmpty(c.card);
  const span = vMax - vMin || 1;

  const cell = 26, pad = 22;
  const W = pad + cols.length * cell, H = pad + rows.length * cell;
  const svg = c.svg(W, H);
  svg.style("max-width", `${W}px`);

  const xs = scaleBand(cols, [pad, W]);
  const ys = scaleBand(rows, [pad, H]);

  svg.append("g").selectAll("text").data(cols).join("text")
    .attr("x", (d) => xs(d)! + cell / 2).attr("y", 14).attr("fill", MUTED)
    .attr("font-size", 11).attr("text-anchor", "middle").attr("font-family", "var(--mono)").text((d) => d);
  svg.append("g").selectAll("text").data(rows).join("text")
    .attr("x", 12).attr("y", (d) => ys(d)! + cell / 2 + 4).attr("fill", MUTED)
    .attr("font-size", 11).attr("text-anchor", "middle").attr("font-family", "var(--mono)").text((d) => d);

  const cellsData: { r: string; col: string; v: number | null }[] = [];
  for (const r of rows) for (const col of cols) cellsData.push({ r, col, v: opts.value(r, col) });

  svg.append("g").selectAll("rect").data(cellsData).join("rect")
    .attr("x", (d) => xs(d.col)! + 1).attr("y", (d) => ys(d.r)! + 1)
    .attr("width", cell - 2).attr("height", cell - 2).attr("rx", 3)
    .attr("fill", (d) => d.v === null ? "#161615" : ramp((d.v - vMin) / span, opts.hue))
    .style("cursor", (d) => d.v === null ? "default" : "pointer")
    .on("mousemove", function (event, d) {
      if (d.v === null) return;
      select(this).attr("stroke", INK).attr("stroke-width", 1.5);
      c.showTip(event, opts.tip(d.r, d.col, d.v));
    })
    .on("mouseleave", function () { select(this).attr("stroke", null); c.hideTip(); });

  const wrap = document.createElement("div");
  wrap.className = "heatmap-scroll";
  wrap.append(svg.node()!);
  c.card.append(wrap);
  c.card.append(rampLegend(vMin, vMax, opts.hue, opts.legendFormat ?? ((v) => numFmt(v))));
  return c.card;
}

// ===========================================================================
//  Barres horizontales (top mots / positions)
// ===========================================================================
export function barChart(opts: {
  title: string;
  subtitle?: string;
  items: { label: string; value: number; tint?: string; sub?: string; mono?: boolean }[];
  format?: (v: number) => string;
  max?: number;
}): HTMLElement {
  const format = opts.format ?? ((v) => numFmt(v));
  const c = makeCard(opts.title, opts.subtitle);
  if (opts.items.length === 0) return withEmpty(c.card);
  const max = opts.max ?? Math.max(...opts.items.map((i) => i.value), 1e-9);

  const list = document.createElement("div");
  list.className = "bar-list";
  for (const it of opts.items) {
    const row = document.createElement("div");
    row.className = "bar-row";
    const lab = document.createElement("span");
    lab.className = "bar-label" + (it.mono ? " mono" : "");
    lab.textContent = it.label;
    const track = document.createElement("div");
    track.className = "bar-track";
    const fill = document.createElement("div");
    fill.className = "bar-fill";
    fill.style.width = `${Math.max(2, (it.value / max) * 100)}%`;
    fill.style.background = it.tint ?? ACCENT;
    track.append(fill);
    const val = document.createElement("span");
    val.className = "bar-value";
    val.textContent = format(it.value);
    if (it.sub) {
      const sub = document.createElement("span");
      sub.className = "bar-sub";
      sub.textContent = it.sub;
      val.append(sub);
    }
    row.append(lab, track, val);
    row.title = `${it.label} — ${format(it.value)}${it.sub ? " · " + it.sub : ""}`;
    list.append(row);
  }
  c.card.append(list);
  return c.card;
}

// ===========================================================================
//  Calendrier d'activité (type contributions)
// ===========================================================================
export function calendarHeatmap(opts: {
  title: string;
  subtitle?: string;
  counts: Map<string, number>;
  weeks?: number;
  hue?: string;
}): HTMLElement {
  const c = makeCard(opts.title, opts.subtitle);
  const weeks = opts.weeks ?? 26;
  const hue = opts.hue ?? STATUS.good;
  const cell = 14, gap = 3, topPad = 16, leftPad = 26;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dow = (today.getDay() + 6) % 7;
  const end = new Date(today);
  end.setDate(end.getDate() - dow + 6);
  const start = new Date(end);
  start.setDate(start.getDate() - (weeks * 7 - 1));

  let maxCount = 0;
  for (const v of opts.counts.values()) maxCount = Math.max(maxCount, v);
  if (maxCount === 0) return withEmpty(c.card, "Aucune journée d'activité pour l'instant.");

  const W = leftPad + weeks * (cell + gap), H = topPad + 7 * (cell + gap);
  const svg = c.svg(W, H);
  svg.style("max-width", `${W}px`);

  const key = (dt: Date) =>
    `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
  const dayLabels = ["L", "", "M", "", "J", "", "D"];
  const monthNames = ["janv", "févr", "mars", "avr", "mai", "juin", "juil", "août", "sept", "oct", "nov", "déc"];
  for (let d = 0; d < 7; d++)
    if (dayLabels[d]) svg.append("text").attr("x", 14).attr("y", topPad + d * (cell + gap) + cell - 2)
      .attr("fill", MUTED).attr("font-size", 9).attr("text-anchor", "middle").text(dayLabels[d]!);

  let lastMonth = -1;
  for (let w = 0; w < weeks; w++) for (let d = 0; d < 7; d++) {
    const dt = new Date(start);
    dt.setDate(dt.getDate() + w * 7 + d);
    if (dt > today) continue;
    const px = leftPad + w * (cell + gap), py = topPad + d * (cell + gap);
    if (d === 0 && dt.getMonth() !== lastMonth) {
      lastMonth = dt.getMonth();
      svg.append("text").attr("x", px).attr("y", 10).attr("fill", MUTED).attr("font-size", 9).text(monthNames[dt.getMonth()]!);
    }
    const cnt = opts.counts.get(key(dt)) ?? 0;
    const t = cnt === 0 ? 0 : 0.25 + 0.75 * (cnt / maxCount);
    const label = dt.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
    svg.append("rect").attr("x", px).attr("y", py).attr("width", cell).attr("height", cell).attr("rx", 3)
      .attr("fill", cnt === 0 ? "#1d1d1b" : ramp(t, hue))
      .on("mousemove", function (event) { select(this).attr("stroke", INK); c.showTip(event, `<b>${cnt}</b> test(s)<br><span class="t-dim">${label}</span>`); })
      .on("mouseleave", function () { select(this).attr("stroke", null); c.hideTip(); });
  }

  const wrap = document.createElement("div");
  wrap.className = "heatmap-scroll";
  wrap.append(svg.node()!);
  c.card.append(wrap);
  return c.card;
}

// ---- helpers statistiques exportés ----------------------------------------
export function stats(values: number[]): { mean: number; median: number; q1: number; q3: number; sd: number } | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mean = d3mean(sorted)!;
  const sd = Math.sqrt(d3mean(sorted, (v) => (v - mean) ** 2)!);
  return {
    mean,
    median: quantile(sorted, 0.5)!,
    q1: quantile(sorted, 0.25)!,
    q3: quantile(sorted, 0.75)!,
    sd,
  };
}

/** Coefficient de corrélation de Pearson, ou null si indéfini. */
export function pearson(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  const mx = d3mean(xs)!, my = d3mean(ys)!;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    dx += (xs[i]! - mx) ** 2;
    dy += (ys[i]! - my) ** 2;
  }
  const den = Math.sqrt(dx * dy);
  return den === 0 ? null : num / den;
}

// ---- petits composants partagés -------------------------------------------
export function legend(items: { label: string; color: string }[]): HTMLElement {
  const box = document.createElement("div");
  box.className = "chart-legend";
  for (const it of items) {
    const chip = document.createElement("span");
    chip.className = "leg-item";
    const dot = document.createElement("span");
    dot.className = "leg-dot";
    dot.style.background = it.color;
    chip.append(dot, document.createTextNode(it.label));
    box.append(chip);
  }
  return box;
}

function rampLegend(min: number, max: number, hue: string, fmt: (v: number) => string): HTMLElement {
  const box = document.createElement("div");
  box.className = "ramp-legend";
  const bar = document.createElement("span");
  bar.className = "ramp-bar";
  bar.style.background = `linear-gradient(to right, ${ramp(0, hue)}, ${ramp(0.5, hue)}, ${ramp(1, hue)})`;
  const lo = document.createElement("span");
  lo.textContent = fmt(min);
  const hi = document.createElement("span");
  hi.textContent = fmt(max);
  box.append(lo, bar, hi);
  return box;
}

function withEmpty(card: HTMLDivElement, text = "Pas encore assez de données — fais quelques tests !"): HTMLDivElement {
  const n = document.createElement("div");
  n.className = "empty-note";
  n.textContent = text;
  card.append(n);
  return card;
}
