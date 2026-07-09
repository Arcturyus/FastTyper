import { TestEngine } from "../engine";
import { loadConfig, saveConfig } from "../config";
import {
  appendTestLog,
  applyResult,
  loadWordStats,
  recentAvgWpm,
  wordPosErrorRates,
} from "../store";
import { generatePractice, generateWords, LANGS } from "../wordlist";
import type { Config, LangId, TestMode, TestWord, WordStat } from "../types";

// seuils du marqueur « couture » entre deux lettres en mode entraînement
const SEAM_FLOOR = 0.12; // en dessous de ce taux d'erreur, on n'affiche rien
const SEAM_FULL = 0.5; // à ce taux, intensité maximale
import { el, fmt, toast, wordClasses } from "./common";
import { renderResults } from "./results-view";

const WORD_COUNTS = [10, 25, 50];

export function mountTestView(root: HTMLElement, signal: AbortSignal): void {
  let cfg = loadConfig();
  let mode: TestMode = "normal";
  let engine: TestEngine;
  let stats: Record<string, WordStat> = {};
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
  const practiceLegend = el("div", "practice-legend");
  practiceLegend.innerHTML =
    '<span class="seam-swatch"></span> zone rouge entre deux lettres = ' +
    "endroit où tu te trompes le plus (plus c'est vif, plus tu rates)";
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
  testScreen.append(controls, liveStats, wordsWrap, practiceLegend, footer, input);
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
    const paceLabel =
      paceWpm !== null ? `⏱ Rythme ${fmt(paceWpm)}` : "⏱ Rythme";
    const paceBtn = el("button", "chip-btn", paceLabel);
    if (cfg.paceCaret) paceBtn.classList.add("on");
    paceBtn.title =
      paceWpm !== null
        ? `Curseur fantôme avançant à ta moyenne des ${cfg.paceAvgCount} derniers tests (${fmt(paceWpm)} wpm)`
        : "Curseur fantôme à ta vitesse moyenne — fais d'abord quelques tests dans cette langue";
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
    engine = new TestEngine(buildWordList(), cfg.lang, mode);
    logged = false;
    paceWpm = recentAvgWpm(cfg.lang, cfg.paceAvgCount);
    resultScreen.hidden = true;
    testScreen.hidden = false;
    renderControls();
    renderFooter();
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
      for (const c of wordClasses(stats[engine.words[i]!.text], cfg)) {
        wordEl.classList.add(c);
      }
      wordsEl.append(wordEl, document.createTextNode(" "));
      wordEls.push(wordEl);
      renderWord(i);
    }
    scrollToActive();
  }

  /** Intensités 0..1 des coutures d'erreur par position (mode entraînement) */
  function seamIntensities(word: TestWord): number[] | null {
    if (mode !== "practice") return null;
    const stat = stats[word.text];
    if (!stat || stat.attempts < 2) return null;
    const rates = wordPosErrorRates(stat, word.text.length);
    return rates.map((r) =>
      r < SEAM_FLOOR ? 0 : Math.min(1, r / SEAM_FULL)
    );
  }

  function renderWord(i: number): void {
    const word = engine.words[i];
    const node = wordEls[i];
    if (!word || !node) return;
    node.innerHTML = "";
    const isActive = i === engine.index && !engine.finished;
    const len = Math.max(word.text.length, word.typed.length);
    const seams = seamIntensities(word);
    for (let p = 0; p < len; p++) {
      const expected = word.text[p];
      const state = word.states[p];
      const letter = el("span", "letter", expected ?? word.typed[p] ?? "");
      if (p < word.typed.length && state) letter.classList.add(state);
      if (isActive && p === word.typed.length) letter.classList.add("caret");
      // couture d'erreur à la transition entrant dans la lettre p
      const intensity = seams?.[p] ?? 0;
      if (intensity > 0) {
        letter.classList.add("seam");
        letter.style.setProperty("--seam-i", intensity.toFixed(3));
        const st = stats[word.text];
        const pct = Math.round(
          ((st?.posErrors?.[p] ?? 0) / Math.max(1, st?.attempts ?? 1)) * 100
        );
        letter.title = `${pct} % d'erreurs à cet endroit`;
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
