import { IDLE_ABANDON_MS, TestEngine } from "../engine";
import type { WordInput } from "../engine";
import { loadConfig, saveConfig } from "../config";
import {
  appendTestLog,
  applyResult,
  bestRecord,
  loadBigramStats,
  loadWordStats,
  median,
  okWpmMedianByWord,
  paceTargetWpm,
  removeTestLog,
  revertResult,
  saveRecord,
  wordAvgWpm,
  wordErrRate,
  wordPosErrorRates,
} from "../store";
import {
  decoratePunctuation,
  generateBigramPractice,
  generatePractice,
  generateWordDrill,
  generateWords,
  LANGS,
  practicePool,
  RECALL_STALE_RATIO,
  type PracticeCandidate,
} from "../wordlist";
import type { Config, LangId, TestMode, TestResult, TestWord, WordStat } from "../types";

// intensité minimale d'un trait de soulignage coloré (pour rester visible)
const ERR_MARK_FLOOR = 0.28;
import { el, fmt, fmtPct, speedPercentile, speedShade, toast } from "./common";
import { renderResults, type DrillReport } from "./results-view";

const WORD_COUNTS = [10, 25, 50];

const WORD_DURATIONS = [15, 30, 60];

export function mountTestView(root: HTMLElement, signal: AbortSignal): void {
  let cfg = loadConfig();
  let mode: TestMode = "normal";
  // type d'entraînement quand mode === "practice" : mots lents/fautés ou bigrammes
  let practiceKind: "words" | "bigrams" = "words";
  // mot à réviser en boucle (entraînement lancé depuis l'onglet Stats)
  let drillWord: string | null = null;
  let timeTimer: number | undefined; // fin automatique du mode durée
  let engine: TestEngine;
  let stats: Record<string, WordStat> = {};
  let okSpeeds = new Map<string, number>(); // vitesse hors erreur par mot
  let speedDist: number[] = []; // vitesses triées de tes mots, pour l'échelle
  let wordEls: HTMLElement[] = [];
  let liveTimer: number | undefined;
  let paceRaf = 0;
  let paceWpm: number | null = null; // vitesse cible (moyenne des n derniers)
  let logged = false; // le test courant a-t-il déjà été écrit au journal ?
  // --- mesures fines par test (dwell time & rollover), agrégées ici ---
  let dwellSum = 0;
  let dwellN = 0;
  let rollCount = 0;
  let keyDownN = 0;
  let keysHeld = 0;
  const keyDownAt = new Map<string, number>();
  /** mots imposés pour un entraînement lancé depuis l'écran de résultats */
  let forcedPool: string[] | null = null;
  /** instantané du mot avant une révision ciblée (drill), pour le bilan avant/après */
  let drillBefore: { word: string; wpm: number | null; errRate: number } | null = null;
  /** bandeau coach : la liste « révision espacée » est repliée par défaut */
  let dueExpanded = false;

  root.innerHTML = "";

  const controls = el("div", "test-controls");
  // coach : bandeau discret proposant de réviser les pires mots du moment
  const coachBar = el("div", "coach-bar");
  coachBar.hidden = true;
  const liveStats = el("div", "live-stats");
  const wordsWrap = el("div", "words-wrap");
  const wordsEl = el("div", "words");
  const paceCaret = el("div", "pace-caret");
  paceCaret.hidden = true;
  const liveCaret = el("div", "live-caret"); // curseur lisse (option)
  liveCaret.hidden = true;
  const focusHint = el("div", "focus-hint", "Clique ici puis tape pour commencer");
  focusHint.hidden = true;
  // les curseurs sont enfants de wordsWrap (survivent au re-render de wordsEl)
  wordsWrap.append(wordsEl, paceCaret, liveCaret, focusHint);
  const footer = el("div", "test-footer");
  const speedLegend = el("div", "speed-legend");
  speedLegend.hidden = true;
  function renderSpeedLegend(): void {
    const show =
      cfg.hints &&
      (cfg.colorBy === "speed" || cfg.colorBy === "both") &&
      speedDist.length >= 5;
    speedLegend.hidden = !show;
    if (!show) return;
    const lo = speedDist[0] as number;
    const hi = speedDist[speedDist.length - 1] as number;
    speedLegend.innerHTML =
      `<span class="sl-label">${fmt(lo)}</span>` +
      '<span class="sl-bar"></span>' +
      `<span class="sl-label">${fmt(hi)} wpm</span>` +
      '<span class="sl-cap">— couleur des mots = vitesse (répartie sur tes mots)</span>';
  }
  const practiceLegend = el("div", "practice-legend");
  practiceLegend.innerHTML =
    '<span class="err-swatch">e</span> soulignement rouge sous une lettre = ' +
    "endroit où tu te trompes le plus (plus c'est épais, plus tu rates)";
  practiceLegend.hidden = true;
  function renderFooter(): void {
    footer.innerHTML =
      "<kbd>Tab</kbd> / <kbd>Échap</kbd> — recommencer · " +
      "<kbd>Ctrl</kbd>+<kbd>⌫</kbd> — effacer le mot";
    practiceLegend.hidden = mode !== "practice";
  }
  renderFooter();
  const input = el("input", "hidden-input");
  input.type = "text";
  input.autocapitalize = "off";
  input.spellcheck = false;
  input.setAttribute("autocomplete", "off");

  const testScreen = el("div");
  testScreen.append(
    controls, coachBar, liveStats, wordsWrap, speedLegend, practiceLegend, footer, input
  );
  const resultScreen = el("div");
  resultScreen.hidden = true;
  root.append(testScreen, resultScreen);

  function renderControls(): void {
    controls.innerHTML = "";
    // chips « nombre de mots » (mode mots)
    for (const count of WORD_COUNTS) {
      const b = el("button", "chip-btn", String(count));
      if (cfg.testKind === "words" && cfg.wordCount === count) b.classList.add("on");
      b.addEventListener("click", () => {
        cfg.testKind = "words";
        cfg.wordCount = count;
        saveConfig(cfg);
        newTest();
      });
      controls.append(b);
    }
    // chips « durée » (mode chrono)
    for (const secs of WORD_DURATIONS) {
      const b = el("button", "chip-btn", secs + "s");
      if (cfg.testKind === "time" && cfg.duration === secs) b.classList.add("on");
      b.title = "Test au chrono : tape le plus possible en " + secs + " s";
      b.addEventListener("click", () => {
        cfg.testKind = "time";
        cfg.duration = secs;
        saveConfig(cfg);
        newTest();
      });
      controls.append(b);
    }
    controls.append(el("span", "sep", "|"));

    const langSel = el("select");
    for (const [id, lang] of Object.entries(LANGS)) {
      const opt = el("option", undefined, lang.label);
      opt.value = id;
      if (cfg.lang === id) opt.selected = true;
      langSel.append(opt);
    }
    langSel.addEventListener("change", () => {
      cfg.lang = langSel.value as LangId;
      saveConfig(cfg);
      newTest();
    });
    controls.append(langSel);

    // ponctuation & majuscules (sans effet sur le pool code ni en entraînement)
    const punctBtn = el("button", "chip-btn", "Aa,");
    if (cfg.punctuation) punctBtn.classList.add("on");
    punctBtn.title =
      "Saupoudre majuscules et ponctuation pour se rapprocher d'un texte réel";
    punctBtn.addEventListener("click", () => {
      cfg.punctuation = !cfg.punctuation;
      saveConfig(cfg);
      newTest();
    });
    controls.append(punctBtn);

    // mort subite : une faute arrête le test
    const suddenBtn = el("button", "chip-btn", "☠");
    if (cfg.sudden) suddenBtn.classList.add("on");
    suddenBtn.title = "Mort subite : la moindre faute arrête le test";
    suddenBtn.addEventListener("click", () => {
      cfg.sudden = !cfg.sudden;
      saveConfig(cfg);
      newTest();
    });
    controls.append(suddenBtn);

    controls.append(el("span", "sep", "|"));
    // entraînement : cycle normal → ⚑ mots lents/fautés → ⚑ bigrammes difficiles
    const practiceLabel =
      mode !== "practice"
        ? "⚑ Entraînement"
        : practiceKind === "bigrams"
        ? "⚑ Bigrammes"
        : "⚑ Mots";
    const practiceBtn = el("button", "chip-btn", practiceLabel);
    if (mode === "practice") practiceBtn.classList.add("practice-on");
    practiceBtn.title =
      "Cycle : off → mots lents/fautés → bigrammes difficiles (seuils dans Réglages)";
    practiceBtn.addEventListener("click", () => {
      drillWord = null;
      forcedPool = null;
      if (mode !== "practice") {
        mode = "practice";
        practiceKind = "words";
      } else if (practiceKind === "words") {
        practiceKind = "bigrams";
      } else {
        mode = "normal";
        practiceKind = "words";
      }
      newTest();
    });
    controls.append(practiceBtn);

    controls.append(el("span", "sep", "|"));
    const hintsBtn = el("button", "chip-btn", "💡 Indices");
    if (cfg.hints) hintsBtn.classList.add("on");
    hintsBtn.title =
      "Affiche ou masque les indices : surlignage vitesse et soulignage des fautes. " +
      "Masqués, ils ne biaisent plus ta frappe (voir l'onglet Biais).";
    hintsBtn.addEventListener("click", () => {
      cfg.hints = !cfg.hints;
      saveConfig(cfg);
      renderControls();
      renderSpeedLegend();
      renderAllWords();
    });
    controls.append(hintsBtn);

    controls.append(el("span", "sep", "|"));
    // rythme : cycle off → médiane → record. En entraînement, la médiane est
    // celle de tes entraînements (pas des tests normaux).
    const target = cfg.paceTarget === "record" ? "record" : "médiane";
    const paceBase = mode === "practice" ? "⏱ Rythme entraîn." : "⏱ Rythme";
    const paceName = cfg.paceCaret ? `${paceBase} (${target})` : paceBase;
    const paceLabel = cfg.paceCaret && paceWpm !== null ? `${paceName} ${fmt(paceWpm)}` : paceName;
    const paceBtn = el("button", "chip-btn", paceLabel);
    if (cfg.paceCaret) paceBtn.classList.add("on");
    paceBtn.title = cfg.paceCaret
      ? cfg.paceTarget === "record"
        ? "Curseur fantôme calé sur ton record pour cette configuration"
        : `Curseur fantôme à ta vitesse médiane sur tes ${cfg.paceAvgCount} derniers tests`
      : "Curseur fantôme désactivé — clique pour courser ta médiane, puis ton record";
    paceBtn.addEventListener("click", () => {
      if (!cfg.paceCaret) {
        cfg.paceCaret = true;
        cfg.paceTarget = "median";
      } else if (cfg.paceTarget === "median") {
        cfg.paceTarget = "record";
      } else {
        cfg.paceCaret = false;
        cfg.paceTarget = "median";
      }
      saveConfig(cfg);
      newTest();
    });
    controls.append(paceBtn);
  }

  /** Fabrique un chip de mot cliquable pour le bandeau coach (lance sa révision ciblée). */
  function coachChip(c: PracticeCandidate, extraClass?: string): HTMLElement {
    const chip = el("button", extraClass ? `coach-word ${extraClass}` : "coach-word", c.word);
    chip.title =
      `${c.avgWpm === null ? "—" : fmt(c.avgWpm)} wpm · ${fmtPct(c.errRate)} de fautes` +
      " — clique pour une révision ciblée de ce mot";
    chip.addEventListener("click", () => {
      drillWord = c.word;
      forcedPool = null;
      mode = "practice";
      toast(`Révision de « ${c.word} » : fragments ciblés sur tes fautes, jusqu'au mot complet`);
      newTest();
    });
    return chip;
  }

  /**
   * Coach : bandeau discret listant les pires mots du moment (mêmes « Priorités
   * d'entraînement » que l'onglet Stats), plus — séparément et toujours visible dès
   * qu'il y a des mots à travailler — la file de révision espacée : les mots dont
   * l'intervalle Anki vient d'être atteint depuis leur dernier test normal. Les mots
   * négligés depuis trop longtemps ({@link RECALL_STALE_RATIO}) en sont exclus : ce
   * n'est plus une échéance de révision « à point », juste un mot délaissé, qui
   * reste de toute façon repêché via le classement « à retravailler ». Un clic sur
   * un mot lance directement sa révision ciblée. Masqué en entraînement et dès la
   * première frappe.
   */
  function renderCoach(): void {
    coachBar.innerHTML = "";
    if (mode !== "normal" || engine?.startedAt !== null) {
      coachBar.hidden = true;
      return;
    }
    const all = practicePool(cfg.lang, cfg, stats, undefined, 200);
    if (all.length === 0) {
      coachBar.hidden = true;
      return;
    }
    const worst = all.slice(0, 3);
    const worstWords = new Set(worst.map((c) => c.word));
    const due = all.filter(
      (c) => c.due && c.overdueRatio <= RECALL_STALE_RATIO && !worstWords.has(c.word)
    );

    coachBar.append(el("span", "coach-label", "⚑ À retravailler :"));
    for (const c of worst) coachBar.append(coachChip(c));

    const DUE_SHOWN = 3;
    coachBar.append(el("span", "coach-label due", "🔁 Révision espacée :"));
    if (due.length === 0) {
      coachBar.append(el("span", "coach-empty", "rien pour le moment"));
    } else {
      const shown = dueExpanded ? due : due.slice(0, DUE_SHOWN);
      for (const c of shown) coachBar.append(coachChip(c, "due"));
      if (due.length > DUE_SHOWN && !dueExpanded) {
        const more = el("button", "coach-more", `voir plus (+${due.length - DUE_SHOWN})`);
        more.addEventListener("click", () => {
          dueExpanded = true;
          renderCoach();
        });
        coachBar.append(more);
      }
    }
    coachBar.hidden = false;
  }

  /** Nombre de mots à générer (mode durée : marge large pour le flux continu). */
  function targetCount(): number {
    return cfg.testKind === "time" ? Math.max(40, cfg.duration * 3) : cfg.wordCount;
  }

  /** Applique la ponctuation si activée (jamais en entraînement ni sur le pool code). */
  function maybePunct(words: string[]): WordInput[] {
    if (cfg.punctuation && cfg.lang !== "code" && mode === "normal") {
      return decoratePunctuation(words);
    }
    return words;
  }

  function buildWordList(): WordInput[] {
    const count = targetCount();
    if (mode === "practice") {
      if (drillWord) {
        return generateWordDrill(
          drillWord,
          count,
          LANGS[cfg.lang].words,
          loadBigramStats(cfg.lang),
          stats[drillWord]
        );
      }
      if (forcedPool && forcedPool.length > 0) {
        const out: string[] = [];
        for (let i = 0; i < count; i++) {
          out.push(forcedPool[Math.floor(Math.random() * forcedPool.length)] as string);
        }
        return out;
      }
      const practice =
        practiceKind === "bigrams"
          ? generateBigramPractice(cfg.lang, count, loadBigramStats(cfg.lang))
          : generatePractice(cfg.lang, count, cfg, stats);
      if (practice) return practice;
      toast(
        practiceKind === "bigrams"
          ? "Pas encore assez de bigrammes mesurés — fais d'abord quelques tests !"
          : "Pas encore assez de données pour l'entraînement — fais d'abord quelques tests !"
      );
      mode = "normal";
    }
    return maybePunct(generateWords(cfg.lang, count));
  }

  /** Le rythme n'est réellement affiché que s'il est activé ET qu'on a une cible. */
  function paceActive(): boolean {
    return cfg.paceCaret && paceWpm !== null;
  }

  /**
   * Écrit le test courant au journal brut (une seule fois). `at` fixe la date de
   * l'entrée : pour un test terminé, on la cale sur `result.date` afin que
   * journal et historique partagent le même identifiant (suppression manuelle).
   */
  function logTest(completed: boolean, at: number = Date.now()): void {
    if (logged || !engine || engine.startedAt === null) return;
    // pause prolongée : l'utilisateur s'est arrêté, les mesures sont faussées —
    // on n'écrit rien au journal (on marque quand même le test comme traité).
    if (engine.abandonedByPause) {
      logged = true;
      return;
    }
    const attempts = engine.wordAttempts();
    if (attempts.length === 0) return;
    const agg = engine.aggregates();
    agg.dwellAvg = dwellN > 0 ? dwellSum / dwellN : 0;
    agg.roll = keyDownN > 0 ? rollCount / keyDownN : 0;
    appendTestLog({
      date: at,
      lang: engine.lang,
      mode: engine.mode,
      pace: paceActive(),
      paceWpm: paceActive() ? paceWpm : null,
      hints: cfg.hints && cfg.colorBy !== "off",
      wordCount: cfg.testKind === "time" ? cfg.duration : engine.words.length,
      completed,
      sudden: cfg.sudden,
      agg,
      words: attempts.map((a) => ({
        text: a.text,
        index: a.index,
        len: a.len,
        timeMs: a.timeMs,
        errors: a.errors,
        correct: a.correct,
        posErrors: a.posErrors,
        startGapMs: a.startGapMs,
        line: a.line,
        paceD: a.paceD,
        bks: a.bks,
      })),
    });
    logged = true;
  }

  /** Sauvegarde un test abandonné en cours (Tab/Échap, navigation, fermeture). */
  function flushPartial(): void {
    if (!engine || engine.finished) return;
    logTest(false);
  }

  function newTest(): void {
    flushPartial();
    window.clearTimeout(timeTimer);
    dwellSum = dwellN = rollCount = keyDownN = keysHeld = 0;
    keyDownAt.clear();
    cfg = loadConfig();
    stats = loadWordStats(cfg.lang);
    okSpeeds = okWpmMedianByWord(cfg.lang);
    buildSpeedDist();
    dueExpanded = false;
    // instantané « avant » du mot révisé : les stats par mot ne reçoivent pas les
    // entraînements, donc stats[drillWord] reflète bien l'état d'avant ce drill.
    if (mode === "practice" && drillWord) {
      const s = stats[drillWord];
      drillBefore = {
        word: drillWord,
        wpm: s ? wordAvgWpm(s) : null,
        errRate: s ? wordErrRate(s) : 0,
      };
    } else {
      drillBefore = null;
    }
    engine = new TestEngine(buildWordList(), cfg.lang, mode);
    logged = false;
    paceWpm =
      cfg.paceTarget === "record"
        ? bestRecord({
            lang: cfg.lang,
            mode,
            kind: cfg.testKind,
            target: cfg.testKind === "time" ? cfg.duration : cfg.wordCount,
          })
        : paceTargetWpm(cfg.lang, cfg.paceAvgCount, mode);
    resultScreen.hidden = true;
    testScreen.hidden = false;
    renderControls();
    renderFooter();
    renderCoach();
    renderSpeedLegend();
    renderAllWords();
    updateLive();
    window.clearInterval(liveTimer);
    liveTimer = window.setInterval(updateLive, 1000);
    paceCaret.hidden = true;
    startPaceLoop();
    input.value = "";
    input.focus();
  }

  function renderAllWords(): void {
    // en mode lisse, le curseur flottant remplace le trait par lettre (masqué en CSS)
    wordsEl.classList.toggle("smooth-caret", cfg.smoothCaret);
    wordsEl.innerHTML = "";
    wordEls = [];
    for (let i = 0; i < engine.words.length; i++) {
      const wordEl = el("span", "word");
      const w = engine.words[i]!;
      decorateSpeed(wordEl, w.base ?? w.text);
      wordsEl.append(wordEl, document.createTextNode(" "));
      wordEls.push(wordEl);
      renderWord(i);
    }
    scrollToActive();
    markLines();
  }

  /** Marque le premier mot de chaque ligne visuelle (pour l'analyse « saut de ligne »). */
  function markLines(): void {
    let prevTop = -Infinity;
    for (let i = 0; i < wordEls.length; i++) {
      const node = wordEls[i];
      const w = engine.words[i];
      if (!node || !w) continue;
      const top = node.offsetTop;
      w.line = top > prevTop + 1;
      prevTop = top;
    }
  }

  /** Vitesse retenue d'un mot : hors erreur si dispo, sinon moyenne globale. */
  function wordSpeed(text: string, stat: WordStat): number | null {
    return okSpeeds.get(text) ?? wordAvgWpm(stat);
  }

  /** Distribution triée des vitesses de tes mots (assez joués), pour l'échelle. */
  function buildSpeedDist(): void {
    speedDist = [];
    for (const [word, stat] of Object.entries(stats)) {
      if (stat.attempts < cfg.minAttempts) continue;
      const wpm = wordSpeed(word, stat);
      if (wpm !== null) speedDist.push(wpm);
    }
    speedDist.sort((a, b) => a - b);
  }

  /**
   * Surlignage continu : teinte de l'encre du mot d'après son RANG de vitesse
   * dans ta distribution (pas les seuils de réglage). Presque tout reste bronze,
   * du bronze foncé (lent) au bronze cuivré (rapide) ; seul le top ~1 % vire à l'or.
   */
  function decorateSpeed(node: HTMLElement, text: string): void {
    if (!cfg.hints) return;
    if (cfg.colorBy !== "speed" && cfg.colorBy !== "both") return;
    if (speedDist.length < 5) return; // pas assez de mots pour une échelle fiable
    const stat = stats[text];
    if (!stat || stat.attempts < cfg.minAttempts) return;
    const wpm = wordSpeed(text, stat);
    if (wpm === null) return;
    const pct = speedPercentile(wpm, speedDist);
    const { spd, redMix, gold } = speedShade(pct);
    node.classList.add("w-spd");
    node.style.setProperty("--spd", spd.toFixed(3));
    node.style.setProperty("--spd-red-mix", redMix.toFixed(3));
    node.style.setProperty("--spd-gold-mix", gold.toFixed(3));
  }

  /**
   * Intensités 0..1 du soulignage rouge en mode entraînement : taux de faute par
   * position, relatif au pire endroit du mot. Même langage visuel que le mode
   * « à risque » (soulignement, pas de halo). Ne s'affiche que sur les mots déjà
   * un peu joués.
   */
  function practiceUnderline(word: TestWord): number[] | null {
    if (!cfg.hints || mode !== "practice") return null;
    const stat = stats[word.base ?? word.text];
    if (!stat || stat.attempts < 2) return null;
    const rates = wordPosErrorRates(stat, word.text.length);
    const worst = Math.max(0, ...rates);
    if (worst <= 0) return null;
    return rates.map((r) => (r <= 0 ? 0 : Math.max(ERR_MARK_FLOOR, r / worst)));
  }

  /**
   * Intensités 0..1 du soulignage coloré par bigramme, pour les mots repérés
   * « à risque » (taux d'erreur ≥ seuil). Chaque position p correspond au
   * bigramme (lettre p-1 → lettre p) ; l'intensité est relative au pire endroit
   * du mot pour montrer d'un coup d'œil où se concentrent les fautes.
   */
  function errIntensities(word: TestWord): number[] | null {
    if (!cfg.hints) return null;
    if (cfg.colorBy !== "errors" && cfg.colorBy !== "both") return null;
    const stat = stats[word.base ?? word.text];
    if (!stat || stat.attempts < cfg.minAttempts) return null;
    if (wordErrRate(stat) < cfg.errWarnRate) return null;
    const rates = wordPosErrorRates(stat, word.text.length);
    const worst = Math.max(0, ...rates);
    if (worst <= 0) return rates.map(() => 0.55); // fautes hors position → uniforme
    return rates.map((r) =>
      r <= 0 ? 0 : Math.max(ERR_MARK_FLOOR, r / worst)
    );
  }

  function renderWord(i: number): void {
    const word = engine.words[i];
    const node = wordEls[i];
    if (!word || !node) return;
    node.innerHTML = "";
    const isActive = i === engine.index && !engine.finished;
    const len = Math.max(word.text.length, word.typed.length);
    // En entraînement, le soulignage rouge marque les positions les plus fautées ;
    // sinon, il marque les bigrammes à risque. Même rendu visuel (err-mark).
    const practiceMarks = practiceUnderline(word);
    const errs = practiceMarks ?? errIntensities(word);
    const posBased = practiceMarks !== null;
    for (let p = 0; p < len; p++) {
      const expected = word.text[p];
      const state = word.states[p];
      const letter = el("span", "letter", expected ?? word.typed[p] ?? "");
      if (p < word.typed.length && state) letter.classList.add(state);
      if (isActive && p === word.typed.length) letter.classList.add("caret");
      // soulignage rouge, uniquement sur les lettres pas encore tapées (une fois
      // tapée, l'état réel de la frappe reprend la main)
      const errI = errs?.[p] ?? 0;
      if (errI > 0 && p >= word.typed.length) {
        letter.classList.add("err-mark");
        letter.style.setProperty("--err-i", errI.toFixed(3));
        const st = stats[word.base ?? word.text];
        const pct = Math.round(
          ((st?.posErrors?.[p] ?? 0) / Math.max(1, st?.attempts ?? 1)) * 100
        );
        if (posBased) {
          letter.title = `${pct} % d'erreurs à cet endroit`;
        } else {
          const prev = p === 0 ? "␣" : word.text[p - 1];
        letter.title = `bigramme « ${prev}${expected ?? ""} » — ${pct} % d'erreurs`;
        }
      }
      node.append(letter);
    }
    if (isActive && word.typed.length >= len && node.lastElementChild) {
      node.lastElementChild.classList.add("caret-end");
    }
  }

  function scrollToActive(): void {
    const active = wordEls[engine.index];
    if (!active) return;
    const lineHeight = active.offsetHeight || 38;
    const target = active.offsetTop - wordsEl.offsetTop;
    // garde la ligne active en deuxième position
    wordsEl.scrollTop = Math.max(0, target - lineHeight);
  }

  /**
   * Positionne le curseur de rythme : il avance à `paceWpm` mots/min à travers
   * le flux de caractères (chaque mot = ses lettres + une espace), comme si un
   * fantôme tapait à ta vitesse moyenne. Interpole entre les lettres pour un
   * déplacement fluide.
   */
  function updatePaceCaret(): void {
    if (
      !cfg.paceCaret ||
      paceWpm === null ||
      paceWpm <= 0 ||
      engine.finished ||
      engine.startedAt === null
    ) {
      paceCaret.hidden = true;
      return;
    }
    const elapsed = performance.now() - engine.startedAt;
    // Fantôme équitable : le WPM net ne compte que les mots parfaits. Pour qu'«
    // arriver avec le fantôme » = même vitesse HORS erreur, on décale le fantôme
    // en avant des caractères des mots validés fautés (le fantôme, lui, n'a pas
    // à les « payer »). L'utilisateur doit donc les rattraper en net.
    let penalty = 0;
    for (let i = 0; i < engine.index; i++) {
      const w = engine.words[i];
      if (w && w.endMs !== undefined && w.typed !== w.text) penalty += w.text.length + 1;
    }
    // WPM = (caractères / 5) / minutes  →  caractères = WPM * 5 * minutes
    let remaining = (paceWpm * 5 * elapsed) / 60000 + penalty;

    let wi = 0;
    for (; wi < engine.words.length - 1; wi++) {
      const slot = (engine.words[wi] as { text: string }).text.length + 1;
      if (remaining < slot) break;
      remaining -= slot;
    }
    const word = engine.words[wi];
    const wordEl = wordEls[wi];
    if (!word || !wordEl) {
      paceCaret.hidden = true;
      return;
    }
    const len = word.text.length;
    let x: number;
    let refLetter: HTMLElement | undefined;
    if (remaining < len) {
      const p = Math.floor(remaining);
      refLetter = wordEl.children[p] as HTMLElement | undefined;
      if (!refLetter) {
        paceCaret.hidden = true;
        return;
      }
      x = refLetter.offsetLeft + (remaining - p) * refLetter.offsetWidth;
    } else {
      // dans l'espace qui suit le mot
      refLetter = wordEl.children[len - 1] as HTMLElement | undefined;
      if (!refLetter) {
        paceCaret.hidden = true;
        return;
      }
      const spaceW = refLetter.offsetWidth * 0.6;
      x = refLetter.offsetLeft + refLetter.offsetWidth +
        Math.min(1, remaining - len) * spaceW;
    }
    const yInWrap = refLetter.offsetTop - wordsEl.scrollTop;
    // masque le curseur s'il est hors de la zone visible (en avance de plusieurs lignes)
    if (yInWrap < -refLetter.offsetHeight || yInWrap > wordsEl.clientHeight) {
      paceCaret.hidden = true;
      return;
    }
    paceCaret.hidden = false;
    paceCaret.style.left = `${x}px`;
    paceCaret.style.top = `${yInWrap}px`;
    paceCaret.style.height = `${refLetter.offsetHeight}px`;
  }

  /**
   * Positionne le curseur lisse sur la lettre active et le laisse glisser (la
   * transition CSS anime le déplacement entre deux frappes). Coordonnées prises
   * via getBoundingClientRect pour rester juste quel que soit l'offsetParent.
   */
  function updateLiveCaret(): void {
    if (!cfg.smoothCaret || engine.finished) {
      liveCaret.hidden = true;
      return;
    }
    const mid = wordsEl.querySelector<HTMLElement>(".letter.caret");
    const ref = mid ?? wordsEl.querySelector<HTMLElement>(".letter.caret-end");
    if (!ref) {
      liveCaret.hidden = true;
      return;
    }
    const wrap = wordsWrap.getBoundingClientRect();
    const box = wordsEl.getBoundingClientRect();
    const r = ref.getBoundingClientRect();
    const y = r.top - wrap.top;
    if (r.bottom < box.top - 1 || r.top > box.bottom + 1) {
      liveCaret.hidden = true;
      return;
    }
    liveCaret.hidden = false;
    liveCaret.style.left = `${(mid ? r.left : r.right) - wrap.left}px`;
    liveCaret.style.top = `${y}px`;
    liveCaret.style.height = `${r.height}px`;
  }

  function startPaceLoop(): void {
    cancelAnimationFrame(paceRaf);
    const loop = () => {
      updatePaceCaret();
      updateLiveCaret();
      if (!engine.finished) paceRaf = requestAnimationFrame(loop);
    };
    paceRaf = requestAnimationFrame(loop);
  }

  function updateLive(): void {
    if (engine.finished) return;
    if (engine.startedAt === null) {
      liveStats.innerHTML = `<span class="dim">${
        mode === "practice" ? "entraînement — " : ""
      }tape pour démarrer</span>`;
      return;
    }
    const now = performance.now();
    const wpm = engine.liveWpm(now);
    const acc = engine.liveAccuracy();
    let progress: string;
    if (cfg.testKind === "time" && engine.startedAt !== null) {
      const left = Math.max(0, cfg.duration - (now - engine.startedAt) / 1000);
      progress = `${fmt(left)} s`;
    } else {
      progress = `${engine.index}/${engine.words.length}`;
    }
    liveStats.innerHTML =
      `<span>${fmt(wpm)} wpm</span>` +
      `<span class="dim">${fmt(acc * 100)} %</span>` +
      `<span class="dim">${progress}</span>`;
  }

  /** Écart-type du wpm par mot dans le test (régularité intra-test). */
  function testConsistency(result: { words: { timeMs: number | null; text: string }[] }): number {
    const wpms: number[] = [];
    for (const w of result.words) {
      if (w.timeMs !== null && w.timeMs > 0) wpms.push(w.text.length / 5 / (w.timeMs / 60000));
    }
    if (wpms.length < 2) return 0;
    const mean = wpms.reduce((a, b) => a + b, 0) / wpms.length;
    return Math.sqrt(wpms.reduce((a, b) => a + (b - mean) ** 2, 0) / wpms.length);
  }

  function finish(): void {
    window.clearInterval(liveTimer);
    window.clearTimeout(timeTimer);
    cancelAnimationFrame(paceRaf);
    paceCaret.hidden = true;
    // pause prolongée pendant le test → écarté des stats (voir renderDiscarded)
    if (engine.abandonedByPause) {
      logged = true; // rien à journaliser (flushPartial ultérieur ne fera rien)
      renderDiscarded();
      return;
    }
    const result = engine.result();
    const target = cfg.testKind === "time" ? cfg.duration : cfg.wordCount;
    const meta = { lang: cfg.lang, mode, kind: cfg.testKind, target };
    // record calculé AVANT d'ajouter le test à l'historique (sinon il se bat lui-même)
    const newRecord = saveRecord(meta, result.wpm, result.date);
    applyResult(result, engine.bigrams, engine.confusions, {
      kind: cfg.testKind,
      target,
      consistency: testConsistency(result),
    });
    logTest(true, result.date);
    // instantané pour une éventuelle suppression manuelle (l'engine sera remplacé
    // au prochain test) : on garde de quoi défaire exactement cet enregistrement.
    const savedBigrams = engine.bigrams;
    const savedConfusions = engine.confusions;
    const savedLang = engine.lang;
    const revertMeta = { kind: cfg.testKind, target };
    let deleted = false;
    testScreen.hidden = true;
    resultScreen.hidden = false;
    renderResults(
      resultScreen,
      result,
      {
        onRestart: () => {
          forcedPool = null;
          newTest();
        },
        onPracticeWords: (words) => {
          if (words.length === 0) {
            toast("Aucun mot à retravailler dans ce test, bien joué !");
            return;
          }
          mode = "practice";
          forcedPool = words;
          newTest();
        },
        onDelete: () => {
          if (deleted) return; // garde-fou : une seule suppression
          deleted = true;
          revertResult(result, savedBigrams, savedConfusions, revertMeta);
          removeTestLog(savedLang, result.date);
          toast("Test supprimé — retiré de tes statistiques.");
          forcedPool = null;
          newTest();
        },
      },
      { newRecord, drill: buildDrillReport(result) }
    );
  }

  /**
   * Bilan avant/après d'une révision ciblée (drill) : compare l'état du mot avant
   * le drill (agrégats, non pollués par les entraînements) à sa vitesse et son
   * taux de faute pendant ce drill (essais du mot complet). Renvoie null hors
   * drill ou si aucun essai chronométré du mot complet.
   */
  function buildDrillReport(result: TestResult): DrillReport | null {
    if (!drillBefore) return null;
    const word = drillBefore.word;
    const fulls = result.words.filter((w) => w.text === word);
    if (fulls.length === 0) return null;
    const wpms = fulls
      .map((w) => (w.timeMs !== null && w.timeMs > 0 ? w.text.length / 5 / (w.timeMs / 60000) : null))
      .filter((v): v is number => v !== null);
    const errAttempts = fulls.filter((w) => w.errors > 0).length;
    return {
      word,
      beforeWpm: drillBefore.wpm,
      afterWpm: median(wpms),
      beforeErrRate: drillBefore.errRate,
      afterErrRate: errAttempts / fulls.length,
      attempts: fulls.length,
    };
  }

  /** Avance du fantôme (en caractères) à l'instant `now`. */
  function ghostCharsAt(now: number): number {
    if (paceWpm === null || engine.startedAt === null) return 0;
    return (paceWpm * 5 * (now - engine.startedAt)) / 60000;
  }
  /** Offset (en caractères) du début du mot i dans le flux (lettres + espaces). */
  function wordCharOffset(i: number): number {
    let off = 0;
    for (let j = 0; j < i; j++) off += (engine.words[j]?.text.length ?? 0) + 1;
    return off;
  }

  function handleChar(ch: string): void {
    const prevIndex = engine.index;
    const w = engine.words[prevIndex];
    const firstOfWord = !!w && w.typed.length === 0 && ch !== " ";
    const wasIdle = engine.startedAt === null;
    const now = performance.now();
    const ev = engine.typeChar(ch, now);
    if (ev === "ignore") return;
    // première frappe : le test démarre, on efface le bandeau coach
    if (wasIdle && engine.startedAt !== null) coachBar.hidden = true;
    // démarrage du chrono en mode durée, à la première frappe
    if (wasIdle && engine.startedAt !== null && cfg.testKind === "time") {
      timeTimer = window.setTimeout(() => {
        engine.forceFinish(performance.now());
        finish();
      }, cfg.duration * 1000);
    }
    // mort subite : la moindre frappe fausse arrête le test
    if (cfg.sudden && ch !== " " && !engine.finished) {
      const last = engine.keystrokes[engine.keystrokes.length - 1];
      if (last && !last.correct) {
        renderWord(prevIndex);
        renderSuddenFail();
        return;
      }
    }
    // échantillon d'avance/retard sur le fantôme à la 1re frappe du mot
    if (firstOfWord && w && paceActive()) {
      w.paceD = Math.round(wordCharOffset(prevIndex) - ghostCharsAt(now));
    }
    renderWord(prevIndex);
    if (engine.index !== prevIndex && !engine.finished) {
      renderWord(engine.index);
      scrollToActive();
      // flux continu du mode durée : recharge des mots avant d'atteindre la fin
      if (cfg.testKind === "time" && engine.index > engine.words.length - 25) {
        engine.appendWords(maybePunct(generateWords(cfg.lang, 40)));
        renderAllWords();
      }
    }
    updateLive();
    if (ev === "finish") finish();
  }

  /**
   * Écran affiché quand le test est écarté : une pause d'au moins
   * {@link IDLE_ABANDON_MS} a été détectée (l'utilisateur s'est arrêté). Rien
   * n'est enregistré — ni stats, ni historique, ni record, ni journal.
   */
  function renderDiscarded(): void {
    window.clearInterval(liveTimer);
    window.clearTimeout(timeTimer);
    cancelAnimationFrame(paceRaf);
    paceCaret.hidden = true;
    testScreen.hidden = true;
    resultScreen.hidden = false;
    resultScreen.innerHTML = "";
    const box = el("div", "sudden-fail");
    box.append(el("div", "sf-title gold-metal", "⏸ Test ignoré"));
    box.append(
      el(
        "div",
        "sf-sub",
        `Pause de ${fmt(engine.maxIdleMs / 1000)} s détectée — tu semblais parti. ` +
          "Rien n'a été enregistré pour ne pas fausser tes stats."
      )
    );
    const btn = el("button", "btn primary", "Recommencer (Tab)");
    btn.addEventListener("click", () => {
      forcedPool = null;
      newTest();
    });
    box.append(btn);
    resultScreen.append(box);
  }

  /** Écran « raté » de la mort subite (pas d'entrée d'historique, journal partiel). */
  function renderSuddenFail(): void {
    window.clearInterval(liveTimer);
    window.clearTimeout(timeTimer);
    cancelAnimationFrame(paceRaf);
    paceCaret.hidden = true;
    logTest(false);
    testScreen.hidden = true;
    resultScreen.hidden = false;
    resultScreen.innerHTML = "";
    const box = el("div", "sudden-fail");
    box.append(el("div", "sf-title gold-metal", "☠ Raté"));
    box.append(
      el(
        "div",
        "sf-sub",
        `Une faute en mort subite après ${engine.index} mot(s) parfait(s).`
      )
    );
    box.append(
      el("div", "sf-wpm", `${fmt(engine.liveWpm(performance.now()))} wpm au moment de la chute`)
    );
    const btn = el("button", "btn primary", "Recommencer (Tab)");
    btn.addEventListener("click", () => {
      forcedPool = null;
      newTest();
    });
    box.append(btn);
    resultScreen.append(box);
  }

  function handleBackspace(): void {
    const prevIndex = engine.index;
    if (engine.backspace(performance.now()) === "ignore") return;
    renderWord(prevIndex);
    if (engine.index !== prevIndex) {
      renderWord(engine.index);
      scrollToActive();
    }
  }

  /** Ctrl/Alt+Backspace : efface le mot courant sans franchir la limite */
  function handleDeleteWord(): void {
    const prevIndex = engine.index;
    let changed = false;
    while (engine.current.typed.length > 0) {
      if (engine.backspace(performance.now()) === "ignore") break;
      changed = true;
    }
    if (changed) renderWord(prevIndex);
  }

  // --- saisie : input caché pour gérer accents et touches mortes ---
  input.addEventListener(
    "input",
    (e) => {
      const ie = e as InputEvent;
      if (ie.isComposing || ie.inputType === "insertCompositionText") return;
      // le retour arrière est géré dans keydown (voir plus bas) ; cette branche
      // ne sert que de secours pour les claviers logiciels mobiles
      if (ie.inputType === "deleteContentBackward") {
        handleBackspace();
      } else if (ie.data) {
        for (const ch of ie.data) handleChar(ch);
      }
      input.value = "";
    },
    { signal }
  );
  input.addEventListener(
    "compositionend",
    (e) => {
      const data = (e as CompositionEvent).data;
      if (data) for (const ch of data) handleChar(ch);
      input.value = "";
    },
    { signal }
  );

  document.addEventListener(
    "keydown",
    (e) => {
      // dwell time & rollover : uniquement les touches « caractère », hors répétition
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat) {
        keyDownN += 1;
        if (keysHeld > 0) rollCount += 1; // une frappe alors qu'une touche est tenue
        keysHeld += 1;
        keyDownAt.set(e.code, e.timeStamp);
      }
      if (e.key === "Tab" || e.key === "Escape") {
        e.preventDefault();
        forcedPool = null;
        newTest();
        return;
      }
      // Backspace ne déclenche pas d'événement input (le champ caché est vide),
      // on le capte donc ici pour permettre de revenir en arrière
      if (e.key === "Backspace") {
        e.preventDefault();
        if (e.ctrlKey || e.altKey || e.metaKey) handleDeleteWord();
        else handleBackspace();
      }
    },
    { signal }
  );

  document.addEventListener(
    "keyup",
    (e) => {
      const down = keyDownAt.get(e.code);
      if (down === undefined) return;
      keyDownAt.delete(e.code);
      keysHeld = Math.max(0, keysHeld - 1);
      const d = e.timeStamp - down;
      if (d > 0 && d < 1000) {
        dwellSum += d;
        dwellN += 1;
      }
    },
    { signal }
  );

  wordsWrap.addEventListener("click", () => input.focus(), { signal });
  input.addEventListener(
    "blur",
    () => {
      if (!engine.finished) focusHint.hidden = false;
    },
    { signal }
  );
  input.addEventListener("focus", () => (focusHint.hidden = true), { signal });

  // fermeture de l'onglet en plein test → on sauvegarde ce qui a été tapé
  window.addEventListener("beforeunload", flushPartial, { signal });

  signal.addEventListener("abort", () => {
    window.clearInterval(liveTimer);
    window.clearTimeout(timeTimer);
    cancelAnimationFrame(paceRaf);
    flushPartial(); // changement d'onglet (Stats/Réglages) en plein test
  });

  // relais depuis l'onglet Stats : réviser un mot précis en boucle
  try {
    const raw = sessionStorage.getItem("ft:drill");
    if (raw) {
      sessionStorage.removeItem("ft:drill");
      const { lang, word } = JSON.parse(raw) as { lang: LangId; word: string };
      if (LANGS[lang]) {
        cfg.lang = lang;
        saveConfig(cfg);
        mode = "practice";
        drillWord = word;
        toast(`Révision de « ${word} » : fragments de plus en plus longs, ciblés sur tes fautes`);
      }
    }
  } catch {
    // relais illisible : test normal
  }

  newTest();
}
