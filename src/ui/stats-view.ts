import { loadConfig } from "../config";
import {
  ALL_LANGS,
  badWpm,
  bigramAvgGap,
  exportData,
  importData,
  loadBigramStatsMerged,
  loadHistory,
  loadTestLogMulti,
  loadWordStatsTagged,
  okWpm,
  resetData,
  wordAvgWpm,
  wordErrRate,
  wordPosErrorRates,
  wordOutcomeSpeeds,
} from "../store";
import type { OutcomeSpeed, TaggedWord } from "../store";
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
  legend,
  pearson,
  progressionChart,
  ramp,
  scatterChart,
  stats as summary,
} from "./charts";

/** Couleur fixe par langue pour la coloration « par langue ». */
const LANG_COLOR: Record<LangId, string> = {
  fr: ACCENT,
  fr1k: STATUS.warning,
  en: PACE,
  en1k: STATUS.good,
};

/** Ligne d'analyse par mot, agrégée sur une (langue, mot). */
type WordRow = {
  lang: LangId;
  word: string;
  key: string; // `${lang} ${word}`, identifiant unique
  stat: WordStat;
  attempts: number;
  wpmAll: number | null; // vitesse tous essais chronométrés
  errRate: number;
  errors: number;
  okWpm: number | null; // vitesse en réussite
  badWpm: number | null; // vitesse en échec (complet mais fauté)
  okN: number;
  badN: number;
};

/** Construit les lignes d'analyse en croisant WordStat et la ventilation d'issue. */
function buildWordRows(tagged: TaggedWord[], outcome: Map<string, OutcomeSpeed>): WordRow[] {
  return tagged.map(({ lang, word, stat }) => {
    const key = `${lang} ${word}`;
    const o = outcome.get(key);
    return {
      lang,
      word,
      key,
      stat,
      attempts: stat.attempts,
      wpmAll: wordAvgWpm(stat),
      errRate: wordErrRate(stat),
      errors: stat.errors,
      okWpm: o ? okWpm(o) : null,
      badWpm: o ? badWpm(o) : null,
      okN: o ? o.okN : 0,
      badN: o ? o.badN : 0,
    };
  });
}

type Tab = "progression" | "mots" | "biais" | "bigrammes" | "activite";
type SortKey = "word" | "lang" | "attempts" | "wpm" | "okWpm" | "badWpm" | "errRate" | "errors";

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
  const selectedLangs = new Set<LangId>(ALL_LANGS);
  let tab: Tab = "progression";
  let range = 0; // 0 = tout, sinon N derniers tests

  root.innerHTML = "";

  // --- en-tête ---
  const header = el("div", "stats-header");
  header.append(el("h2", "page-title", "Statistiques"));

  // barre de langues (multi-sélection, au moins une active)
  const langBar = el("div", "lang-filter");
  langBar.append(el("span", "lang-filter-label", "Langues"));
  const langPills = new Map<LangId, HTMLElement>();
  for (const id of ALL_LANGS) {
    const pill = el("button", "pill on", LANGS[id].label);
    pill.style.setProperty("--lang-dot", LANG_COLOR[id]);
    pill.classList.add("lang-pill");
    pill.addEventListener(
      "click",
      () => {
        if (selectedLangs.has(id)) {
          if (selectedLangs.size === 1) return; // garde-fou : au moins une langue
          selectedLangs.delete(id);
        } else {
          selectedLangs.add(id);
        }
        pill.classList.toggle("on", selectedLangs.has(id));
        renderTab();
      },
      { signal }
    );
    langPills.set(id, pill);
    langBar.append(pill);
  }
  header.append(langBar);
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
    const langs = ALL_LANGS.filter((l) => selectedLangs.has(l));
    const tagged = loadWordStatsTagged(langs);
    const history = loadHistory().filter((h) => selectedLangs.has(h.lang));

    switch (tab) {
      case "progression":
        renderProgression(content, cfg, history, tagged, () => range, (r) => (range = r), renderTab, signal);
        break;
      case "mots":
        renderWords(content, cfg, langs, tagged, loadTestLogMulti(langs), signal);
        break;
      case "biais":
        renderBias(content, loadTestLogMulti(langs), langs.length > 1, signal);
        break;
      case "bigrammes":
        renderBigrams(content, loadBigramStatsMerged(langs));
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
  tagged: TaggedWord[],
  getRange: () => number,
  setRange: (r: number) => void,
  rerender: () => void,
  signal: AbortSignal
): void {
  if (fullHistory.length === 0) {
    root.append(el("div", "empty-note", "Aucun test enregistré pour les langues sélectionnées — lance-toi !"));
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
  const trackedWords = new Set(tagged.map((t) => t.word)).size;

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
  langs: LangId[],
  tagged: TaggedWord[],
  logs: TestLog[],
  signal: AbortSignal
): void {
  if (tagged.length === 0) {
    root.append(el("div", "empty-note", "Aucune donnée de mot — fais quelques tests !"));
    return;
  }
  const outcome = wordOutcomeSpeeds(logs);
  const rows = buildWordRows(tagged, outcome);
  const multiLang = langs.length > 1;

  // le tableau expose une fonction de surbrillance, câblée au clic sur la carto
  const table = buildWordTable(cfg, rows, multiLang, signal);

  // --- cartographie interactive ---
  root.append(buildCartography(cfg, rows, multiLang, langs, (key) => table.focus(key), signal));

  // --- vitesse réussite vs échec ---
  renderOutcomeSpeed(root, rows, multiLang);

  // --- top mots à travailler (agrégé sur les langues sélectionnées) ---
  const pool = langs
    .flatMap((l) => {
      const rec: Record<string, WordStat> = {};
      for (const r of rows) if (r.lang === l) rec[r.word] = r.stat;
      return practicePool(l, cfg, rec).map((p) => ({ ...p, lang: l }));
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);
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
          sub: `${multiLang ? LANGS[p.lang].label.split(" ")[0] + " · " : ""}${p.avgWpm === null ? "—" : fmt(p.avgWpm)} wpm · ${fmtPct(p.errRate)}`,
        })),
        format: (v) => fmt(v, 2),
      })
    );
  }

  // --- où l'on faute dans le mot (par position) ---
  const posAgg = aggregatePositions(rows.map((r) => r.stat));
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
  root.append(table.box);
}

/**
 * Cartographie interactive des mots. Contrôles : axe vitesse (tous / réussis),
 * couleur (quadrant / langue), seuils réglables en direct. Le clic sur un point
 * remonte sa clé pour surligner la ligne du tableau détaillé.
 */
function buildCartography(
  cfg: Config,
  rows: WordRow[],
  multiLang: boolean,
  langs: LangId[],
  onPick: (key: string) => void,
  signal: AbortSignal
): HTMLElement {
  const box = el("div", "carto-block");

  // état local des contrôles (n'écrit jamais la config globale)
  let axis: "all" | "ok" = "all";
  let color: "quadrant" | "lang" = "quadrant";
  let slow = cfg.slowWpm;
  let fast = cfg.fastWpm;
  let err = cfg.errWarnRate;

  const controls = el("div", "carto-controls");

  // bascule axe vitesse
  const axisSeg = segToggle(
    [{ key: "all", label: "tous essais" }, { key: "ok", label: "réussis seulement" }],
    axis,
    (k) => { axis = k as typeof axis; draw(); },
    signal
  );
  // bascule couleur
  const colorSeg = segToggle(
    [{ key: "quadrant", label: "quadrant" }, { key: "lang", label: "langue" }],
    color,
    (k) => { color = k as typeof color; draw(); },
    signal
  );
  controls.append(
    labeled("Vitesse", axisSeg),
    labeled("Couleur", colorSeg),
    slider("lent ≤", slow, 10, 120, 1, (v) => { slow = v; draw(); }, (v) => fmt(v), signal),
    slider("rapide ≥", fast, 10, 160, 1, (v) => { fast = v; draw(); }, (v) => fmt(v), signal),
    slider("fautés ≥", Math.round(err * 100), 0, 100, 1, (v) => { err = v / 100; draw(); }, (v) => fmt(v) + " %", signal)
  );
  box.append(controls);

  const host = el("div", "carto-host");
  box.append(host);

  function draw(): void {
    host.innerHTML = "";
    const pts = rows
      .map((r) => ({ r, x: axis === "ok" ? r.okWpm : r.wpmAll }))
      .filter((d) => d.x !== null && d.r.attempts >= cfg.minAttempts)
      .map((d) => {
        const isSlow = d.x! <= slow;
        const faulty = d.r.errRate >= err;
        const quad = isSlow && faulty ? STATUS.critical : faulty ? STATUS.serious : isSlow ? STATUS.warning : STATUS.good;
        const langLabel = multiLang ? `<br><span class="t-dim">${LANGS[d.r.lang].label}</span>` : "";
        const okTip = d.r.okWpm !== null ? ` · ✓ ${fmt(d.r.okWpm)}` : "";
        const badTip = d.r.badWpm !== null ? ` · ✗ ${fmt(d.r.badWpm)}` : "";
        return {
          x: d.x!,
          y: d.r.errRate * 100,
          r: Math.min(3, Math.log2(d.r.attempts + 1) / 2),
          tint: color === "lang" ? LANG_COLOR[d.r.lang] : quad,
          key: d.r.key,
          tip: `<b class="mono">${d.r.word}</b>${langLabel}<br><span class="t-dim">${fmt(d.x!)} wpm${okTip}${badTip} · ${fmtPct(d.r.errRate)} fautés · ${d.r.attempts} essais</span>`,
        };
      });

    host.append(
      scatterChart({
        title: "Cartographie des mots",
        subtitle: `${axis === "ok" ? "vitesse en réussite" : "vitesse tous essais"} · taille = essais · ${color === "lang" ? "couleur = langue" : "couleur = quadrant"}`,
        points: pts,
        xLabel: axis === "ok" ? "WPM en réussite" : "WPM moyen",
        yLabel: "% essais fautés",
        yFormat: (v) => fmt(v) + " %",
        vLines: [{ x: slow, color: STATUS.warning }, { x: fast, color: STATUS.good }],
        hLines: [{ y: err * 100, color: STATUS.critical }],
        quadrants: color === "quadrant" ? [
          { xAt: "min", yAt: "max", label: "à retravailler", tint: STATUS.critical },
          { xAt: "max", yAt: "max", label: "fautifs", tint: STATUS.serious },
          { xAt: "min", yAt: "min", label: "lents", tint: STATUS.warning },
          { xAt: "max", yAt: "min", label: "maîtrisés", tint: STATUS.good },
        ] : undefined,
        onPick: (p) => { if (p.key) onPick(p.key); },
        height: 340,
      })
    );

    if (color === "lang" && multiLang) {
      host.append(legend(langs.map((l) => ({ label: LANGS[l].label, color: LANG_COLOR[l] }))));
    }
  }
  draw();
  return box;
}

/**
 * Section « vitesse : réussite vs échec ». Croise, par mot, la vitesse quand on
 * le tape juste et la vitesse quand on le tape en entier mais fauté.
 */
function renderOutcomeSpeed(root: HTMLElement, rows: WordRow[], multiLang: boolean): void {
  const data = rows
    .filter((r) => r.okWpm !== null && r.badWpm !== null && r.okN >= 2 && r.badN >= 1)
    .map((r) => ({ ...r, gap: r.okWpm! - r.badWpm! }));
  if (data.length === 0) {
    root.append(el("div", "empty-note", "Vitesse réussite vs échec : il faut quelques mots réussis ET ratés (tapés en entier) pour comparer."));
    return;
  }

  // --- tuiles de synthèse ---
  const avgGap = data.reduce((s, d) => s + d.gap, 0) / data.length;
  const slowerWhenBad = data.filter((d) => d.gap > 0).length;
  const cards = el("div", "cards-row");
  const mk = (label: string, value: string, hint?: string) => {
    const tile = el("div", "tile");
    tile.append(el("div", "label", label), el("div", "value", value));
    if (hint) tile.append(el("div", "tile-hint", hint));
    return tile;
  };
  cards.append(
    mk("mots comparés", fmt(data.length)),
    mk("écart moyen", (avgGap >= 0 ? "−" : "+") + fmt(Math.abs(avgGap)) + " wpm", "réussi vs fauté"),
    mk("plus lent si fauté", fmtPct(slowerWhenBad / data.length), `${slowerWhenBad}/${data.length} mots`)
  );
  root.append(cards);

  // --- nuage okWpm vs badWpm avec diagonale d'égalité ---
  root.append(
    scatterChart({
      title: "Vitesse : réussite vs échec",
      subtitle: "sous la diagonale = plus lent quand le mot est fauté",
      points: data.map((d) => ({
        x: d.okWpm!,
        y: d.badWpm!,
        r: Math.min(3, Math.log2(d.okN + d.badN + 1) / 2),
        tint: d.gap > 0 ? STATUS.warning : STATUS.good,
        tip: `<b class="mono">${d.word}</b>${multiLang ? `<br><span class="t-dim">${LANGS[d.lang].label}</span>` : ""}<br><span class="t-dim">✓ ${fmt(d.okWpm!)} · ✗ ${fmt(d.badWpm!)} wpm · écart ${fmt(d.gap)}</span>`,
      })),
      xLabel: "WPM en réussite",
      yLabel: "WPM en échec",
      diagonal: true,
      height: 320,
    })
  );

  // --- top mots au plus gros écart ---
  const top = [...data].sort((a, b) => b.gap - a.gap).slice(0, 12);
  root.append(
    barChart({
      title: "Mots les plus pénalisés par l'erreur",
      subtitle: "écart de vitesse réussite − échec",
      items: top.map((d) => ({
        label: d.word,
        value: d.gap,
        mono: true,
        tint: ramp(0.3 + 0.7 * Math.min(1, d.gap / 40), STATUS.serious),
        sub: `${fmt(d.badWpm!)} → ${fmt(d.okWpm!)} wpm`,
      })),
      format: (v) => fmt(v) + " wpm",
    })
  );
}

function aggregatePositions(stats: WordStat[]): number[] {
  const sumRate: number[] = [];
  const sumWeight: number[] = [];
  for (const s of stats) {
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

/** Tableau détaillé, avec surbrillance pilotable depuis la cartographie. */
function buildWordTable(
  cfg: Config,
  allRows: WordRow[],
  multiLang: boolean,
  signal: AbortSignal
): { box: HTMLElement; focus: (key: string) => void } {
  const box = el("div", "chart-card");
  box.append(cardHead("Détail par mot"));
  let search = "";
  let minAttempts = 1;
  let sortKey: SortKey = "errRate";
  let sortDesc = true;
  let focusKey: string | null = null;

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
    const rows = allRows
      .filter((r) => r.attempts >= minAttempts && (search === "" || r.word.toLowerCase().includes(search)));
    if (rows.length === 0) {
      tableWrap.append(el("div", "empty-note", "Aucun mot ne correspond."));
      return;
    }
    rows.sort((a, b) => {
      let diff: number;
      switch (sortKey) {
        case "word": diff = a.word.localeCompare(b.word, "fr"); break;
        case "lang": diff = a.lang.localeCompare(b.lang); break;
        case "attempts": diff = a.attempts - b.attempts; break;
        case "wpm": diff = (a.wpmAll ?? Infinity) - (b.wpmAll ?? Infinity); break;
        case "okWpm": diff = (a.okWpm ?? Infinity) - (b.okWpm ?? Infinity); break;
        case "badWpm": diff = (a.badWpm ?? Infinity) - (b.badWpm ?? Infinity); break;
        case "errors": diff = a.errors - b.errors; break;
        default: diff = a.errRate - b.errRate;
      }
      return sortDesc ? -diff : diff;
    });

    const table = el("table", "data");
    const thead = el("thead");
    const headRow = el("tr");
    const allCols: { key: SortKey; label: string; num: boolean; only?: boolean }[] = [
      { key: "word", label: "mot", num: false },
      { key: "lang", label: "langue", num: false, only: multiLang },
      { key: "attempts", label: "essais", num: true },
      { key: "wpm", label: "wpm moyen", num: true },
      { key: "okWpm", label: "wpm ✓", num: true },
      { key: "badWpm", label: "wpm ✗", num: true },
      { key: "errRate", label: "% fautés", num: true },
      { key: "errors", label: "erreurs", num: true },
    ];
    const cols = allCols.filter((c) => c.only !== false);
    for (const col of cols) {
      const th = el("th", col.num ? "num" : undefined, col.label);
      if (sortKey === col.key) { th.classList.add("sorted"); th.textContent += sortDesc ? " ↓" : " ↑"; }
      th.addEventListener("click", () => {
        if (sortKey === col.key) sortDesc = !sortDesc;
        else { sortKey = col.key; sortDesc = col.key !== "word" && col.key !== "lang"; }
        render();
      });
      headRow.append(th);
    }
    thead.append(headRow);
    table.append(thead);

    const tbody = el("tbody");
    let focusTr: HTMLElement | null = null;
    for (const rrow of rows.slice(0, 200)) {
      const tr = el("tr");
      if (rrow.key === focusKey) { tr.classList.add("row-focus"); focusTr = tr; }
      const tdWord = el("td");
      const chip = el("span", "word-chip", rrow.word);
      for (const cclass of wordClasses(rrow.stat, { ...cfg, colorBy: "both" })) chip.classList.add(cclass);
      tdWord.append(chip);
      const spark = posSparkline(rrow.word, rrow.stat);
      if (spark) tdWord.append(spark);
      tr.append(tdWord);
      if (multiLang) {
        const tdLang = el("td");
        const badge = el("span", "lang-badge", LANGS[rrow.lang].label);
        badge.style.setProperty("--lang-dot", LANG_COLOR[rrow.lang]);
        tdLang.append(badge);
        tr.append(tdLang);
      }
      tr.append(
        el("td", "num", fmt(rrow.attempts)),
        el("td", "num", rrow.wpmAll === null ? "—" : fmt(rrow.wpmAll)),
        el("td", "num", rrow.okWpm === null ? "—" : fmt(rrow.okWpm)),
        el("td", "num", rrow.badWpm === null ? "—" : fmt(rrow.badWpm)),
        el("td", "num", fmtPct(rrow.errRate)),
        el("td", "num", fmt(rrow.errors))
      );
      tbody.append(tr);
    }
    table.append(tbody);
    tableWrap.append(table);
    if (rows.length > 200) tableWrap.append(el("div", "empty-note", `${rows.length - 200} mots masqués — affine la recherche.`));
    if (focusTr) focusTr.scrollIntoView({ block: "nearest" });
  }
  render();

  const focus = (key: string): void => {
    focusKey = key;
    // vide la recherche pour garantir la présence de la ligne ciblée
    const row = allRows.find((r) => r.key === key);
    if (row && !row.word.toLowerCase().includes(search)) { search = ""; searchInput.value = ""; }
    if (row && row.attempts < minAttempts) { minAttempts = 1; minInput.value = "1"; }
    render();
    box.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };
  return { box, focus };
}

/** Segment de bascule réutilisable (petit groupe de boutons mutuellement exclusifs). */
function segToggle(
  options: { key: string; label: string }[],
  active: string,
  onChange: (key: string) => void,
  signal: AbortSignal
): HTMLElement {
  const seg = el("div", "seg-toggle");
  for (const o of options) {
    const btn = el("button", "seg-btn" + (o.key === active ? " on" : ""), o.label);
    btn.addEventListener("click", () => {
      for (const b of seg.querySelectorAll("button")) b.classList.remove("on");
      btn.classList.add("on");
      onChange(o.key);
    }, { signal });
    seg.append(btn);
  }
  return seg;
}

/** Enveloppe un contrôle d'un petit intitulé. */
function labeled(label: string, control: HTMLElement): HTMLElement {
  const wrap = el("div", "ctrl");
  wrap.append(el("span", "ctrl-label", label), control);
  return wrap;
}

/** Curseur avec valeur affichée en direct. */
function slider(
  label: string,
  value: number,
  min: number,
  max: number,
  step: number,
  onInput: (v: number) => void,
  fmtVal: (v: number) => string,
  signal: AbortSignal
): HTMLElement {
  const wrap = el("div", "ctrl ctrl-slider");
  wrap.append(el("span", "ctrl-label", label));
  const input = el("input");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  const out = el("span", "ctrl-value", fmtVal(value));
  input.addEventListener("input", () => {
    const v = Number(input.value);
    out.textContent = fmtVal(v);
    onInput(v);
  }, { signal });
  wrap.append(input, out);
  return wrap;
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
  lang: LangId;
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

/** Dimension « Langue » : n'a de sens qu'avec plusieurs langues sélectionnées. */
const LANG_DIM: Dimension = {
  key: "lang",
  label: "Langue",
  hint: "quelle langue est la plus rapide / la plus fautée ?",
  buckets: ALL_LANGS.map((l) => LANGS[l].label),
  of: (w) => LANGS[w.lang].label,
};

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

function renderBias(root: HTMLElement, logs: TestLog[], showLang: boolean, signal: AbortSignal): void {
  const words: BiasWord[] = [];
  for (const t of logs) {
    for (const w of t.words) {
      words.push({
        len: w.len,
        index: w.index,
        wordCount: t.wordCount,
        pace: t.pace,
        mode: t.mode,
        lang: t.lang,
        timeMs: w.timeMs,
        errors: w.errors,
      });
    }
  }
  const dims = showLang ? [LANG_DIM, ...BIAS_DIMS] : BIAS_DIMS;

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
  let dim = dims[0] as Dimension;
  const toggle = el("div", "seg-toggle");
  for (const d of dims) {
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
