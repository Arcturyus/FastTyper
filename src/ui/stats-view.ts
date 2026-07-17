import { loadConfig } from "../config";
import {
  ALL_LANGS,
  badWpm,
  bigramAvgGap,
  deleteHistoricalTest,
  exportData,
  importData,
  loadBigramStatsMerged,
  loadHistory,
  loadTestLogMulti,
  loadWordStatsTagged,
  median,
  okWpm,
  resetData,
  wordAvgWpm,
  wordErrRate,
  wordPosErrorRates,
  wordOutcomeSpeeds,
  wordTrials,
} from "../store";
import type { OutcomeSpeed, TaggedWord } from "../store";
import type {
  BigramStat,
  Config,
  HistoryEntry,
  LangId,
  TestLog,
  TestMode,
  WordStat,
} from "../types";
import { ALL_FAMILIES, FAMILY_LABEL, FAMILY_OF, type LangFamily } from "../lang";
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
  speedRamp,
  stats as summary,
} from "./charts";

/** Couleur fixe par famille de langue pour la coloration « par langue ». */
const FAMILY_COLOR: Record<LangFamily, string> = {
  fr: ACCENT,
  en: PACE,
  code: STATUS.good,
};

/** Modes filtrables dans l'en-tête — couleurs alignées sur les graphiques. */
const MODE_FILTERS: { key: TestMode; label: string; color: string }[] = [
  { key: "normal", label: "normal", color: ACCENT },
  { key: "practice", label: "entraînement", color: STATUS.serious },
];

/** Ligne d'analyse par mot, agrégée sur une (famille de langue, mot). */
type WordRow = {
  family: LangFamily;
  word: string;
  key: string; // `${family} ${word}`, identifiant unique
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
  return tagged.map(({ family, word, stat }) => {
    const key = `${family} ${word}`;
    const o = outcome.get(key);
    return {
      family,
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

type Tab = "progression" | "mots" | "biais" | "bigrammes" | "clavier" | "activite";
type SortKey = "word" | "lang" | "attempts" | "wpm" | "okWpm" | "badWpm" | "errRate" | "errors";

const TABS: { key: Tab; label: string }[] = [
  { key: "progression", label: "Progression" },
  { key: "mots", label: "Mots" },
  { key: "biais", label: "Biais" },
  { key: "bigrammes", label: "Bigrammes" },
  { key: "clavier", label: "Clavier" },
  { key: "activite", label: "Activité" },
];

export function mountStatsView(root: HTMLElement, signal: AbortSignal): void {
  const cfg = loadConfig();
  // état local (n'altère pas la config globale)
  const selectedFamilies = new Set<LangFamily>(ALL_FAMILIES);
  const selectedModes = new Set<TestMode>(MODE_FILTERS.map((m) => m.key));
  let tab: Tab = "progression";
  // état de l'onglet Progression, conservé entre deux re-rendus
  const progState = { range: 0, maWin: 0 }; // range : 0 = tout · maWin : 0 = auto

  root.innerHTML = "";

  // --- en-tête ---
  const header = el("div", "stats-header");
  header.append(el("h2", "page-title", "Statistiques"));

  // barre de langues (multi-sélection, au moins une active) — une pastille par
  // famille : fr et fr1k (resp. en et en1k) partagent déjà les mêmes données.
  const langBar = el("div", "lang-filter");
  langBar.append(el("span", "lang-filter-label", "Langues"));
  const familyPills = new Map<LangFamily, HTMLElement>();
  for (const family of ALL_FAMILIES) {
    const pill = el("button", "pill on", FAMILY_LABEL[family]);
    pill.style.setProperty("--lang-dot", FAMILY_COLOR[family]);
    pill.classList.add("lang-pill");
    pill.addEventListener(
      "click",
      () => {
        if (selectedFamilies.has(family)) {
          if (selectedFamilies.size === 1) return; // garde-fou : au moins une famille
          selectedFamilies.delete(family);
        } else {
          selectedFamilies.add(family);
        }
        pill.classList.toggle("on", selectedFamilies.has(family));
        renderTab();
      },
      { signal }
    );
    familyPills.set(family, pill);
    langBar.append(pill);
  }
  header.append(langBar);

  // barre de modes (multi-sélection, au moins un actif) : les entraînements
  // ciblés tirent la moyenne vers le bas, on peut donc les écarter d'un clic.
  // Sans effet sur Mots/Bigrammes (données agrégées tous modes) : masquée là-bas.
  const modeBar = el("div", "lang-filter");
  modeBar.append(el("span", "lang-filter-label", "Modes"));
  for (const m of MODE_FILTERS) {
    const pill = el("button", "pill on lang-pill", m.label);
    pill.style.setProperty("--lang-dot", m.color);
    pill.addEventListener(
      "click",
      () => {
        if (selectedModes.has(m.key)) {
          if (selectedModes.size === 1) return; // garde-fou : au moins un mode
          selectedModes.delete(m.key);
        } else {
          selectedModes.add(m.key);
        }
        pill.classList.toggle("on", selectedModes.has(m.key));
        renderTab();
      },
      { signal }
    );
    modeBar.append(pill);
  }
  header.append(modeBar);
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
    // le filtre de mode ne s'applique qu'aux données qui gardent le mode
    modeBar.style.display = tab === "mots" || tab === "bigrammes" ? "none" : "";
    content.innerHTML = "";
    const families = ALL_FAMILIES.filter((f) => selectedFamilies.has(f));
    // variantes couvertes (fr+fr1k, en+en1k) : sert au journal brut, qui garde le détail par pool
    const langs = ALL_LANGS.filter((l) => selectedFamilies.has(FAMILY_OF[l]));
    const tagged = loadWordStatsTagged(families);
    const history = loadHistory().filter(
      (h) => selectedFamilies.has(FAMILY_OF[h.lang]) && selectedModes.has(h.mode)
    );

    switch (tab) {
      case "progression":
        renderProgression(content, cfg, history, tagged, progState, renderTab, signal);
        break;
      case "mots":
        renderWords(content, cfg, families, tagged, loadTestLogMulti(families), signal);
        break;
      case "biais":
        renderBias(
          content,
          loadTestLogMulti(families).filter((t) => selectedModes.has(t.mode)),
          langs.length > 1,
          signal
        );
        break;
      case "bigrammes":
        renderBigrams(content, loadBigramStatsMerged(families));
        break;
      case "clavier":
        renderKeyboard(
          content,
          loadBigramStatsMerged(families),
          loadTestLogMulti(families).filter((t) => selectedModes.has(t.mode)),
          signal
        );
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
  state: { range: number; maWin: number },
  rerender: () => void,
  signal: AbortSignal
): void {
  if (fullHistory.length === 0) {
    root.append(el("div", "empty-note", "Aucun test enregistré pour les langues et modes sélectionnés — lance-toi !"));
    return;
  }
  const history = state.range > 0 ? fullHistory.slice(-state.range) : fullHistory;

  // --- tuiles de synthèse ---
  const wpms = history.map((h) => h.wpm);
  const stat = summary(wpms);
  const best = Math.max(...fullHistory.map((h) => h.wpm));
  const recent = fullHistory.slice(-10);
  const recentStat = summary(recent.map((h) => h.wpm));
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
  const consistVals = history
    .map((h) => h.consistency)
    .filter((c): c is number => typeof c === "number" && c > 0);
  const consistMed = consistVals.length ? median(consistVals) : null;
  cards.append(
    mk("tests", fmt(fullHistory.length)),
    mk("wpm moyen", fmt(avgRecent), "10 derniers"),
    mk("wpm médian", recentStat ? fmt(recentStat.median) : "—", "10 derniers"),
    mk("record", fmt(best)),
    mk("précision", fmtPct(avgAcc)),
    mk("régularité", stat ? "± " + fmt(stat.sd) : "—", "écart-type entre tests"),
    mk("consistance", consistMed !== null ? "± " + fmt(consistMed) : "—", "écart-type dans un test"),
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
    const btn = el("button", "pill" + (state.range === r.value ? " on" : ""), r.label);
    btn.addEventListener("click", () => { state.range = r.value; rerender(); }, { signal });
    filters.append(btn);
  }

  // --- progression wpm (fenêtre de moyenne mobile réglable) ---
  const maxWin = Math.min(200, history.length);
  const autoWin = Math.max(3, Math.round(history.length / 12));
  let win = Math.max(2, Math.min(state.maWin > 0 ? state.maWin : autoWin, maxWin));
  if (maxWin > 2) {
    filters.append(
      slider("moyenne mobile", win, 2, maxWin, 1, (v) => { win = v; state.maWin = v; drawProg(); }, (v) => fmt(v), signal)
    );
  }
  root.append(filters);

  const progCats = MODE_FILTERS.filter((m) => history.some((h) => h.mode === m.key))
    .map((m) => ({ key: m.key as string, label: m.label, color: m.color }));
  const progHost = el("div");
  root.append(progHost);

  // --- suppression d'un test par clic sur son point ---
  let popover: HTMLElement | null = null;
  let onDocDown: ((e: MouseEvent) => void) | null = null;
  let onKey: ((e: KeyboardEvent) => void) | null = null;
  function closePopover(): void {
    if (onDocDown) { document.removeEventListener("mousedown", onDocDown, true); onDocDown = null; }
    if (onKey) { document.removeEventListener("keydown", onKey, true); onKey = null; }
    if (popover) { popover.remove(); popover = null; }
  }
  signal.addEventListener("abort", closePopover);
  function pickTest(index: number, event: MouseEvent): void {
    closePopover();
    const t = history[index];
    if (!t) return;
    const box = el("div", "test-popover");
    const modeLabel = t.mode === "practice" ? "entraînement" : "normal";
    box.append(
      el("div", "tp-head", `Test #${index + 1}`),
      el("div", "tp-sub", `${fmtDate(t.date)} · ${fmt(t.wpm)} wpm · ${fmtPct(t.accuracy)} · ${modeLabel}`)
    );
    const del = el("button", "btn danger", "🗑 Supprimer ce test");
    del.addEventListener("click", () => {
      if (del.classList.contains("confirm")) {
        deleteHistoricalTest(t.lang, t.date);
        closePopover();
        toast("Test supprimé — retiré de tes statistiques.");
        rerender();
        return;
      }
      del.classList.add("confirm");
      del.textContent = "Confirmer la suppression ?";
    }, { signal });
    box.append(del);
    document.body.append(box);
    // positionnement près du clic, en restant dans la fenêtre
    const pad = 8;
    const r = box.getBoundingClientRect();
    let left = event.clientX + pad;
    let top = event.clientY + pad;
    if (left + r.width > window.innerWidth - pad) left = event.clientX - r.width - pad;
    if (top + r.height > window.innerHeight - pad) top = event.clientY - r.height - pad;
    box.style.left = `${Math.max(pad, left)}px`;
    box.style.top = `${Math.max(pad, top)}px`;
    popover = box;
    // le mousedown initiateur est déjà passé : ces écouteurs ne captent que les
    // clics/échap suivants, pour refermer la pop-up.
    onDocDown = (e) => { if (popover && !popover.contains(e.target as Node)) closePopover(); };
    onKey = (e) => { if (e.key === "Escape") closePopover(); };
    document.addEventListener("mousedown", onDocDown, true);
    document.addEventListener("keydown", onKey, true);
  }

  function drawProg(): void {
    closePopover();
    progHost.innerHTML = "";
    progHost.append(
      progressionChart({
        title: "Progression du WPM",
        subtitle: `${history.length} test(s) · clique un point pour supprimer ce test`,
        points: history.map((h) => ({
          y: h.wpm,
          category: h.mode,
          label: `<span class="t-dim">${fmtDate(h.date)} · ${fmtPct(h.accuracy)} · ${h.mode === "practice" ? "entraînement" : "normal"}</span>`,
        })),
        categories: progCats,
        maWindow: win,
        onPick: pickTest,
      })
    );
  }
  drawProg();

  // --- distribution ---
  if (stat) {
    root.append(
      histogramChart({
        title: "Distribution du WPM",
        subtitle: `moyenne ${fmt(stat.mean)} · médiane ${fmt(stat.median)} · Q1 ${fmt(stat.q1)} · Q3 ${fmt(stat.q3)}`,
        values: wpms,
        unit: "wpm",
        markers: [
          { value: stat.q1, label: "Q1", color: STATUS.warning },
          { value: stat.median, label: "méd.", color: ACCENT },
          { value: stat.mean, label: "moy.", color: PACE },
          { value: stat.q3, label: "Q3", color: STATUS.good },
        ],
      })
    );
    root.append(meanMedianNote(stat.mean, stat.median));
  }

  // --- évolution de la consistance intra-test (si mesurée) ---
  const consistPts = history.filter((h) => typeof h.consistency === "number" && h.consistency! > 0);
  if (consistPts.length >= 3) {
    root.append(
      progressionChart({
        title: "Consistance intra-test",
        subtitle: "écart-type du wpm entre les mots d'un même test (plus bas = plus régulier)",
        points: consistPts.map((h) => ({
          y: h.consistency as number,
          category: h.mode,
          label: `<span class="t-dim">${fmtDate(h.date)} · ${h.mode === "practice" ? "entraînement" : "normal"}</span>`,
        })),
        categories: progCats,
        yFormat: (v) => "± " + fmt(v),
        maWindow: win,
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
/** Variante « grand pool » de chaque famille — sert d'affichage sans exclure de mots. */
const WIDE_VARIANT: Record<LangFamily, LangId> = { fr: "fr1k", en: "en1k", code: "code" };

function renderWords(
  root: HTMLElement,
  cfg: Config,
  families: LangFamily[],
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
  const multiFamily = families.length > 1;

  // panneau d'évolution d'un mot, rempli au clic sur la carto ou le tableau
  const timeline = buildWordTimeline(logs, multiFamily, signal);

  // le tableau expose une surbrillance + un clic-mot, câblés à la carto/timeline
  const table = buildWordTable(cfg, rows, multiFamily, (key) => timeline.show(key), signal);

  // --- cartographie interactive ---
  root.append(
    buildCartography(cfg, rows, multiFamily, families, (key) => { table.focus(key); timeline.show(key); }, signal)
  );

  // --- évolution du mot sélectionné (clic sur la carto ci-dessus ou le tableau) ---
  root.append(timeline.box);

  // --- vitesse réussite vs échec ---
  renderOutcomeSpeed(root, rows, multiFamily);

  // --- top mots à travailler (agrégé sur les familles sélectionnées) ---
  const pool = families
    .flatMap((f) => {
      const rec: Record<string, WordStat> = {};
      for (const r of rows) if (r.family === f) rec[r.word] = r.stat;
      // on affiche depuis le plus grand pool de la famille pour ne rien exclure
      return practicePool(WIDE_VARIANT[f], cfg, rec).map((p) => ({ ...p, family: f }));
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
          sub: `${multiFamily ? FAMILY_LABEL[p.family] + " · " : ""}${p.avgWpm === null ? "—" : fmt(p.avgWpm)} wpm · ${fmtPct(p.errRate)}`,
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

  // --- courbe d'apprentissage : wpm moyen au n-ième essai d'un mot ---
  const curve = learningCurve(logs);
  if (curve.some((c) => c.n > 0)) {
    root.append(
      barChart({
        title: "Courbe d'apprentissage",
        subtitle: "vitesse moyenne au n-ième essai chronométré d'un mot (tous mots confondus)",
        items: curve
          .map((c, i) => ({ c, i }))
          .filter((x) => x.c.n > 0)
          .map((x) => ({
            label: x.i >= 10 ? "11+" : String(x.i + 1),
            value: x.c.avg,
            tint: ramp(0.3 + 0.7 * Math.min(1, x.i / 10), STATUS.good),
            sub: `${fmt(x.c.n)} essais`,
          })),
        format: (v) => fmt(v) + " wpm",
      })
    );
  }

  // --- tableau détaillé ---
  root.append(table.box);
}

/** wpm moyen au n-ième essai chronométré d'un mot (index 0..9, puis 10 = 11+). */
function learningCurve(logs: TestLog[]): { avg: number; n: number }[] {
  const sorted = [...logs].sort((a, b) => a.date - b.date);
  const seen = new Map<string, number>();
  const sum: number[] = new Array(11).fill(0);
  const cnt: number[] = new Array(11).fill(0);
  for (const t of sorted) {
    for (const w of t.words) {
      if (w.timeMs === null || w.timeMs <= 0) continue;
      const occ = seen.get(w.text) ?? 0;
      const k = Math.min(10, occ);
      seen.set(w.text, occ + 1);
      sum[k] = (sum[k] as number) + w.len / 5 / (w.timeMs / 60000);
      cnt[k] = (cnt[k] as number) + 1;
    }
  }
  return sum.map((s, i) => ({ avg: cnt[i]! > 0 ? s / cnt[i]! : 0, n: cnt[i]! }));
}

/**
 * Cartographie interactive des mots. Contrôles : axe vitesse (tous / réussis),
 * couleur (quadrant / langue), seuils réglables en direct. Le clic sur un point
 * remonte sa clé pour surligner la ligne du tableau détaillé.
 */
function buildCartography(
  cfg: Config,
  rows: WordRow[],
  multiFamily: boolean,
  families: LangFamily[],
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
        const langLabel = multiFamily ? `<br><span class="t-dim">${FAMILY_LABEL[d.r.family]}</span>` : "";
        const okTip = d.r.okWpm !== null ? ` · ✓ ${fmt(d.r.okWpm)}` : "";
        const badTip = d.r.badWpm !== null ? ` · ✗ ${fmt(d.r.badWpm)}` : "";
        return {
          x: d.x!,
          y: d.r.errRate * 100,
          r: Math.min(3, Math.log2(d.r.attempts + 1) / 2),
          tint: color === "lang" ? FAMILY_COLOR[d.r.family] : quad,
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

    if (color === "lang" && multiFamily) {
      host.append(legend(families.map((f) => ({ label: FAMILY_LABEL[f], color: FAMILY_COLOR[f] }))));
    }
  }
  draw();
  return box;
}

/**
 * Panneau d'évolution d'un mot précis. Rempli à la demande (clic sur la carto ou
 * sur un mot du tableau) : trace, essai après essai, la vitesse et le nombre de
 * fautes, lissés en moyenne mobile large pour dégager la tendance de fond —
 * pratique pour juger l'effet des entraînements. Les points sont teintés selon
 * le mode (normal vs entraînement).
 */
function buildWordTimeline(
  logs: TestLog[],
  multiFamily: boolean,
  signal: AbortSignal
): { box: HTMLElement; show: (key: string) => void } {
  const box = el("div", "carto-block");
  const hint = el(
    "div",
    "empty-note",
    "Clique sur un mot — dans la cartographie ci-dessus ou le tableau plus bas — pour suivre l'évolution de sa vitesse et de ses fautes essai après essai (moyenne mobile large)."
  );
  const host = el("div");
  box.append(hint, host);

  const cats = [
    { key: "normal", label: "normal", color: ACCENT },
    { key: "practice", label: "entraînement", color: STATUS.serious },
  ];
  const modeLabel = (m: TestLog["mode"]) => (m === "practice" ? "entraînement" : "normal");

  const show = (key: string): void => {
    const sp = key.indexOf(" ");
    const family = key.slice(0, sp) as LangFamily;
    const word = key.slice(sp + 1);
    const trials = wordTrials(logs, family, word);

    hint.style.display = "none";
    host.innerHTML = "";
    const title = `Évolution de « ${word} »` + (multiFamily ? ` · ${FAMILY_LABEL[family]}` : "");
    const head = el("div", "timeline-head");
    head.append(el("h3", "section-title", title));
    const drillBtn = el("button", "btn", "⚑ Réviser ce mot");
    drillBtn.title = "Ouvre un entraînement qui répète ce mot, de plus en plus espacé";
    drillBtn.addEventListener(
      "click",
      () => {
        sessionStorage.setItem("ft:drill", JSON.stringify({ lang: WIDE_VARIANT[family], word }));
        location.hash = "#test";
      },
      { signal }
    );
    head.append(drillBtn);
    host.append(head);

    if (trials.length < 2) {
      host.append(
        el("div", "empty-note", `Pas encore assez d'essais sur « ${word} » pour tracer une évolution — il en faut au moins 2.`)
      );
      box.scrollIntoView({ behavior: "smooth", block: "nearest" });
      return;
    }

    const timed = trials.filter((t) => t.wpm !== null);
    const n = trials.length;
    const first = trials[0]!;
    const last = trials[trials.length - 1]!;
    host.append(
      el(
        "div",
        "empty-note",
        `${fmt(n)} essai(s) du ${fmtDate(first.date)} au ${fmtDate(last.date)}` +
          ` · ${fmt(timed.length)} chronométré(s).`
      )
    );

    // fenêtre de moyenne mobile : base 10, poussée à 50 quand il y a de quoi.
    const maxWin = Math.max(2, n);
    let win = Math.min(n >= 50 ? 50 : 10, maxWin);

    const charts = el("div");
    const draw = (): void => {
      charts.innerHTML = "";
      charts.append(
        progressionChart({
          title: "Vitesse au fil des essais",
          subtitle: `${fmt(timed.length)} essai(s) chronométré(s) · moyenne mobile ${fmt(win)}`,
          points: timed.map((t) => ({
            y: t.wpm!,
            category: t.mode,
            label: `<span class="t-dim">${fmtDate(t.date)} · ${modeLabel(t.mode)}${t.faulted ? " · fauté" : ""}</span>`,
          })),
          categories: cats,
          yFormat: (v) => fmt(v) + " wpm",
          maWindow: win,
        })
      );
      charts.append(
        progressionChart({
          title: "Fautes au fil des essais",
          subtitle: `frappes fausses par essai · moyenne mobile ${fmt(win)}`,
          points: trials.map((t) => ({
            y: t.errors,
            category: t.mode,
            label: `<span class="t-dim">${fmtDate(t.date)} · ${modeLabel(t.mode)}</span>`,
          })),
          categories: cats,
          yFormat: (v) => fmt(v, 1),
          maWindow: win,
        })
      );
    };

    // curseur de réglage de la fenêtre (seulement si on a de quoi la varier)
    if (maxWin > 2) {
      const controls = el("div", "carto-controls");
      controls.append(
        slider("moyenne mobile", win, 2, maxWin, 1, (v) => { win = v; draw(); }, (v) => fmt(v), signal)
      );
      host.append(controls);
    }
    host.append(charts);
    draw();
    box.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };

  return { box, show };
}

/**
 * Section « vitesse : réussite vs échec ». Croise, par mot, la vitesse quand on
 * le tape juste et la vitesse quand on le tape en entier mais fauté.
 */
function renderOutcomeSpeed(root: HTMLElement, rows: WordRow[], multiFamily: boolean): void {
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
        tip: `<b class="mono">${d.word}</b>${multiFamily ? `<br><span class="t-dim">${FAMILY_LABEL[d.family]}</span>` : ""}<br><span class="t-dim">✓ ${fmt(d.okWpm!)} · ✗ ${fmt(d.badWpm!)} wpm · écart ${fmt(d.gap)}</span>`,
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
  multiFamily: boolean,
  onWord: (key: string) => void,
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
        case "lang": diff = a.family.localeCompare(b.family); break;
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
      { key: "lang", label: "langue", num: false, only: multiFamily },
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
      const chip = el("span", "word-chip clickable", rrow.word);
      for (const cclass of wordClasses(rrow.stat, { ...cfg, colorBy: "both" })) chip.classList.add(cclass);
      chip.title = "Voir l'évolution de ce mot";
      chip.addEventListener("click", () => onWord(rrow.key), { signal });
      tdWord.append(chip);
      const spark = posSparkline(rrow.word, rrow.stat);
      if (spark) tdWord.append(spark);
      tr.append(tdWord);
      if (multiFamily) {
        const tdLang = el("td");
        const badge = el("span", "lang-badge", FAMILY_LABEL[rrow.family]);
        badge.style.setProperty("--lang-dot", FAMILY_COLOR[rrow.family]);
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
  hints: boolean | undefined;
  mode: TestLog["mode"];
  lang: LangId;
  timeMs: number | null;
  errors: number;
  startGapMs: number | undefined; // latence espace → 1re lettre
  hour: number; // heure locale du test (0..23)
  prevFaulted: boolean | null; // mot précédent fauté ? (null = 1er mot du test)
  repeat: boolean; // mot déjà rencontré plus tôt dans CE test
  novelty: number | null; // nb d'essais antérieurs du mot (toutes sessions), null si inconnu
  sessionRank: number; // rang du test dans sa session (1 = premier)
  line: boolean | undefined; // 1er mot d'une ligne visuelle
  paceD: number | undefined; // avance(+)/retard(−) sur le fantôme
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
    key: "hints",
    label: "Indices",
    hint: "les surlignages/soulignages te font-ils taper plus vite / avec moins de fautes ?",
    buckets: ["avec indices", "sans indices"],
    of: (w) =>
      w.hints === undefined ? null : w.hints ? "avec indices" : "sans indices",
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
  {
    key: "hour",
    label: "Heure de la journée",
    hint: "es-tu plus rapide le matin ou le soir ?",
    buckets: ["matin", "après-midi", "soir", "nuit"],
    of: (w) =>
      w.hour < 5 ? "nuit" : w.hour < 12 ? "matin" : w.hour < 18 ? "après-midi" : w.hour < 24 ? "soir" : "nuit",
  },
  {
    key: "prev",
    label: "Mot précédent",
    hint: "une faute au mot d'avant te déstabilise-t-elle ?",
    buckets: ["après mot juste", "après mot fauté"],
    of: (w) =>
      w.prevFaulted === null ? null : w.prevFaulted ? "après mot fauté" : "après mot juste",
  },
  {
    key: "repeat",
    label: "Répétition dans le test",
    hint: "un mot revu dans le même test est-il plus rapide ?",
    buckets: ["1re occurrence", "déjà vu"],
    of: (w) => (w.repeat ? "déjà vu" : "1re occurrence"),
  },
  {
    key: "novelty",
    label: "Nouveauté du mot",
    hint: "courbe d'apprentissage : mots neufs vs bien connus",
    buckets: ["jamais vu", "1–3 essais", "4–10 essais", "11+ essais"],
    of: (w) =>
      w.novelty === null
        ? null
        : w.novelty === 0
        ? "jamais vu"
        : w.novelty <= 3
        ? "1–3 essais"
        : w.novelty <= 10
        ? "4–10 essais"
        : "11+ essais",
  },
  {
    key: "session",
    label: "Rang dans la session",
    hint: "échauffement au début, fatigue à la longue ?",
    buckets: ["1–3", "4–10", "11+"],
    of: (w) => (w.sessionRank <= 3 ? "1–3" : w.sessionRank <= 10 ? "4–10" : "11+"),
  },
  {
    key: "line",
    label: "Saut de ligne",
    hint: "le retour du regard en début de ligne coûte-t-il ?",
    buckets: ["début de ligne", "suite de ligne"],
    of: (w) => (w.line === undefined ? null : w.line ? "début de ligne" : "suite de ligne"),
  },
  {
    key: "ghost",
    label: "Fantôme",
    hint: "accélères-tu quand le curseur de rythme te dépasse ?",
    buckets: ["devant le fantôme", "derrière le fantôme"],
    of: (w) =>
      w.paceD === undefined ? null : w.paceD >= 0 ? "devant le fantôme" : "derrière le fantôme",
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
  startGapSum: number; // somme des latences de départ (ms)
  startGapN: number;
};

const bucketWpm = (b: Bucket): number | null =>
  b.timedMs > 0 ? b.timedChars / 5 / (b.timedMs / 60000) : null;
const bucketErrRate = (b: Bucket): number =>
  b.words > 0 ? b.errWords / b.words : 0;
const bucketStartGap = (b: Bucket): number | null =>
  b.startGapN > 0 ? b.startGapSum / b.startGapN : null;

function computeBuckets(words: BiasWord[], dim: Dimension): Bucket[] {
  const map = new Map<string, Bucket>();
  for (const label of dim.buckets) {
    map.set(label, {
      label, words: 0, errWords: 0, timedWords: 0, timedChars: 0, timedMs: 0,
      startGapSum: 0, startGapN: 0,
    });
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
    if (w.startGapMs !== undefined && w.startGapMs > 0) {
      b.startGapSum += w.startGapMs;
      b.startGapN += 1;
    }
  }
  return dim.buckets.map((l) => map.get(l)!).filter((b) => b.words > 0);
}

const SESSION_GAP_MS = 30 * 60 * 1000; // > 30 min entre deux tests → nouvelle session

function renderBias(root: HTMLElement, logs: TestLog[], showLang: boolean, signal: AbortSignal): void {
  // ordre chronologique : nécessaire pour la nouveauté (essais antérieurs) et le
  // rang de session, qui dépendent de l'histoire cumulée.
  const sorted = [...logs].sort((a, b) => a.date - b.date);
  const seenGlobal = new Map<string, number>(); // essais antérieurs d'un mot (toutes sessions)
  let sessionRank = 0;
  let lastDate = -Infinity;

  const words: BiasWord[] = [];
  for (const t of sorted) {
    sessionRank = t.date - lastDate > SESSION_GAP_MS ? 1 : sessionRank + 1;
    lastDate = t.date;
    const hour = new Date(t.date).getHours();
    const seenInTest = new Set<string>();
    let prevFaulted: boolean | null = null;
    for (const w of t.words) {
      words.push({
        len: w.len,
        index: w.index,
        wordCount: t.wordCount,
        pace: t.pace,
        hints: t.hints,
        mode: t.mode,
        lang: t.lang,
        timeMs: w.timeMs,
        errors: w.errors,
        startGapMs: w.startGapMs,
        hour,
        prevFaulted,
        repeat: seenInTest.has(w.text),
        novelty: seenGlobal.get(w.text) ?? 0,
        sessionRank,
        line: w.line,
        paceD: t.pace ? w.paceD : undefined,
      });
      seenInTest.add(w.text);
      seenGlobal.set(w.text, (seenGlobal.get(w.text) ?? 0) + 1);
      prevFaulted = w.errors > 0;
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

    // --- latence de départ de mot (espace → 1re lettre) si mesurée ---
    if (buckets.some((b) => bucketStartGap(b) !== null)) {
      charts.append(
        barChart({
          title: "Latence de départ de mot",
          subtitle: "délai entre l'espace et la 1re lettre — lecture/anticipation",
          items: buckets.map((b) => {
            const g = bucketStartGap(b);
            return {
              label: b.label,
              value: g ?? 0,
              tint: g === null ? STATUS.warning : PACE,
              sub: g === null ? "non mesuré" : `${fmt(b.startGapN)} départs`,
            };
          }),
          format: (v) => fmt(v) + " ms",
        })
      );
    }

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

  const DISP = (ch: string) => (ch === " " ? "␣" : ch);

  // --- univers des caractères présents dans les données + poids (fréquence) ---
  const weight = new Map<string, number>();
  for (const [key, b] of entries) {
    const total = b.count + b.errors;
    if (total === 0) continue;
    for (const ch of key) weight.set(ch, (weight.get(ch) ?? 0) + total);
  }
  const allChars = [...weight.keys()].sort((a, b) => {
    if (a === " ") return -1;
    if (b === " ") return 1;
    return a.localeCompare(b, "fr");
  });
  if (allChars.length === 0) {
    root.append(el("div", "empty-note", "Aucune donnée de bigramme exploitable."));
    return;
  }

  // catégories de caractères, utilisées pour la sélection par défaut et les
  // boutons de raccourci ci-dessous
  const isDigit = (ch: string) => ch >= "0" && ch <= "9";
  const isPlainLetter = (ch: string) => /^[a-zA-Z]$/.test(ch);
  const isAccent = (ch: string) => ch !== " " && !isDigit(ch) && !isPlainLetter(ch) && /\p{L}/u.test(ch);
  const isPunct = (ch: string) => ch !== " " && !isDigit(ch) && !isPlainLetter(ch) && !isAccent(ch);

  // sélection par défaut : seulement les lettres simples (hors accents,
  // chiffres, ponctuation et espace)
  const selected = new Set<string>(allChars.filter(isPlainLetter));

  // --- sélecteur de caractères (chips interactifs) ---
  const selBar = el("div", "char-select");
  selBar.append(el("span", "ctrl-label", "Caractères"));
  const chipsWrap = el("div", "char-chips");
  const chipEls = new Map<string, HTMLButtonElement>();
  for (const ch of allChars) {
    const chip = el("button", "char-chip" + (selected.has(ch) ? " on" : ""), DISP(ch));
    chip.title = ch === " " ? "Espace" : ch;
    chip.addEventListener("click", () => {
      if (selected.has(ch)) selected.delete(ch);
      else selected.add(ch);
      chip.classList.toggle("on", selected.has(ch));
      build();
    });
    chipEls.set(ch, chip);
    chipsWrap.append(chip);
  }
  const presetBtns: [HTMLButtonElement, (ch: string) => boolean][] = [];
  const refreshChips = () => {
    for (const [ch, chip] of chipEls) chip.classList.toggle("on", selected.has(ch));
    for (const [btn, pred] of presetBtns) {
      const chars = allChars.filter(pred);
      btn.classList.toggle("on", chars.length > 0 && chars.every((ch) => selected.has(ch)));
    }
    build();
  };
  // Tout / Aucun : remplacent la sélection entière.
  const setAll = (on: boolean) => {
    selected.clear();
    if (on) for (const ch of allChars) selected.add(ch);
    refreshChips();
  };
  // catégories (Lettres, Accents…) : bascule cumulative — ajoute la catégorie
  // à la sélection courante, ou la retire si elle est déjà entièrement sélectionnée,
  // pour pouvoir combiner plusieurs catégories à la fois.
  const toggleBy = (pred: (ch: string) => boolean) => {
    const chars = allChars.filter(pred);
    const allOn = chars.length > 0 && chars.every((ch) => selected.has(ch));
    for (const ch of chars) {
      if (allOn) selected.delete(ch);
      else selected.add(ch);
    }
    refreshChips();
  };
  const actions = el("div", "char-actions");
  const bAll = el("button", "seg-btn", "Tout");
  bAll.addEventListener("click", () => setAll(true));
  const bNone = el("button", "seg-btn", "Aucun");
  bNone.addEventListener("click", () => setAll(false));
  const presets: [string, (ch: string) => boolean][] = [
    ["Lettres", isPlainLetter],
    ["Accents", isAccent],
    ["Chiffres", isDigit],
    ["Ponctuation", isPunct],
  ];
  actions.append(bAll);
  for (const [label, pred] of presets) {
    const chars = allChars.filter(pred);
    const on = chars.length > 0 && chars.every((ch) => selected.has(ch));
    const b = el("button", "seg-btn" + (on ? " on" : ""), label);
    b.addEventListener("click", () => toggleBy(pred));
    presetBtns.push([b, pred]);
    actions.append(b);
  }
  actions.append(bNone);
  selBar.append(chipsWrap, actions);
  root.append(selBar);

  // --- toggle délai / erreur ---
  let metric: "gap" | "error" = "gap";
  const toggle = el("div", "seg-toggle");
  const mkBtn = (key: "gap" | "error", label: string) => {
    const b = el("button", "seg-btn" + (metric === key ? " on" : ""), label);
    b.addEventListener("click", () => {
      if (metric === key) return;
      metric = key;
      for (const btn of toggle.querySelectorAll("button")) btn.classList.remove("on");
      b.classList.add("on");
      build();
    });
    return b;
  };
  toggle.append(mkBtn("gap", "Délai"), mkBtn("error", "Erreurs"));
  root.append(toggle);

  // --- conteneur rebâti à chaque changement (métrique ou sélection) ---
  const dyn = el("div");
  root.append(dyn);

  function build(): void {
    dyn.innerHTML = "";
    const chars = allChars.filter((c) => selected.has(c));
    if (chars.length === 0) {
      dyn.append(el("div", "empty-note", "Sélectionne au moins un caractère."));
      return;
    }

    // ---------- heatmap (matrice) ----------
    if (metric === "gap") {
      dyn.append(
        heatmap({
          title: "Délai entre frappes (ms)",
          subtitle: "ligne = 1re lettre · colonne = 2e lettre · or = rapide · rouge = lent · brun = moyen",
          rows: chars,
          cols: chars,
          hue: STATUS.serious,
          color: speedRamp,
          label: DISP,
          value: (r, c) => {
            const b = bigrams[r + c];
            return b && b.count >= 3 ? bigramAvgGap(b) : null;
          },
          tip: (r, c, v) => {
            const b = bigrams[r + c]!;
            return `<b class="mono">${DISP(r)}${DISP(c)}</b><br><span class="t-dim">${fmt(v)} ms · ${b.count} transitions</span>`;
          },
          legendFormat: (v) => fmt(v) + " ms",
          rowMargin: (r) => {
            let g = 0, n = 0;
            for (const c of chars) { const b = bigrams[r + c]; if (b) { g += b.gapMs; n += b.count; } }
            const v = n > 0 ? g / n : null;
            return {
              v,
              tip: v === null
                ? `<b class="mono">${DISP(r)} →</b><br><span class="t-dim">aucune transition mesurée</span>`
                : `<b class="mono">${DISP(r)} →</b> délai moyen quand « ${DISP(r)} » est la 1re lettre<br><span class="t-dim">${fmt(v)} ms · ${n} transitions</span>`,
            };
          },
          colMargin: (c) => {
            let g = 0, n = 0;
            for (const r of chars) { const b = bigrams[r + c]; if (b) { g += b.gapMs; n += b.count; } }
            const v = n > 0 ? g / n : null;
            return {
              v,
              tip: v === null
                ? `<b class="mono">→ ${DISP(c)}</b><br><span class="t-dim">aucune transition mesurée</span>`
                : `<b class="mono">→ ${DISP(c)}</b> délai moyen quand « ${DISP(c)} » est la 2e lettre<br><span class="t-dim">${fmt(v)} ms · ${n} transitions</span>`,
            };
          },
          cornerTip: "Σ — moyenne pondérée des délais sur les caractères affichés (ligne = 1re lettre, colonne = 2e lettre)",
        })
      );
    } else {
      dyn.append(
        heatmap({
          title: "Taux d'erreur par bigramme",
          subtitle: "2e lettre fausse après une 1re correcte",
          rows: chars,
          cols: chars,
          hue: STATUS.critical,
          label: DISP,
          value: (r, c) => {
            const b = bigrams[r + c];
            const total = b ? b.count + b.errors : 0;
            return b && total >= 3 ? b.errors / total : null;
          },
          tip: (r, c, v) => {
            const b = bigrams[r + c]!;
            return `<b class="mono">${DISP(r)}${DISP(c)}</b><br><span class="t-dim">${fmtPct(v)} · ${b.errors} erreur(s) / ${b.count + b.errors}</span>`;
          },
          legendFormat: (v) => fmtPct(v),
          rowMargin: (r) => {
            let e = 0, tot = 0;
            for (const c of chars) { const b = bigrams[r + c]; if (b) { e += b.errors; tot += b.count + b.errors; } }
            const v = tot > 0 ? e / tot : null;
            return {
              v,
              tip: v === null
                ? `<b class="mono">${DISP(r)} →</b><br><span class="t-dim">aucune frappe</span>`
                : `<b class="mono">${DISP(r)} →</b> taux d'erreur quand « ${DISP(r)} » est la 1re lettre<br><span class="t-dim">${fmtPct(v)} · ${e} err. / ${tot}</span>`,
            };
          },
          colMargin: (c) => {
            let e = 0, tot = 0;
            for (const r of chars) { const b = bigrams[r + c]; if (b) { e += b.errors; tot += b.count + b.errors; } }
            const v = tot > 0 ? e / tot : null;
            return {
              v,
              tip: v === null
                ? `<b class="mono">→ ${DISP(c)}</b><br><span class="t-dim">aucune frappe</span>`
                : `<b class="mono">→ ${DISP(c)}</b> taux d'erreur quand « ${DISP(c)} » est la 2e lettre<br><span class="t-dim">${fmtPct(v)} · ${e} err. / ${tot}</span>`,
            };
          },
          cornerTip: "Σ — taux d'erreur global sur les caractères affichés (ligne = 1re lettre, colonne = 2e lettre)",
        })
      );
    }

    // ---------- top listes (bigrammes dont les 2 caractères sont sélectionnés, hors espace) ----------
    const inner = entries.filter(
      ([k]) => k.length === 2 && k[0] !== " " && selected.has(k[0]!) && selected.has(k[1]!)
    );
    const slowest = inner
      .map(([key, b]) => ({ key, gap: bigramAvgGap(b), count: b.count }))
      .filter((b) => b.gap !== null && b.count >= 5)
      .sort((a, b) => (b.gap ?? 0) - (a.gap ?? 0))
      .slice(0, 12);
    const faulty = inner
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
    dyn.append(cols);

    // ---------- départs de mot (espace → lettre), seulement si l'espace est sélectionné ----------
    if (selected.has(" ")) {
      const spaceEntries = entries.filter(
        ([k]) => k.length === 2 && k[0] === " " && selected.has(k[1]!)
      );
      const startSlow = spaceEntries
        .map(([k, b]) => ({ letter: k[1] as string, gap: bigramAvgGap(b), count: b.count }))
        .filter((x) => x.gap !== null && x.count >= 3)
        .sort((a, b) => (b.gap ?? 0) - (a.gap ?? 0))
        .slice(0, 12);
      const startFaulty = spaceEntries
        .map(([k, b]) => ({ letter: k[1] as string, errors: b.errors, rate: b.errors / Math.max(1, b.count + b.errors) }))
        .filter((x) => x.errors >= 2)
        .sort((a, b) => b.rate - a.rate)
        .slice(0, 12);

      if (startSlow.length > 0 || startFaulty.length > 0) {
        dyn.append(el("h3", "section-title", "Départs de mot (après une espace)"));
        const scols = el("div", "two-cols");
        scols.append(
          barChart({
            title: "Lettres les plus lentes à démarrer",
            items: startSlow.map((x) => ({ label: "␣" + x.letter, value: x.gap ?? 0, mono: true, tint: STATUS.serious, sub: `${x.count} fois` })),
            format: (v) => fmt(v) + " ms",
          }),
          barChart({
            title: "Lettres les plus fautées à démarrer",
            items: startFaulty.map((x) => ({ label: "␣" + x.letter, value: x.rate * 100, mono: true, tint: STATUS.critical, sub: `${x.errors} err.` })),
            format: (v) => fmt(v, 1) + " %",
          })
        );
        dyn.append(scols);
      }
    }
  }

  build();
}

// ===========================================================================
//  Onglet Clavier — heatmap AZERTY, caractères spéciaux, doublées, erreurs
// ===========================================================================
const SVG_NS = "http://www.w3.org/2000/svg";

// disposition AZERTY : rangées de lettres + une rangée d'accents directs
const KB_ROWS: string[][] = [
  ["é", "è", "à", "ç", "ù"],
  ["a", "z", "e", "r", "t", "y", "u", "i", "o", "p"],
  ["q", "s", "d", "f", "g", "h", "j", "k", "l", "m"],
  ["w", "x", "c", "v", "b", "n"],
];
const KB_ROW_OFFSET = [3.2, 0, 0.4, 1.0]; // décalage horizontal (en touches) par rangée

/** Métrique entrante par lettre : agrège tous les bigrammes « ?lettre ». */
function incomingByLetter(
  bigrams: Record<string, BigramStat>
): Map<string, { gap: number; gapN: number; err: number; tot: number }> {
  const m = new Map<string, { gap: number; gapN: number; err: number; tot: number }>();
  for (const [k, b] of Object.entries(bigrams)) {
    if (k.length !== 2) continue;
    const c = k[1] as string;
    const cur = m.get(c) ?? { gap: 0, gapN: 0, err: 0, tot: 0 };
    cur.gap += b.gapMs;
    cur.gapN += b.count;
    cur.err += b.errors;
    cur.tot += b.count + b.errors;
    m.set(c, cur);
  }
  return m;
}

function renderKeyboard(
  root: HTMLElement,
  bigrams: Record<string, BigramStat>,
  logs: TestLog[],
  signal: AbortSignal
): void {
  if (Object.keys(bigrams).length === 0) {
    root.append(el("div", "empty-note", "Aucune donnée de frappe — fais quelques tests !"));
    return;
  }

  const incoming = incomingByLetter(bigrams);
  let metric: "gap" | "error" = "gap";
  let showArrows = true;

  root.append(el("h3", "section-title", "Clavier AZERTY"));
  root.append(
    el("div", "empty-note", "Chaque touche est colorée selon les transitions qui y arrivent (délai ou taux d'erreur). Les flèches relient tes pires bigrammes.")
  );

  // contrôles : métrique + flèches
  const controls = el("div", "carto-controls");
  const metricSeg = segToggle(
    [{ key: "gap", label: "Délai" }, { key: "error", label: "Erreurs" }],
    metric,
    (k) => { metric = k as typeof metric; draw(); },
    signal
  );
  const arrowsBtn = el("button", "seg-btn on", "Flèches bigrammes");
  arrowsBtn.addEventListener("click", () => {
    showArrows = !showArrows;
    arrowsBtn.classList.toggle("on", showArrows);
    draw();
  }, { signal });
  controls.append(labeled("Métrique", metricSeg), labeled("Repères", arrowsBtn));
  root.append(controls);

  const host = el("div", "carto-host");
  root.append(host);

  // valeur normalisée d'une touche (0 = bon, 1 = mauvais) selon la métrique
  function keyValue(c: string): number | null {
    const d = incoming.get(c);
    if (!d) return null;
    if (metric === "gap") return d.gapN >= 3 ? d.gap / d.gapN : null;
    return d.tot >= 3 ? d.err / d.tot : null;
  }

  function draw(): void {
    host.innerHTML = "";
    // amplitude pour normaliser les couleurs
    const vals: number[] = [];
    for (const row of KB_ROWS) for (const c of row) {
      const v = keyValue(c);
      if (v !== null) vals.push(v);
    }
    const lo = vals.length ? Math.min(...vals) : 0;
    const hi = vals.length ? Math.max(...vals) : 1;
    const norm = (v: number) => (hi > lo ? (v - lo) / (hi - lo) : 0.5);
    const hue = metric === "gap" ? STATUS.serious : STATUS.critical;

    const KW = 44, KH = 44, GAP = 6;
    const cols = 10;
    const width = cols * (KW + GAP) + 40;
    const height = KB_ROWS.length * (KH + GAP) + 10;
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.style.width = "100%";
    svg.style.maxWidth = width + "px";
    svg.style.display = "block";

    const pos = new Map<string, { cx: number; cy: number }>();
    KB_ROWS.forEach((rowChars, r) => {
      const xoff = (KB_ROW_OFFSET[r] ?? 0) * (KW + GAP) + 20;
      const y = r * (KH + GAP) + 5;
      rowChars.forEach((c, i) => {
        const x = xoff + i * (KW + GAP);
        pos.set(c, { cx: x + KW / 2, cy: y + KH / 2 });
        const v = keyValue(c);
        const rect = document.createElementNS(SVG_NS, "rect");
        rect.setAttribute("x", String(x));
        rect.setAttribute("y", String(y));
        rect.setAttribute("width", String(KW));
        rect.setAttribute("height", String(KH));
        rect.setAttribute("rx", "6");
        rect.setAttribute("fill", v === null ? "#221d12" : ramp(0.25 + 0.75 * norm(v), hue));
        rect.setAttribute("stroke", "#3a3320");
        const d = incoming.get(c);
        const titleEl = document.createElementNS(SVG_NS, "title");
        titleEl.textContent =
          v === null
            ? `${c} — pas assez de données`
            : metric === "gap"
            ? `${c} — ${fmt(v)} ms en moyenne pour l'atteindre (${d?.gapN ?? 0} transitions)`
            : `${c} — ${fmtPct(v)} d'erreur en arrivant (${d?.err ?? 0} / ${d?.tot ?? 0})`;
        rect.append(titleEl);
        svg.append(rect);
        const label = document.createElementNS(SVG_NS, "text");
        label.setAttribute("x", String(x + KW / 2));
        label.setAttribute("y", String(y + KH / 2 + 5));
        label.setAttribute("text-anchor", "middle");
        label.setAttribute("font-size", "16");
        label.setAttribute("fill", "#f2e6c4");
        label.setAttribute("pointer-events", "none");
        label.textContent = c;
        svg.append(label);
      });
    });

    // flèches des pires bigrammes (paires de lettres présentes sur le clavier)
    if (showArrows) {
      const marker = document.createElementNS(SVG_NS, "marker");
      marker.setAttribute("id", "kb-arrow");
      marker.setAttribute("viewBox", "0 0 8 8");
      marker.setAttribute("refX", "6");
      marker.setAttribute("refY", "4");
      marker.setAttribute("markerWidth", "5");
      marker.setAttribute("markerHeight", "5");
      marker.setAttribute("orient", "auto-start-reverse");
      const tri = document.createElementNS(SVG_NS, "path");
      tri.setAttribute("d", "M0,0 L8,4 L0,8 z");
      tri.setAttribute("fill", ACCENT);
      marker.append(tri);
      const defs = document.createElementNS(SVG_NS, "defs");
      defs.append(marker);
      svg.append(defs);

      const worst = Object.entries(bigrams)
        .filter(([k]) => k.length === 2 && pos.has(k[0]!) && pos.has(k[1]!) && k[0] !== k[1])
        .map(([k, b]) => ({ k, score: bigramScore(b, metric) }))
        .filter((d) => d.score !== null)
        .sort((a, b) => (b.score as number) - (a.score as number))
        .slice(0, 5);
      for (const { k } of worst) {
        const p1 = pos.get(k[0]!)!;
        const p2 = pos.get(k[1]!)!;
        const line = document.createElementNS(SVG_NS, "line");
        line.setAttribute("x1", String(p1.cx));
        line.setAttribute("y1", String(p1.cy));
        line.setAttribute("x2", String(p2.cx));
        line.setAttribute("y2", String(p2.cy));
        line.setAttribute("stroke", ACCENT);
        line.setAttribute("stroke-width", "2");
        line.setAttribute("opacity", "0.45");
        line.setAttribute("marker-end", "url(#kb-arrow)");
        svg.append(line);
      }
    }
    host.append(svg);
  }
  draw();

  // --- coût des caractères spéciaux (accents) ---
  renderSpecialCost(root, incoming);

  // --- lettres doublées ---
  renderDoubledLetters(root, bigrams);

  // --- typologie des erreurs & micro-frappe ---
  renderErrorProfile(root, logs);
}

/** Score de difficulté d'un bigramme selon la métrique affichée. */
function bigramScore(b: BigramStat, metric: "gap" | "error"): number | null {
  if (metric === "gap") return b.count >= 3 ? b.gapMs / b.count : null;
  const tot = b.count + b.errors;
  return tot >= 3 ? b.errors / tot : null;
}

const ACCENTED = ["é", "è", "ê", "à", "â", "ç", "ù", "û", "î", "ô", "ë", "ï"];

/** Coût des caractères accentués : délai et taux d'erreur vs lettres simples. */
function renderSpecialCost(
  root: HTMLElement,
  incoming: Map<string, { gap: number; gapN: number; err: number; tot: number }>
): void {
  const rows = ACCENTED.map((c) => ({ c, d: incoming.get(c) }))
    .filter((x) => x.d && x.d.gapN >= 3) as { c: string; d: { gap: number; gapN: number; err: number; tot: number } }[];
  if (rows.length === 0) return;
  // repère : délai moyen des lettres simples (a–z)
  let simpleGap = 0, simpleN = 0;
  for (const [c, d] of incoming) {
    if (/^[a-z]$/.test(c)) { simpleGap += d.gap; simpleN += d.gapN; }
  }
  const baseline = simpleN > 0 ? simpleGap / simpleN : 0;
  root.append(el("h3", "section-title", "Coût des caractères accentués"));
  root.append(
    el("div", "empty-note", `Délai moyen pour atteindre chaque accent. Repère : ${fmt(baseline)} ms pour une lettre simple.`)
  );
  root.append(
    barChart({
      title: "Délai d'accès (ms)",
      subtitle: "touches mortes / AltGr vs lettres simples",
      items: rows
        .map((x) => ({ c: x.c, gap: x.d.gap / x.d.gapN }))
        .sort((a, b) => b.gap - a.gap)
        .map((x) => ({
          label: x.c,
          value: x.gap,
          mono: true,
          tint: x.gap > baseline ? STATUS.serious : STATUS.good,
          sub: x.gap > baseline ? `+${fmt(x.gap - baseline)} ms` : "sous la moyenne",
        })),
      format: (v) => fmt(v) + " ms",
    })
  );
}

/** Lettres doublées (ll, ss, tt…) : délai et fautes, souvent un angle mort. */
function renderDoubledLetters(root: HTMLElement, bigrams: Record<string, BigramStat>): void {
  const doubles = Object.entries(bigrams)
    .filter(([k]) => k.length === 2 && k[0] === k[1] && /[a-zà-ÿ]/i.test(k[0]!))
    .map(([k, b]) => ({
      k,
      gap: b.count >= 3 ? b.gapMs / b.count : null,
      rate: b.count + b.errors >= 3 ? b.errors / (b.count + b.errors) : null,
      count: b.count,
    }))
    .filter((d) => d.gap !== null || d.rate !== null);
  if (doubles.length === 0) return;
  root.append(el("h3", "section-title", "Lettres doublées"));
  root.append(
    el("div", "empty-note", "Frappe deux fois la même touche (ll, ss, mm…) — un même doigt qui répète, souvent invisible ailleurs.")
  );
  const cols = el("div", "two-cols");
  cols.append(
    barChart({
      title: "Délai (ms)",
      items: doubles
        .filter((d) => d.gap !== null)
        .sort((a, b) => (b.gap as number) - (a.gap as number))
        .slice(0, 12)
        .map((d) => ({ label: d.k, value: d.gap as number, mono: true, tint: STATUS.serious, sub: `${d.count} fois` })),
      format: (v) => fmt(v) + " ms",
    }),
    barChart({
      title: "Taux d'erreur",
      items: doubles
        .filter((d) => d.rate !== null && (d.rate as number) > 0)
        .sort((a, b) => (b.rate as number) - (a.rate as number))
        .slice(0, 12)
        .map((d) => ({ label: d.k, value: (d.rate as number) * 100, mono: true, tint: STATUS.critical })),
      format: (v) => fmt(v, 1) + " %",
    })
  );
  root.append(cols);
}

/** Typologie des fautes + micro-frappe, depuis les agrégats journalisés. */
function renderErrorProfile(root: HTMLElement, logs: TestLog[]): void {
  const withAgg = logs.filter((t) => t.agg);
  if (withAgg.length === 0) {
    root.append(
      el("div", "empty-note", "Profil d'erreurs et micro-frappe : disponibles pour les tests joués depuis cette mise à jour.")
    );
    return;
  }
  let eSub = 0, eTrans = 0, eOmis = 0, eIns = 0;
  let bksMs = 0, noticeSum = 0, noticeN = 0, hes = 0;
  let dwellSum = 0, dwellN = 0, rollSum = 0, rollN = 0;
  for (const t of withAgg) {
    const a = t.agg!;
    eSub += a.eSub; eTrans += a.eTrans; eOmis += a.eOmis; eIns += a.eIns;
    bksMs += a.bksMs; hes += a.hes;
    if (a.notice > 0) { noticeSum += a.notice; noticeN += 1; }
    if (a.dwellAvg > 0) { dwellSum += a.dwellAvg; dwellN += 1; }
    rollSum += a.roll; rollN += 1;
  }
  const totalErr = eSub + eTrans + eOmis + eIns;

  root.append(el("h3", "section-title", "Profil des erreurs"));
  if (totalErr > 0) {
    root.append(
      barChart({
        title: "Type de faute",
        subtitle: "chaque faute rangée par nature",
        items: [
          { label: "substitution", value: eSub, tint: STATUS.critical, sub: "mauvaise lettre" },
          { label: "transposition", value: eTrans, tint: STATUS.serious, sub: "lettres interverties" },
          { label: "omission", value: eOmis, tint: STATUS.warning, sub: "lettre sautée" },
          { label: "insertion", value: eIns, tint: PACE, sub: "lettre en trop" },
        ],
        format: (v) => fmt(v),
      })
    );
  }

  // --- tuiles micro-frappe ---
  root.append(el("h3", "section-title", "Micro-frappe & correction"));
  const cards = el("div", "cards-row");
  const mk = (label: string, value: string, hint?: string) => {
    const tile = el("div", "tile");
    tile.append(el("div", "label", label), el("div", "value", value));
    if (hint) tile.append(el("div", "tile-hint", hint));
    return tile;
  };
  cards.append(
    mk("correction / test", fmt(bksMs / withAgg.length / 1000, 1) + " s", "temps en retour arrière"),
    mk("hésitations / test", fmt(hes / withAgg.length, 1), "pauses > 2× ta cadence"),
    mk("détection", noticeN > 0 ? fmt(noticeSum / noticeN, 1) : "—", "lettres avant de voir la faute")
  );
  if (dwellN > 0) {
    cards.append(mk("appui touche", fmt(dwellSum / dwellN) + " ms", "durée moyenne"));
  }
  if (rollN > 0) {
    cards.append(mk("chevauchement", fmtPct(rollSum / rollN), "frappes qui se recouvrent"));
  }
  root.append(cards);
  root.append(
    el("div", "empty-note", "Le chevauchement (rollover) monte avec la vitesse : les frappeurs rapides commencent la touche suivante avant d'avoir relâché la précédente.")
  );
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

/**
 * Note comparant moyenne et médiane du WPM. L'écart révèle l'asymétrie : si la
 * moyenne dépasse la médiane, quelques tests très rapides la tirent vers le haut ;
 * si elle est en dessous, quelques tests lents ou abandonnés la plombent. La
 * médiane, elle, reflète mieux ton niveau habituel.
 */
function meanMedianNote(mean: number, median: number): HTMLElement {
  const note = el("div", "empty-note");
  const gap = mean - median;
  // seuil : écart négligeable en deçà de ~2 % de la médiane (min 1 wpm)
  const threshold = Math.max(1, median * 0.02);
  if (Math.abs(gap) < threshold) {
    note.textContent =
      `Moyenne (${fmt(mean)}) et médiane (${fmt(median)}) quasi identiques : ` +
      "tes tests sont réguliers, la moyenne n'est pas trompeuse.";
  } else if (gap > 0) {
    note.textContent =
      `Moyenne ${fmt(mean)} > médiane ${fmt(median)} (+${fmt(gap)} wpm) : ` +
      "quelques tests très rapides tirent la moyenne vers le haut. " +
      "La médiane reflète mieux ton niveau habituel.";
  } else {
    note.textContent =
      `Moyenne ${fmt(mean)} < médiane ${fmt(median)} (${fmt(gap)} wpm) : ` +
      "quelques tests lents (ou abandonnés) plombent la moyenne. " +
      "La médiane reflète mieux ton niveau habituel.";
  }
  return note;
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
