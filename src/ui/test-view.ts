import { TestEngine } from "../engine";
import { loadConfig, saveConfig } from "../config";
import {
  appendTestLog,
  applyResult,
  loadWordStats,
  okWpmMedianByWord,
  paceTargetWpm,
  wordAvgWpm,
  wordErrRate,
  wordPosErrorRates,
} from "../store";
import { generatePractice, generateWords, LANGS } from "../wordlist";
import type { Config, LangId, TestMode, TestWord, WordStat } from "../types";

// intensité minimale d'un trait de soulignage coloré (pour rester visible)
const ERR_MARK_FLOOR = 0.28;
import { el, fmt, speedPercentile, speedShade, toast } from "./common";
import { renderResults } from "./results-view";

const WORD_COUNTS = [10, 25, 50];

export function mountTestView(root: HTMLElement, signal: AbortSignal): void {
  let cfg = loadConfig();
  let mode: TestMode = "normal";
  let engine: TestEngine;
  let stats: Record<string, WordStat> = {};
  let okSpeeds = new Map<string, number>(); // vitesse hors erreur par mot
  let speedDist: number[] = []; // vitesses triées de tes mots, pour l'échelle
  let wordEls: HTMLElement[] = [];
  let liveTimer: number | undefined;
  let paceRaf = 0;
  let paceWpm: number | null = null; // vitesse cible (moyenne des n derniers)
  let logged = false; // le test courant a-t-il déjà été écrit au journal ?
  /** mots imposés pour un entraînement lancé depuis l'écran de résultats */
  let forcedPool: string[] | null = null;

  root.innerHTML = "";

  const controls = el("div", "test-controls");
  const liveStats = el("div", "live-stats");
  const wordsWrap = el("div", "words-wrap");
  const wordsEl = el("div", "words");
  const paceCaret = el("div", "pace-caret");
  paceCaret.hidden = true;
  const focusHint = el("div", "focus-hint", "Clique ici puis tape pour commencer");
  focusHint.hidden = true;
  // le curseur de rythme est enfant de wordsWrap (survit au re-render de wordsEl)
  wordsWrap.append(wordsEl, paceCaret, focusHint);
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
    controls, liveStats, wordsWrap, speedLegend, practiceLegend, footer, input
  );
  const resultScreen = el("div");
  resultScreen.hidden = true;
  root.append(testScreen, resultScreen);

  function renderControls(): void {
    controls.innerHTML = "";
    for (const count of WORD_COUNTS) {
      const b = el("button", "chip-btn", String(count));
      if (cfg.wordCount === count) b.classList.add("on");
      b.addEventListener("click", () => {
        cfg.wordCount = count;
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

    controls.append(el("span", "sep", "|"));
    const practiceBtn = el("button", "chip-btn", "⚑ Entraînement");
    if (mode === "practice") practiceBtn.classList.add("practice-on");
    practiceBtn.title =
      "Test ciblé sur tes mots lents ou fautés (seuils dans Réglages)";
    practiceBtn.addEventListener("click", () => {
      mode = mode === "practice" ? "normal" : "practice";
      forcedPool = null;
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
    // en entraînement, la cible est la médiane de tes entraînements (pas des tests normaux)
    const paceName = mode === "practice" ? "⏱ Rythme entraînement" : "⏱ Rythme";
    const paceKind = mode === "practice" ? "entraînements" : "tests";
    const paceLabel =
      paceWpm !== null ? `${paceName} ${fmt(paceWpm)}` : paceName;
    const paceBtn = el("button", "chip-btn", paceLabel);
    if (cfg.paceCaret) paceBtn.classList.add("on");
    paceBtn.title =
      paceWpm !== null
        ? `Curseur fantôme avançant à ta vitesse médiane sur tes ${cfg.paceAvgCount} derniers ${paceKind} (${fmt(paceWpm)} wpm)`
        : `Curseur fantôme à ta vitesse médiane — fais d'abord quelques ${paceKind} dans cette langue`;
    paceBtn.addEventListener("click", () => {
      cfg.paceCaret = !cfg.paceCaret;
      saveConfig(cfg);
      renderControls();
      if (!cfg.paceCaret) paceCaret.hidden = true;
    });
    controls.append(paceBtn);
  }

  function buildWordList(): string[] {
    if (mode === "practice") {
      if (forcedPool && forcedPool.length > 0) {
        const out: string[] = [];
        for (let i = 0; i < cfg.wordCount; i++) {
          out.push(forcedPool[Math.floor(Math.random() * forcedPool.length)] as string);
        }
        return out;
      }
      const practice = generatePractice(cfg.lang, cfg.wordCount, cfg, stats);
      if (practice) return practice;
      toast(
        "Pas encore assez de données pour l'entraînement — fais d'abord quelques tests !"
      );
      mode = "normal";
    }
    return generateWords(cfg.lang, cfg.wordCount);
  }

  /** Le rythme n'est réellement affiché que s'il est activé ET qu'on a une cible. */
  function paceActive(): boolean {
    return cfg.paceCaret && paceWpm !== null;
  }

  /** Écrit le test courant au journal brut (une seule fois). */
  function logTest(completed: boolean): void {
    if (logged || !engine || engine.startedAt === null) return;
    const attempts = engine.wordAttempts();
    if (attempts.length === 0) return;
    appendTestLog({
      date: Date.now(),
      lang: engine.lang,
      mode: engine.mode,
      pace: paceActive(),
      paceWpm: paceActive() ? paceWpm : null,
      hints: cfg.hints && cfg.colorBy !== "off",
      wordCount: engine.words.length,
      completed,
      words: attempts.map((a) => ({
        text: a.text,
        index: a.index,
        len: a.len,
        timeMs: a.timeMs,
        errors: a.errors,
        correct: a.correct,
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
    cfg = loadConfig();
    stats = loadWordStats(cfg.lang);
    okSpeeds = okWpmMedianByWord(cfg.lang);
    buildSpeedDist();
    engine = new TestEngine(buildWordList(), cfg.lang, mode);
    logged = false;
    paceWpm = paceTargetWpm(cfg.lang, cfg.paceAvgCount, mode);
    resultScreen.hidden = true;
    testScreen.hidden = false;
    renderControls();
    renderFooter();
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
    wordsEl.innerHTML = "";
    wordEls = [];
    for (let i = 0; i < engine.words.length; i++) {
      const wordEl = el("span", "word");
      decorateSpeed(wordEl, engine.words[i]!.text);
      wordsEl.append(wordEl, document.createTextNode(" "));
      wordEls.push(wordEl);
      renderWord(i);
    }
    scrollToActive();
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
    const stat = stats[word.text];
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
    const stat = stats[word.text];
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
        const st = stats[word.text];
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
    // WPM = (caractères / 5) / minutes  →  caractères = WPM * 5 * minutes
    let remaining = (paceWpm * 5 * elapsed) / 60000;

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

  function startPaceLoop(): void {
    cancelAnimationFrame(paceRaf);
    const loop = () => {
      updatePaceCaret();
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
    const wpm = engine.liveWpm(performance.now());
    const acc = engine.liveAccuracy();
    liveStats.innerHTML =
      `<span>${fmt(wpm)} wpm</span>` +
      `<span class="dim">${fmt(acc * 100)} %</span>` +
      `<span class="dim">${engine.index}/${engine.words.length}</span>`;
  }

  function finish(): void {
    window.clearInterval(liveTimer);
    cancelAnimationFrame(paceRaf);
    paceCaret.hidden = true;
    const result = engine.result();
    applyResult(result, engine.bigrams);
    logTest(true);
    testScreen.hidden = true;
    resultScreen.hidden = false;
    renderResults(resultScreen, result, {
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
    });
  }

  function handleChar(ch: string): void {
    const prevIndex = engine.index;
    const ev = engine.typeChar(ch, performance.now());
    if (ev === "ignore") return;
    renderWord(prevIndex);
    if (engine.index !== prevIndex && !engine.finished) {
      renderWord(engine.index);
      scrollToActive();
    }
    updateLive();
    if (ev === "finish") finish();
  }

  function handleBackspace(): void {
    const prevIndex = engine.index;
    if (engine.backspace() === "ignore") return;
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
      if (engine.backspace() === "ignore") break;
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
    cancelAnimationFrame(paceRaf);
    flushPartial(); // changement d'onglet (Stats/Réglages) en plein test
  });

  newTest();
}
