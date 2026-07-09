import { loadConfig } from "../config";
import {
  bigramAvgGap,
  exportData,
  importData,
  loadBigramStats,
  loadHistory,
  loadTestLog,
  loadWordStats,
  resetData,
  wordAvgWpm,
  wordErrRate,
  wordPosErrorRates,
} from "../store";
import type {
  BigramStat,
  Config,
  HistoryEntry,
  LangId,
  TestLog,
  WordStat,
} from "../types";
import { LANGS } from "../wordlist";
import { practicePool } from "../wordlist";
import { el, fmt, fmtPct, toast, wordClasses } from "./common";
import {
  ACCENT,
  PACE,
  STATUS,
  barChart,
  calendarHeatmap,
  densityHexbin,
  heatmap,
  histogramChart,
  pearson,
  progressionChart,
  ramp,
  scatterChart,
  stats as summary,
} from "./charts";

type Tab = "progression" | "mots" | "biais" | "bigrammes" | "activite";
type SortKey = "word" | "attempts" | "wpm" | "errRate" | "errors";

const TABS: { key: Tab; label: string }[] = [
  { key: "progression", label: "Progression" },
  { key: "mots", label: "Mots" },
  { key: "biais", label: "Biais" },
  { key: "bigrammes", label: "Bigrammes" },
  { key: "activite", label: "Activité" },
];

export function mountStatsView(root: HTMLElement, signal: AbortSignal): void {
  const cfg = loadConfig();
  // état local (n'altère pas la config globale)
  let lang: LangId = cfg.lang;
  let tab: Tab = "progression";
  let range = 0; // 0 = tout, sinon N derniers tests

  root.innerHTML = "";

  // --- en-tête ---
  const header = el("div", "stats-header");
  header.append(el("h2", "page-title", "Statistiques"));
  const langSel = el("select");
  for (const id of Object.keys(LANGS) as LangId[]) {
    const opt = el("option", undefined, LANGS[id].label);
    opt.value = id;
    if (id === lang) opt.selected = true;
    langSel.append(opt);
  }
  langSel.addEventListener(
    "change",
    () => {
      lang = langSel.value as LangId;
      renderTab();
    },
    { signal }
  );
  header.append(langSel);
  root.append(header);

  // --- barre d'onglets ---
  const tabBar = el("div", "tab-bar");
  const tabBtns = new Map<Tab, HTMLElement>();
  for (const t of TABS) {
    const btn = el("button", "tab-btn", t.label);
    btn.addEventListener(
      "click",
      () => {
        tab = t.key;
        renderTab();
      },
      { signal }
    );
    tabBtns.set(t.key, btn);
    tabBar.append(btn);
  }
  root.append(tabBar);

  const content = el("div", "tab-content");
  root.append(content);

  function renderTab(): void {
    for (const [key, btn] of tabBtns) btn.classList.toggle("active", key === tab);
    content.innerHTML = "";
    const words = loadWordStats(lang);
    const bigrams = loadBigramStats(lang);
    const history = loadHistory().filter((h) => h.lang === lang);

    switch (tab) {
      case "progression":
        renderProgression(content, cfg, history, words, () => range, (r) => (range = r), renderTab, signal);
        break;
      case "mots":
        renderWords(content, cfg, lang, words, signal);
        break;
      case "biais":
        renderBias(content, loadTestLog(lang), signal);
        break;
      case "bigrammes":
        renderBigrams(content, bigrams);
        break;
      case "activite":
        renderActivity(content, history, root, signal);
        break;
    }
  }
  renderTab();
}

// ===========================================================================
//  Onglet Progression
// ===========================================================================
function renderProgression(
  root: HTMLElement,
  cfg: Config,
  fullHistory: HistoryEntry[],
  words: Record<string, WordStat>,
  getRange: () => number,
  setRange: (r: number) => void,
  rerender: () => void,
  signal: AbortSignal
): void {
  if (fullHistory.length === 0) {
    root.append(el("div", "empty-note", "Aucun test enregistré dans cette langue — lance-toi !"));
    return;
  }
  const range = getRange();
  const history = range > 0 ? fullHistory.slice(-range) : fullHistory;

  // --- tuiles de synthèse ---
  const wpms = history.map((h) => h.wpm);
  const stat = summary(wpms);
  const best = Math.max(...fullHistory.map((h) => h.wpm));
  const recent = fullHistory.slice(-10);
  const avgRecent = recent.reduce((s, h) => s + h.wpm, 0) / recent.length;
  const avgAcc = history.reduce((s, h) => s + h.accuracy, 0) / history.length;
  const totalMs = fullHistory.reduce((s, h) => s + h.durationMs, 0);
  const trackedWords = Object.keys(words).length;

  const cards = el("div", "cards-row");
  const mk = (label: string, value: string, hint?: string) => {
    const tile = el("div", "tile");
    tile.append(el("div", "label", label), el("div", "value", value));
    if (hint) tile.append(el("div", "tile-hint", hint));
    return tile;
  };
  cards.append(
    mk("tests", fmt(fullHistory.length)),
    mk("wpm moyen", fmt(avgRecent), "10 derniers"),
    mk("record", fmt(best)),
    mk("précision", fmtPct(avgAcc)),
    mk("régularité", stat ? "± " + fmt(stat.sd) : "—", "écart-type wpm"),
    mk("temps frappé", fmtDuration(totalMs)),
    mk("mots suivis", fmt(trackedWords))
  );
  root.append(cards);

  // --- filtre de plage ---
  const filters = el("div", "filters-row");
  filters.append(el("span", undefined, "Plage :"));
  const ranges: { label: string; value: number }[] = [
    { label: "30 derniers", value: 30 },
    { label: "100 derniers", value: 100 },
    { label: "tout", value: 0 },
  ];
  for (const r of ranges) {
    const btn = el("button", "pill" + (getRange() === r.value ? " on" : ""), r.label);
    btn.addEventListener("click", () => { setRange(r.value); rerender(); }, { signal });
    filters.append(btn);
  }
  root.append(filters);

  // --- progression wpm ---
  root.append(
    progressionChart({
      title: "Progression du WPM",
      subtitle: `${history.length} test(s)`,
      points: history.map((h) => ({
        y: h.wpm,
        category: h.mode,
        label: `<span class="t-dim">${fmtDate(h.date)} · ${fmtPct(h.accuracy)} · ${h.mode === "practice" ? "entraînement" : "normal"}</span>`,
      })),
      categories: [
        { key: "normal", label: "normal", color: ACCENT },
        { key: "practice", label: "entraînement", color: STATUS.serious },
      ],
    })
  );

  // --- distribution ---
  if (stat) {
    root.append(
      histogramChart({
        title: "Distribution du WPM",
        subtitle: `médiane ${fmt(stat.median)} · Q1 ${fmt(stat.q1)} · Q3 ${fmt(stat.q3)}`,
        values: wpms,
        unit: "wpm",
        markers: [
          { value: stat.q1, label: "Q1", color: STATUS.warning },
          { value: stat.median, label: "méd.", color: ACCENT },
          { value: stat.q3, label: "Q3", color: STATUS.good },
        ],
      })
    );
  }

  // --- vitesse vs précision ---
  const accs = history.map((h) => h.accuracy * 100);
  const r = pearson(wpms, accs);
  root.append(
    scatterChart({
      title: "Vitesse vs précision",
      subtitle: r !== null ? `corrélation r = ${fmt(r, 2)}` : undefined,
      points: history.map((h) => ({
        x: h.wpm,
        y: h.accuracy * 100,
        tint: h.mode === "practice" ? STATUS.serious : ACCENT,
        tip: `<b>${fmt(h.wpm)} wpm</b> · ${fmtPct(h.accuracy)}<br><span class="t-dim">${fmtDate(h.date)}</span>`,
      })),
      xLabel: "WPM",
      yLabel: "précision (%)",
      yFormat: (v) => fmt(v) + " %",
      trendline: true,
      height: 300,
    })
  );

  // --- densité ---
  root.append(
    densityHexbin({
      title: "Densité vitesse × précision",
      subtitle: "où se concentrent tes tests",
      points: history.map((h) => ({ x: h.wpm, y: h.accuracy * 100 })),
      xLabel: "WPM",
      yLabel: "précision (%)",
      yFormat: (v) => fmt(v) + " %",
    })
  );
}

// ===========================================================================
//  Onglet Mots
// ===========================================================================
function renderWords(
  root: HTMLElement,
  cfg: Config,
  lang: LangId,
  words: Record<string, WordStat>,
  signal: AbortSignal
): void {
  const entries = Object.entries(words);
  if (entries.length === 0) {
    root.append(el("div", "empty-note", "Aucune donnée de mot — fais quelques tests !"));
    return;
  }

  // --- nuage quadrant vitesse × fautes ---
  const scatterPts = entries
    .map(([word, s]) => ({ word, s, wpm: wordAvgWpm(s), err: wordErrRate(s) }))
    .filter((d) => d.wpm !== null && d.s.attempts >= cfg.minAttempts)
    .map((d) => {
      const slow = d.wpm! <= cfg.slowWpm;
      const faulty = d.err >= cfg.errWarnRate;
      const tint = slow && faulty ? STATUS.critical : faulty ? STATUS.serious : slow ? STATUS.warning : STATUS.good;
      return {
        x: d.wpm!,
        y: d.err * 100,
        r: Math.min(3, Math.log2(d.s.attempts + 1) / 2),
        tint,
        tip: `<b class="mono">${d.word}</b><br><span class="t-dim">${fmt(d.wpm!)} wpm · ${fmtPct(d.err)} fautés · ${d.s.attempts} essais</span>`,
      };
    });

  root.append(
    scatterChart({
      title: "Cartographie des mots",
      subtitle: "taille = nombre d'essais · couleur = quadrant",
      points: scatterPts,
      xLabel: "WPM moyen",
      yLabel: "% essais fautés",
      yFormat: (v) => fmt(v) + " %",
      vLines: [{ x: cfg.slowWpm, color: STATUS.warning }],
      hLines: [{ y: cfg.errWarnRate * 100, color: STATUS.critical }],
      quadrants: [
        { xAt: "min", yAt: "max", label: "à retravailler", tint: STATUS.critical },
        { xAt: "max", yAt: "max", label: "fautifs", tint: STATUS.serious },
        { xAt: "min", yAt: "min", label: "lents", tint: STATUS.warning },
        { xAt: "max", yAt: "min", label: "maîtrisés", tint: STATUS.good },
      ],
      height: 340,
    })
  );

  // --- top mots à travailler ---
  const pool = practicePool(lang, cfg, words).slice(0, 12);
  if (pool.length > 0) {
    root.append(
      barChart({
        title: "Priorités d'entraînement",
        subtitle: "score de difficulté (fautes pondérées + lenteur)",
        items: pool.map((p) => ({
          label: p.word,
          value: p.score,
          mono: true,
          tint: ramp(0.4 + 0.6 * Math.min(1, p.score / 2), STATUS.critical),
          sub: `${p.avgWpm === null ? "—" : fmt(p.avgWpm)} wpm · ${fmtPct(p.errRate)}`,
        })),
        format: (v) => fmt(v, 2),
      })
    );
  }

  // --- où l'on faute dans le mot (par position) ---
  const posAgg = aggregatePositions(words);
  if (posAgg.length > 0) {
    root.append(
      barChart({
        title: "Où l'on faute dans le mot",
        subtitle: "taux de faute moyen par position (pondéré par les essais)",
        items: posAgg.map((p, i) => ({
          label: `pos. ${i + 1}`,
          value: p * 100,
          tint: ramp(0.3 + 0.7 * Math.min(1, p / 0.3), STATUS.serious),
        })),
        format: (v) => fmt(v, 1) + " %",
      })
    );
  }

  // --- tableau détaillé ---
  root.append(buildWordTable(cfg, words, signal));
}

function aggregatePositions(words: Record<string, WordStat>): number[] {
  const sumRate: number[] = [];
  const sumWeight: number[] = [];
  for (const s of Object.values(words)) {
    if (s.attempts < 1) continue;
    // longueur estimée = longueur du tableau de positions
    const len = s.posErrors?.length ?? 0;
    const rates = wordPosErrorRates(s, len);
    for (let p = 0; p < rates.length; p++) {
      sumRate[p] = (sumRate[p] ?? 0) + rates[p]! * s.attempts;
      sumWeight[p] = (sumWeight[p] ?? 0) + s.attempts;
    }
  }
  const out: number[] = [];
  for (let p = 0; p < Math.min(14, sumRate.length); p++) {
    if ((sumWeight[p] ?? 0) === 0) break;
    out.push(sumRate[p]! / sumWeight[p]!);
  }
  return out;
}

function buildWordTable(cfg: Config, stats: Record<string, WordStat>, signal: AbortSignal): HTMLElement {
  const box = el("div", "chart-card");
  box.append(cardHead("Détail par mot"));
  let search = "";
  let minAttempts = 1;
  let sortKey: SortKey = "errRate";
  let sortDesc = true;

  const filters = el("div", "filters-row");
  const searchInput = el("input");
  searchInput.type = "text";
  searchInput.placeholder = "Rechercher un mot…";
  searchInput.addEventListener("input", () => { search = searchInput.value.trim().toLowerCase(); render(); }, { signal });
  const minLabel = el("label", undefined, "essais min ");
  const minInput = el("input");
  minInput.type = "number";
  minInput.min = "1";
  minInput.value = String(minAttempts);
  minInput.style.width = "70px";
  minInput.addEventListener("change", () => { minAttempts = Math.max(1, Number(minInput.value) || 1); render(); }, { signal });
  minLabel.append(minInput);
  filters.append(searchInput, minLabel);
  box.append(filters);

  const tableWrap = el("div", "table-scroll");
  box.append(tableWrap);

  function render(): void {
    tableWrap.innerHTML = "";
    const rows = Object.entries(stats)
      .filter(([w, s]) => s.attempts >= minAttempts && (search === "" || w.toLowerCase().includes(search)))
      .map(([word, s]) => ({ word, stat: s, attempts: s.attempts, wpm: wordAvgWpm(s), errRate: wordErrRate(s), errors: s.errors }));
    if (rows.length === 0) {
      tableWrap.append(el("div", "empty-note", "Aucun mot ne correspond."));
      return;
    }
    rows.sort((a, b) => {
      let diff: number;
      switch (sortKey) {
        case "word": diff = a.word.localeCompare(b.word, "fr"); break;
        case "attempts": diff = a.attempts - b.attempts; break;
        case "wpm": diff = (a.wpm ?? Infinity) - (b.wpm ?? Infinity); break;
        case "errors": diff = a.errors - b.errors; break;
        default: diff = a.errRate - b.errRate;
      }
      return sortDesc ? -diff : diff;
    });

    const table = el("table", "data");
    const thead = el("thead");
    const headRow = el("tr");
    const cols: { key: SortKey; label: string; num: boolean }[] = [
      { key: "word", label: "mot", num: false },
      { key: "attempts", label: "essais", num: true },
      { key: "wpm", label: "wpm moyen", num: true },
      { key: "errRate", label: "% fautés", num: true },
      { key: "errors", label: "erreurs", num: true },
    ];
    for (const col of cols) {
      const th = el("th", col.num ? "num" : undefined, col.label);
      if (sortKey === col.key) { th.classList.add("sorted"); th.textContent += sortDesc ? " ↓" : " ↑"; }
      th.addEventListener("click", () => {
        if (sortKey === col.key) sortDesc = !sortDesc;
        else { sortKey = col.key; sortDesc = col.key !== "word"; }
        render();
      });
      headRow.append(th);
    }
    thead.append(headRow);
    table.append(thead);

    const tbody = el("tbody");
    for (const rrow of rows.slice(0, 200)) {
      const tr = el("tr");
      const tdWord = el("td");
      const chip = el("span", "word-chip", rrow.word);
      for (const cclass of wordClasses(rrow.stat, { ...cfg, colorBy: "both" })) chip.classList.add(cclass);
      tdWord.append(chip);
      const spark = posSparkline(rrow.word, rrow.stat);
      if (spark) tdWord.append(spark);
      tr.append(
        tdWord,
        el("td", "num", fmt(rrow.attempts)),
        el("td", "num", rrow.wpm === null ? "—" : fmt(rrow.wpm)),
        el("td", "num", fmtPct(rrow.errRate)),
        el("td", "num", fmt(rrow.errors))
      );
      tbody.append(tr);
    }
    table.append(tbody);
    tableWrap.append(table);
    if (rows.length > 200) tableWrap.append(el("div", "empty-note", `${rows.length - 200} mots masqués — affine la recherche.`));
  }
  render();
  return box;
}

/** Mini barres de taux de faute par position, superposées au mot. */
function posSparkline(word: string, s: WordStat): SVGSVGElement | null {
  const len = word.length;
  if (len === 0 || s.attempts === 0) return null;
  const rates = wordPosErrorRates(s, len);
  if (rates.every((r) => r === 0)) return null;
  const NS = "http://www.w3.org/2000/svg";
  const cw = 7, h = 12;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${len * cw} ${h}`);
  svg.setAttribute("width", String(len * cw));
  svg.setAttribute("height", String(h));
  svg.classList.add("pos-spark");
  for (let p = 0; p < len; p++) {
    const rate = rates[p] ?? 0;
    const bh = Math.max(rate > 0 ? 1.5 : 0, rate * h);
    const rect = document.createElementNS(NS, "rect");
    rect.setAttribute("x", String(p * cw + 0.5));
    rect.setAttribute("y", String(h - bh));
    rect.setAttribute("width", String(cw - 1));
    rect.setAttribute("height", String(bh));
    rect.setAttribute("rx", "1");
    rect.setAttribute("fill", rate > 0 ? ramp(0.3 + 0.7 * Math.min(1, rate / 0.4), STATUS.critical) : "#2a2617");
    svg.append(rect);
  }
  const worst = rates.indexOf(Math.max(...rates));
  svg.setAttribute("title", `${word} — position la plus fautée : ${worst + 1} (${fmtPct(rates[worst] ?? 0)})`);
  return svg;
}

// ===========================================================================
//  Onglet Biais — influence du contexte (position, rythme, longueur, mode)
// ===========================================================================

/** Un mot tapé, aplati depuis le journal, avec le contexte de son test. */
type BiasWord = {
  len: number;
  index: number;
  wordCount: number;
  pace: boolean;
  mode: TestLog["mode"];
  timeMs: number | null;
  errors: number;
};

type Dimension = {
  key: string;
  label: string;
  hint: string;
  buckets: string[]; // ordre d'affichage
  of: (w: BiasWord) => string | null; // null = mot exclu de cette dimension
};

const BIAS_DIMS: Dimension[] = [
  {
    key: "position",
    label: "Position dans le test",
    hint: "le mot est-il moins bon en fin de test (fatigue) ?",
    buckets: ["début", "milieu", "fin"],
    of: (w) => {
      if (w.wordCount <= 1) return null;
      const rel = w.index / (w.wordCount - 1);
      return rel < 1 / 3 ? "début" : rel < 2 / 3 ? "milieu" : "fin";
    },
  },
  {
    key: "pace",
    label: "Rythme",
    hint: "le curseur de rythme accélère-t-il / ajoute-t-il des fautes ?",
    buckets: ["avec rythme", "sans rythme"],
    of: (w) => (w.pace ? "avec rythme" : "sans rythme"),
  },
  {
    key: "len",
    label: "Longueur du mot",
    hint: "les mots courts ou longs sont-ils plus rapides / plus fautés ?",
    buckets: ["≤ 3", "4–5", "6–7", "≥ 8"],
    of: (w) =>
      w.len <= 3 ? "≤ 3" : w.len <= 5 ? "4–5" : w.len <= 7 ? "6–7" : "≥ 8",
  },
  {
    key: "mode",
    label: "Mode",
    hint: "test normal vs entraînement ciblé",
    buckets: ["normal", "entraînement"],
    of: (w) => (w.mode === "practice" ? "entraînement" : "normal"),
  },
];

type Bucket = {
  label: string;
  words: number; // mots atteints
  errWords: number; // mots avec ≥ 1 faute
  timedWords: number; // mots chronométrés (tapés en entier)
  timedChars: number;
  timedMs: number;
};

const bucketWpm = (b: Bucket): number | null =>
  b.timedMs > 0 ? b.timedChars / 5 / (b.timedMs / 60000) : null;
const bucketErrRate = (b: Bucket): number =>
  b.words > 0 ? b.errWords / b.words : 0;

function computeBuckets(words: BiasWord[], dim: Dimension): Bucket[] {
  const map = new Map<string, Bucket>();
  for (const label of dim.buckets) {
    map.set(label, { label, words: 0, errWords: 0, timedWords: 0, timedChars: 0, timedMs: 0 });
  }
  for (const w of words) {
    const label = dim.of(w);
    if (label === null) continue;
    const b = map.get(label);
    if (!b) continue;
    b.words += 1;
    if (w.errors > 0) b.errWords += 1;
    if (w.timeMs !== null && w.timeMs > 0) {
      b.timedWords += 1;
      b.timedChars += w.len;
      b.timedMs += w.timeMs;
    }
  }
  return dim.buckets.map((l) => map.get(l)!).filter((b) => b.words > 0);
}

function renderBias(root: HTMLElement, logs: TestLog[], signal: AbortSignal): void {
  const words: BiasWord[] = [];
  for (const t of logs) {
    for (const w of t.words) {
      words.push({
        len: w.len,
        index: w.index,
        wordCount: t.wordCount,
        pace: t.pace,
        mode: t.mode,
        timeMs: w.timeMs,
        errors: w.errors,
      });
    }
  }

  if (words.length === 0) {
    root.append(
      el(
        "div",
        "empty-note",
        "Aucune donnée d'analyse — le journal se remplit à chaque test, même abandonné. Fais quelques tests !"
      )
    );
    return;
  }

  const aborted = logs.filter((t) => !t.completed).length;
  const intro = el("div", "empty-note");
  intro.textContent =
    `${fmt(words.length)} mots analysés sur ${fmt(logs.length)} test(s)` +
    (aborted > 0 ? ` (dont ${fmt(aborted)} abandonné(s))` : "") +
    ". Vitesse et taux de faute selon le contexte — méfie-toi des petits échantillons.";
  root.append(intro);

  // --- sélecteur de dimension ---
  let dim = BIAS_DIMS[0] as Dimension;
  const toggle = el("div", "seg-toggle");
  for (const d of BIAS_DIMS) {
    const btn = el("button", "seg-btn" + (d.key === dim.key ? " on" : ""), d.label);
    btn.dataset["dim"] = d.key;
    btn.addEventListener("click", () => { dim = d; renderDim(); }, { signal });
    toggle.append(btn);
  }
  const charts = el("div");
  root.append(toggle, charts);

  function renderDim(): void {
    for (const b of toggle.querySelectorAll("button")) b.classList.remove("on");
    toggle.querySelector(`[data-dim="${dim.key}"]`)?.classList.add("on");
    charts.innerHTML = "";
    const buckets = computeBuckets(words, dim);
    if (buckets.length === 0) {
      charts.append(el("div", "empty-note", "Pas de données pour cette dimension."));
      return;
    }
    const speedTint = dim.key === "pace" ? PACE : ACCENT;

    const cols = el("div", "two-cols");
    cols.append(
      barChart({
        title: "Vitesse par tranche",
        subtitle: dim.hint,
        items: buckets.map((b) => {
          const wpm = bucketWpm(b);
          return {
            label: b.label,
            value: wpm ?? 0,
            tint: wpm === null ? STATUS.warning : speedTint,
            sub: wpm === null ? "aucun mot chronométré" : `${fmt(b.timedWords)} mots`,
          };
        }),
        format: (v) => fmt(v) + " wpm",
      }),
      barChart({
        title: "Mots fautés par tranche",
        subtitle: "part des mots avec au moins une faute",
        items: buckets.map((b) => {
          const rate = bucketErrRate(b);
          return {
            label: b.label,
            value: rate * 100,
            tint: ramp(0.3 + 0.7 * Math.min(1, rate / 0.4), STATUS.critical),
            sub: `${fmt(b.words)} mots`,
          };
        }),
        format: (v) => fmt(v, 1) + " %",
        max: 100,
      })
    );
    charts.append(cols);

    // --- lecture rapide : extrêmes ---
    const timed = buckets.filter((b) => bucketWpm(b) !== null);
    const note = el("div", "empty-note");
    const parts: string[] = [];
    if (timed.length >= 2) {
      const fastest = timed.reduce((a, b) => (bucketWpm(b)! > bucketWpm(a)! ? b : a));
      const slowest = timed.reduce((a, b) => (bucketWpm(b)! < bucketWpm(a)! ? b : a));
      const gap = bucketWpm(fastest)! - bucketWpm(slowest)!;
      parts.push(
        `Plus rapide : « ${fastest.label} » (${fmt(bucketWpm(fastest)!)} wpm) ` +
        `· plus lent : « ${slowest.label} » (${fmt(bucketWpm(slowest)!)} wpm, ` +
        `−${fmt(gap)} wpm)`
      );
    }
    if (buckets.length >= 2) {
      const worst = buckets.reduce((a, b) => (bucketErrRate(b) > bucketErrRate(a) ? b : a));
      parts.push(`Plus fauté : « ${worst.label} » (${fmtPct(bucketErrRate(worst))})`);
    }
    if (parts.length > 0) {
      note.textContent = parts.join(". ") + ".";
      charts.append(note);
    }
  }
  renderDim();
}

// ===========================================================================
//  Onglet Bigrammes
// ===========================================================================
function renderBigrams(root: HTMLElement, bigrams: Record<string, BigramStat>): void {
  const entries = Object.entries(bigrams);
  if (entries.length === 0) {
    root.append(el("div", "empty-note", "Aucune donnée de bigramme — fais quelques tests !"));
    return;
  }

  const letters = topLetters(bigrams, 15);

  // --- toggle délai / erreur ---
  const toggle = el("div", "seg-toggle");
  let metric: "gap" | "error" = "gap";
  const heatWrap = el("div");
  const mkBtn = (key: "gap" | "error", label: string) => {
    const b = el("button", "seg-btn" + (metric === key ? " on" : ""), label);
    b.addEventListener("click", () => { metric = key; renderHeat(); });
    return b;
  };
  function renderHeat(): void {
    for (const b of toggle.querySelectorAll("button")) b.classList.remove("on");
    toggle.querySelector(metric === "gap" ? "button:first-child" : "button:last-child")?.classList.add("on");
    heatWrap.innerHTML = "";
    if (metric === "gap") {
      heatWrap.append(
        heatmap({
          title: "Délai entre frappes (ms)",
          subtitle: "ligne = 1re lettre · colonne = 2e lettre · plus foncé = plus lent",
          rows: letters,
          cols: letters,
          hue: STATUS.serious,
          value: (r, c) => {
            const b = bigrams[r + c];
            return b && b.count >= 3 ? bigramAvgGap(b) : null;
          },
          tip: (r, c, v) => {
            const b = bigrams[r + c]!;
            return `<b class="mono">${r}${c}</b><br><span class="t-dim">${fmt(v)} ms · ${b.count} transitions</span>`;
          },
          legendFormat: (v) => fmt(v) + " ms",
        })
      );
    } else {
      heatWrap.append(
        heatmap({
          title: "Taux d'erreur par bigramme",
          subtitle: "2e lettre fausse après une 1re correcte",
          rows: letters,
          cols: letters,
          hue: STATUS.critical,
          value: (r, c) => {
            const b = bigrams[r + c];
            const total = b ? b.count + b.errors : 0;
            return b && total >= 3 ? b.errors / total : null;
          },
          tip: (r, c, v) => {
            const b = bigrams[r + c]!;
            return `<b class="mono">${r}${c}</b><br><span class="t-dim">${fmtPct(v)} · ${b.errors} erreur(s) / ${b.count + b.errors}</span>`;
          },
          legendFormat: (v) => fmtPct(v),
        })
      );
    }
  }
  toggle.append(mkBtn("gap", "Délai"), mkBtn("error", "Erreurs"));
  root.append(toggle, heatWrap);
  renderHeat();

  // --- top listes ---
  const slowest = entries
    .map(([key, b]) => ({ key, gap: bigramAvgGap(b), count: b.count }))
    .filter((b) => b.gap !== null && b.count >= 5)
    .sort((a, b) => (b.gap ?? 0) - (a.gap ?? 0))
    .slice(0, 12);
  const faulty = entries
    .map(([key, b]) => ({ key, errors: b.errors, rate: b.errors / Math.max(1, b.count + b.errors) }))
    .filter((b) => b.errors >= 2)
    .sort((a, b) => b.rate - a.rate)
    .slice(0, 12);

  const cols = el("div", "two-cols");
  cols.append(
    barChart({
      title: "Transitions les plus lentes",
      items: slowest.map((b) => ({ label: b.key, value: b.gap ?? 0, mono: true, tint: STATUS.serious, sub: `${b.count} fois` })),
      format: (v) => fmt(v) + " ms",
    }),
    barChart({
      title: "Transitions les plus fautées",
      items: faulty.map((b) => ({ label: b.key, value: b.rate * 100, mono: true, tint: STATUS.critical, sub: `${b.errors} err.` })),
      format: (v) => fmt(v, 1) + " %",
    })
  );
  root.append(cols);
}

function topLetters(bigrams: Record<string, BigramStat>, n: number): string[] {
  const freq = new Map<string, number>();
  for (const [key, b] of Object.entries(bigrams)) {
    const total = b.count + b.errors;
    for (const ch of key) freq.set(ch, (freq.get(ch) ?? 0) + total);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([ch]) => ch)
    .sort((a, b) => a.localeCompare(b, "fr"));
}

// ===========================================================================
//  Onglet Activité
// ===========================================================================
function renderActivity(root: HTMLElement, history: HistoryEntry[], viewRoot: HTMLElement, signal: AbortSignal): void {
  // --- calendrier ---
  const counts = new Map<string, number>();
  for (const h of history) {
    const d = new Date(h.date);
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  root.append(
    calendarHeatmap({
      title: "Activité",
      subtitle: `${history.length} test(s) · 26 dernières semaines`,
      counts,
      hue: ACCENT,
    })
  );

  // --- historique détaillé ---
  const box = el("div", "chart-card");
  box.append(cardHead("Derniers tests"));
  if (history.length === 0) {
    box.append(el("div", "empty-note", "Aucun test enregistré."));
  } else {
    const wrap = el("div", "table-scroll");
    const table = el("table", "data");
    const head = el("tr");
    for (const h of ["date", "mode", "mots", "wpm", "précision"]) {
      head.append(el("th", h === "date" || h === "mode" ? undefined : "num", h));
    }
    table.append(head);
    for (const entry of [...history].reverse().slice(0, 30)) {
      const tr = el("tr");
      tr.append(
        el("td", undefined, fmtDate(entry.date)),
        el("td", undefined, entry.mode === "practice" ? "⚑ entraînement" : "normal"),
        el("td", "num", fmt(entry.wordCount)),
        el("td", "num", fmt(entry.wpm)),
        el("td", "num", fmtPct(entry.accuracy))
      );
      table.append(tr);
    }
    wrap.append(table);
    box.append(wrap);
  }
  root.append(box);

  // --- données ---
  const dataBox = el("div", "chart-card");
  dataBox.append(cardHead("Données"));
  const btns = el("div", "btn-row");

  const exportBtn = el("button", "btn", "Exporter (JSON)");
  exportBtn.addEventListener("click", () => {
    const blob = new Blob([exportData()], { type: "application/json" });
    const a = el("a");
    a.href = URL.createObjectURL(blob);
    a.download = `fasttyper-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, { signal });

  const importBtn = el("button", "btn", "Importer");
  const fileInput = el("input");
  fileInput.type = "file";
  fileInput.accept = ".json";
  fileInput.hidden = true;
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      importData(await file.text());
      toast("Données importées !");
      mountStatsView(viewRoot, signal);
    } catch {
      toast("Import impossible : fichier non reconnu.");
    }
  }, { signal });
  importBtn.addEventListener("click", () => fileInput.click(), { signal });

  const resetBtn = el("button", "btn danger", "Tout effacer");
  resetBtn.addEventListener("click", () => {
    if (confirm("Effacer toutes les stats et l'historique ? (la config est conservée)")) {
      resetData();
      toast("Données effacées.");
      mountStatsView(viewRoot, signal);
    }
  }, { signal });

  btns.append(exportBtn, importBtn, fileInput, resetBtn);
  dataBox.append(btns);
  root.append(dataBox);
}

// ---- utilitaires ----------------------------------------------------------
function cardHead(title: string): HTMLElement {
  const head = el("div", "chart-head");
  head.append(el("h3", undefined, title));
  return head;
}
function fmtDate(ts: number): string {
  return new Date(ts).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}
function fmtDuration(ms: number): string {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return `${h} h ${String(min % 60).padStart(2, "0")}`;
}
