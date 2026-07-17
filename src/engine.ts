import type {
  BigramStat,
  Keystroke,
  LangId,
  TestAgg,
  TestMode,
  TestResult,
  TestWord,
  WordAttempt,
  WordResult,
} from "./types";

const MAX_EXTRA = 8; // caractères en trop autorisés par mot
const BIGRAM_MAX_GAP = 2000; // au-delà, on considère une pause, pas une transition
const HES_MIN_MS = 300; // en-deçà, un gap n'est pas une vraie hésitation
/** Au-delà, on considère que l'utilisateur s'est arrêté (parti, distrait) : le
 * test est faussé et sera écarté des stats. */
export const IDLE_ABANDON_MS = 10000;

export type EngineEvent = "update" | "finish" | "ignore";

/** Mot fourni au moteur : simple texte, ou texte à taper + mot nu (clé des stats). */
export type WordInput = string | { text: string; base: string };

function toWord(input: WordInput): TestWord {
  const text = typeof input === "string" ? input : input.text;
  const base = typeof input === "string" ? undefined : input.base;
  return { text, base, typed: "", states: [], errors: 0, posWrong: [], bks: 0 };
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

function stddev(xs: number[]): number {
  if (xs.length === 0) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
  return Math.sqrt(v);
}

export class TestEngine {
  readonly words: TestWord[];
  index = 0;
  startedAt: number | null = null;
  finishedAt: number | null = null;
  keystrokes: Keystroke[] = [];
  bigrams = new Map<string, BigramStat>();
  /** Plus long temps d'inactivité (ms) entre deux actions au clavier pendant le
   * test : au-delà de {@link IDLE_ABANDON_MS}, le test est réputé abandonné. */
  maxIdleMs = 0;
  private lastActMs: number | null = null; // dernière action clavier (frappe, espace, retour arrière)
  private lastKeyMs: number | null = null; // dernière frappe correcte dans le mot courant

  readonly lang: LangId;
  readonly mode: TestMode;

  // --- collecte fine (agrégats par test) ---
  private errorTs: number[] = []; // instants (s) des frappes fausses
  private eSub = 0;
  private eTrans = 0;
  private eOmis = 0;
  private eIns = 0;
  private bksMs = 0; // temps cumulé passé en retour arrière
  private bksRunStart: number | null = null; // début du run de retour arrière courant
  private firstBadPos: number | null = null; // position de la 1re faute non corrigée du mot
  private noticeSum = 0;
  private noticeN = 0;

  constructor(words: WordInput[], lang: LangId, mode: TestMode) {
    this.lang = lang;
    this.mode = mode;
    this.words = words.map(toWord);
  }

  /** Ajoute des mots en fin de liste (flux infini du mode durée). */
  appendWords(inputs: WordInput[]): void {
    for (const inp of inputs) this.words.push(toWord(inp));
  }

  get finished(): boolean {
    return this.finishedAt !== null;
  }

  get current(): TestWord {
    const w = this.words[this.index];
    if (!w) throw new Error("index de mot invalide");
    return w;
  }

  /** Progression 0..1 basée sur les mots passés */
  get progress(): number {
    return this.words.length > 0 ? this.index / this.words.length : 0;
  }

  /** true si une pause d'au moins {@link IDLE_ABANDON_MS} a eu lieu (test faussé). */
  get abandonedByPause(): boolean {
    return this.maxIdleMs >= IDLE_ABANDON_MS;
  }

  /**
   * Note l'instant d'une action clavier et met à jour {@link maxIdleMs}. Ignoré
   * tant que le test n'a pas démarré (l'attente avant la 1re frappe n'est pas une
   * pause). Chaque frappe, espace et retour arrière effectifs l'appellent.
   */
  private mark(now: number): void {
    if (this.startedAt === null) return;
    if (this.lastActMs !== null) {
      const gap = now - this.lastActMs;
      if (gap > this.maxIdleMs) this.maxIdleMs = gap;
    }
    this.lastActMs = now;
  }

  /** Ferme un éventuel run de retour arrière en cours (comptabilise son temps). */
  private closeBksRun(now: number): void {
    if (this.bksRunStart !== null) {
      this.bksMs += now - this.bksRunStart;
      this.bksRunStart = null;
    }
  }

  typeChar(ch: string, now: number): EngineEvent {
    if (this.finished) return "ignore";
    if (ch === " ") return this.space(now);
    if (ch.length !== 1 || ch === "\n" || ch === "\t") return "ignore";

    if (this.startedAt === null) this.startedAt = now;
    this.mark(now);
    this.closeBksRun(now);
    const word = this.current;
    if (word.startMs === undefined) word.startMs = now;

    const pos = word.typed.length;
    if (pos >= word.text.length + MAX_EXTRA) return "ignore";

    // latence de départ de mot : délai espace → première lettre
    if (pos === 0 && this.lastKeyMs !== null && word.startGapMs === undefined) {
      const gap = now - this.lastKeyMs;
      if (gap > 0 && gap <= BIGRAM_MAX_GAP) word.startGapMs = gap;
    }

    let correct: boolean;
    if (pos < word.text.length) {
      const expected = word.text[pos] as string;
      correct = ch === expected;
      word.states[pos] = correct ? "correct" : "incorrect";
      if (!correct) {
        word.posWrong[pos] = true;
        this.classifyError(word, pos, ch);
        if (this.firstBadPos === null) this.firstBadPos = pos;
      }
      this.recordBigram(word, pos, correct, now);
    } else {
      correct = false;
      word.states[pos] = "extra";
      this.eIns += 1;
      if (this.firstBadPos === null) this.firstBadPos = pos;
    }
    if (!correct) {
      word.errors += 1;
      this.errorTs.push((now - this.startedAt) / 1000);
    }
    word.typed += ch;
    this.keystrokes.push({ t: now - this.startedAt, correct });
    this.lastKeyMs = correct ? now : null;

    // dernier mot tapé en entier → fin du test
    if (this.index === this.words.length - 1 && word.typed === word.text) {
      word.endMs = now;
      this.finishedAt = now;
      return "finish";
    }
    return "update";
  }

  /**
   * Classe une frappe fausse (à l'intérieur du mot) : transposition (deux lettres
   * voisines interverties), omission (on a tapé la lettre suivante en sautant
   * celle attendue), sinon substitution. Heuristiques en ligne, forcément
   * imparfaites, mais suffisantes pour un profil d'erreurs agrégé.
   */
  private classifyError(word: TestWord, pos: number, ch: string): void {
    const text = word.text;
    if (
      pos > 0 &&
      word.states[pos - 1] === "incorrect" &&
      word.typed[pos - 1] === text[pos] &&
      ch === text[pos - 1]
    ) {
      this.eTrans += 1;
      this.eSub = Math.max(0, this.eSub - 1); // la 1re lettre avait été comptée en substitution
      return;
    }
    if (pos + 1 < text.length && ch === text[pos + 1]) {
      this.eOmis += 1;
      return;
    }
    this.eSub += 1;
  }

  private recordBigram(
    word: TestWord,
    pos: number,
    correct: boolean,
    now: number
  ): void {
    let key: string;
    if (pos === 0) {
      // transition espace → première lettre du mot (départ de mot) ; on ignore
      // le tout premier mot du test, qui n'est précédé d'aucune espace
      if (this.index === 0) return;
      key = " " + (word.text[0] as string);
    } else {
      if (word.states[pos - 1] !== "correct") return;
      key = (word.text[pos - 1] as string) + (word.text[pos] as string);
    }
    const b = this.bigrams.get(key) ?? { count: 0, gapMs: 0, errors: 0 };
    if (correct) {
      if (this.lastKeyMs !== null) {
        const gap = now - this.lastKeyMs;
        if (gap > 0 && gap <= BIGRAM_MAX_GAP) {
          b.count += 1;
          b.gapMs += gap;
        }
      }
    } else {
      b.errors += 1;
    }
    this.bigrams.set(key, b);
  }

  private space(now: number): EngineEvent {
    if (this.finished || this.startedAt === null) return "ignore";
    this.mark(now);
    this.closeBksRun(now);
    const word = this.current;
    if (word.typed.length === 0) return "ignore";

    word.endMs = now;
    const correct = word.typed === word.text;
    this.keystrokes.push({ t: now - this.startedAt, correct });
    // fin de mot : bigramme « dernière lettre → espace ». On ne le mesure que si
    // la dernière frappe était correcte (lastKeyMs pointe alors sur cette lettre).
    if (this.lastKeyMs !== null) {
      const pos = word.typed.length - 1;
      const ch = word.text[pos] as string;
      const key = ch + " ";
      const b = this.bigrams.get(key) ?? { count: 0, gapMs: 0, errors: 0 };
      const gap = now - this.lastKeyMs;
      if (gap > 0 && gap <= BIGRAM_MAX_GAP) {
        b.count += 1;
        b.gapMs += gap;
      }
      this.bigrams.set(key, b);
    }
    // on garde l'instant de l'espace comme référence pour chronométrer la
    // première frappe du mot suivant (bigramme « espace → lettre »)
    this.lastKeyMs = now;
    this.firstBadPos = null; // nouveau mot : plus de faute « en attente »
    this.index += 1;
    if (this.index >= this.words.length) {
      this.finishedAt = now;
      return "finish";
    }
    return "update";
  }

  backspace(now: number): EngineEvent {
    if (this.finished) return "ignore";
    this.mark(now);
    const word = this.current;
    // ouvre (ou prolonge) un run de retour arrière, et note la distance de
    // détection : combien de lettres tapées après la 1re faute avant de revenir
    if (this.bksRunStart === null) {
      this.bksRunStart = now;
      if (this.firstBadPos !== null && word.typed.length > 0) {
        this.noticeSum += Math.max(0, word.typed.length - 1 - this.firstBadPos);
        this.noticeN += 1;
      }
    }
    if (word.typed.length === 0) {
      // retour sur le mot précédent seulement s'il n'était pas parfait
      const prev = this.words[this.index - 1];
      if (prev && prev.typed !== prev.text) {
        this.index -= 1;
        prev.endMs = undefined;
        this.lastKeyMs = null;
        return "update";
      }
      return "ignore";
    }
    word.typed = word.typed.slice(0, -1);
    word.states.pop();
    word.bks += 1;
    this.lastKeyMs = null;
    if (this.firstBadPos !== null && word.typed.length <= this.firstBadPos) {
      this.firstBadPos = null; // on a effacé jusqu'à (ou avant) la faute
    }
    return "update";
  }

  /** Termine le test à `now` (mode durée : le mot en cours reste incomplet). */
  forceFinish(now: number): void {
    if (this.finished || this.startedAt === null) return;
    this.closeBksRun(now);
    this.finishedAt = now;
  }

  result(): TestResult {
    if (this.startedAt === null || this.finishedAt === null) {
      throw new Error("test non terminé");
    }
    const durationMs = Math.max(1, this.finishedAt - this.startedAt);
    const minutes = durationMs / 60000;

    let correctChars = 0;
    const wordResults: WordResult[] = [];
    for (let i = 0; i < this.words.length; i++) {
      const w = this.words[i] as TestWord;
      if (w.typed.length === 0 && w.endMs === undefined) continue; // mot jamais atteint
      const base = w.base ?? w.text;
      const complete = w.typed.length >= w.text.length;
      const correct = w.typed === w.text;
      if (correct) {
        correctChars += w.text.length + (i < this.words.length - 1 ? 1 : 0);
      }
      const missed = Math.max(0, w.text.length - w.typed.length);
      const timeMs =
        complete && w.startMs !== undefined && w.endMs !== undefined
          ? w.endMs - w.startMs
          : null;
      const posErrors: number[] = [];
      for (let p = 0; p < base.length; p++) {
        posErrors.push(w.posWrong[p] ? 1 : 0);
      }
      wordResults.push({
        text: base,
        timeMs,
        errors: w.errors + missed,
        correct,
        posErrors,
      });
    }

    const total = this.keystrokes.length;
    const correctKeys = this.keystrokes.filter((k) => k.correct).length;

    return {
      date: Date.now(),
      lang: this.lang,
      mode: this.mode,
      wordCount: this.words.length,
      durationMs,
      wpm: correctChars / 5 / minutes,
      rawWpm: total / 5 / minutes,
      accuracy: total > 0 ? correctKeys / total : 1,
      words: wordResults,
      wpmSeries: this.buildWpmSeries(durationMs),
      errorTimes: [...this.errorTs],
    };
  }

  /**
   * Attempts de tous les mots atteints, que le test soit terminé ou abandonné.
   * Un mot « validé » (endMs défini : espace pressé ou dernier mot complété) suit
   * la même logique d'erreurs que result() ; le mot courant abandonné en cours ne
   * compte que ses frappes fausses réelles (pas les lettres non tapées).
   */
  wordAttempts(): WordAttempt[] {
    const out: WordAttempt[] = [];
    const upto = this.finished ? this.words.length : this.index + 1;
    for (let i = 0; i < upto && i < this.words.length; i++) {
      const w = this.words[i] as TestWord;
      const committed = w.endMs !== undefined;
      const reached = committed || w.typed.length > 0;
      if (!reached) continue;
      const base = w.base ?? w.text;
      const complete = w.typed.length >= w.text.length;
      const missed = committed ? Math.max(0, w.text.length - w.typed.length) : 0;
      const timeMs =
        committed && complete && w.startMs !== undefined
          ? (w.endMs as number) - w.startMs
          : null;
      out.push({
        text: base,
        index: i,
        len: base.length,
        timeMs,
        errors: w.errors + missed,
        correct: w.typed === w.text,
        startGapMs: w.startGapMs,
        line: w.line,
        paceD: w.paceD,
        bks: w.bks,
      });
    }
    return out;
  }

  /** Agrégats fins côté moteur (dwell/roll sont renseignés par la vue). */
  aggregates(): TestAgg {
    const ts = this.keystrokes.map((k) => k.t).sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let i = 1; i < ts.length; i++) gaps.push((ts[i] as number) - (ts[i - 1] as number));
    const gapMed = median(gaps);
    const thresh = Math.max(HES_MIN_MS, gapMed * 2);
    const hes = gaps.filter((g) => g > thresh).length;
    return {
      gapMed,
      gapSd: stddev(gaps),
      hes,
      dwellAvg: 0,
      roll: 0,
      eSub: this.eSub,
      eTrans: this.eTrans,
      eOmis: this.eOmis,
      eIns: this.eIns,
      bksMs: this.bksMs,
      notice: this.noticeN > 0 ? this.noticeSum / this.noticeN : 0,
    };
  }

  /** WPM net cumulé, échantillonné à chaque seconde du test */
  private buildWpmSeries(durationMs: number): { t: number; wpm: number }[] {
    const seconds = Math.max(1, Math.ceil(durationMs / 1000));
    const series: { t: number; wpm: number }[] = [];
    let ki = 0;
    let correctSoFar = 0;
    const sorted = [...this.keystrokes].sort((a, b) => a.t - b.t);
    for (let s = 1; s <= seconds; s++) {
      const limit = Math.min(s * 1000, durationMs);
      while (ki < sorted.length && (sorted[ki] as Keystroke).t <= limit) {
        if ((sorted[ki] as Keystroke).correct) correctSoFar += 1;
        ki++;
      }
      series.push({ t: limit / 1000, wpm: correctSoFar / 5 / (limit / 60000) });
    }
    return series;
  }

  /** WPM net "live" pendant le test */
  liveWpm(now: number): number {
    if (this.startedAt === null) return 0;
    const minutes = Math.max(0.5 / 60, (now - this.startedAt) / 60000);
    const correctKeys = this.keystrokes.filter((k) => k.correct).length;
    return correctKeys / 5 / minutes;
  }

  liveAccuracy(): number {
    const total = this.keystrokes.length;
    if (total === 0) return 1;
    return this.keystrokes.filter((k) => k.correct).length / total;
  }
}
