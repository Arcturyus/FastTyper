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
  cards.append(
    mk("tests", fmt(fullHistory.length)),
    mk("wpm moyen", fmt(avgRecent), "10 derniers"),
    mk("wpm médian", recentStat ? fmt(recentStat.median) : "—", "10 derniers"),
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
  function drawProg(): void {
    progHost.innerHTML = "";
    progHost.append(
      progressionChart({
        title: "Progression du WPM",
        subtitle: `${history.length} test(s)`,
        points: history.map((h) => ({
          y: h.wpm,
          category: h.mode,
          label: `<span class="t-dim">${fmtDate(h.date)} · ${fmtPct(h.accuracy)} · ${h.mode === "practice" ? "entraînement" : "normal"}</span>`,
        })),
        categories: progCats,
        maWindow: win,
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
const WIDE_VARIANT: Record<LangFamily, LangId> = { fr: "fr1k", en: "en1k" };

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
    host.append(el("h3", "section-title", title));

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
        hints: t.hints,
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

  // sélection par défaut : l'espace + les caractères les plus fréquents
  const DEFAULT_MAX = 15;
  const selected = new Set<string>(
    [...weight.entries()]
      .filter(([ch]) => ch !== " ")
      .sort((a, b) => b[1] - a[1])
      .slice(0, DEFAULT_MAX)
      .map(([ch]) => ch)
  );
  selected.add(" "); // espace inclus par défaut (chip pour l'enlever)

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
  const setAll = (on: boolean) => {
    selected.clear();
    if (on) for (const ch of allChars) selected.add(ch);
    for (const [ch, chip] of chipEls) chip.classList.toggle("on", selected.has(ch));
    build();
  };
  const actions = el("div", "char-actions");
  const bAll = el("button", "seg-btn", "Tout");
  bAll.addEventListener("click", () => setAll(true));
  const bNone = el("button", "seg-btn", "Aucun");
  bNone.addEventListener("click", () => setAll(false));
  actions.append(bAll, bNone);
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
