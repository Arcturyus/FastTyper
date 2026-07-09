import type {
  BigramStat,
  Keystroke,
  LangId,
  TestMode,
  TestResult,
  TestWord,
  WordAttempt,
  WordResult,
} from "./types";

const MAX_EXTRA = 8; // caractères en trop autorisés par mot
const BIGRAM_MAX_GAP = 2000; // au-delà, on considère une pause, pas une transition

export type EngineEvent = "update" | "finish" | "ignore";

export class TestEngine {
  readonly words: TestWord[];
  index = 0;
  startedAt: number | null = null;
  finishedAt: number | null = null;
  keystrokes: Keystroke[] = [];
  bigrams = new Map<string, BigramStat>();
  private lastKeyMs: number | null = null; // dernière frappe correcte dans le mot courant

  readonly lang: LangId;
  readonly mode: TestMode;

  constructor(wordTexts: string[], lang: LangId, mode: TestMode) {
    this.lang = lang;
    this.mode = mode;
    this.words = wordTexts.map((text) => ({
      text,
      typed: "",
      states: [],
      errors: 0,
      posWrong: [],
    }));
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

  typeChar(ch: string, now: number): EngineEvent {
    if (this.finished) return "ignore";
    if (ch === " ") return this.space(now);
    if (ch.length !== 1 || ch === "\n" || ch === "\t") return "ignore";

    if (this.startedAt === null) this.startedAt = now;
    const word = this.current;
    if (word.startMs === undefined) word.startMs = now;

    const pos = word.typed.length;
    if (pos >= word.text.length + MAX_EXTRA) return "ignore";

    let correct: boolean;
    if (pos < word.text.length) {
      const expected = word.text[pos] as string;
      correct = ch === expected;
      word.states[pos] = correct ? "correct" : "incorrect";
      if (!correct) word.posWrong[pos] = true;
      this.recordBigram(word, pos, correct, now);
    } else {
      correct = false;
      word.states[pos] = "extra";
    }
    if (!correct) word.errors += 1;
    word.typed += ch;
    this.keystrokes.push({ t: now - this.startedAt, correct });
    this.lastKeyMs = correct ? now : null;

    // dernier mot tapé en entier → fin du test
    if (
      this.index === this.words.length - 1 &&
      word.typed === word.text
    ) {
      word.endMs = now;
      this.finishedAt = now;
      return "finish";
    }
    return "update";
  }

  private recordBigram(
    word: TestWord,
    pos: number,
    correct: boolean,
    now: number
  ): void {
    if (pos === 0) return;
    if (word.states[pos - 1] !== "correct") return;
    const key = (word.text[pos - 1] as string) + (word.text[pos] as string);
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
    const word = this.current;
    if (word.typed.length === 0) return "ignore";

    word.endMs = now;
    const correct = word.typed === word.text;
    this.keystrokes.push({ t: now - this.startedAt, correct });
    this.lastKeyMs = null;
    this.index += 1;
    if (this.index >= this.words.length) {
      this.finishedAt = now;
      return "finish";
    }
    return "update";
  }

  backspace(): EngineEvent {
    if (this.finished) return "ignore";
    const word = this.current;
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
    this.lastKeyMs = null;
    return "update";
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
      for (let p = 0; p < w.text.length; p++) {
        posErrors.push(w.posWrong[p] ? 1 : 0);
      }
      wordResults.push({
        text: w.text,
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
      const complete = w.typed.length >= w.text.length;
      const missed = committed ? Math.max(0, w.text.length - w.typed.length) : 0;
      const timeMs =
        committed && complete && w.startMs !== undefined
          ? (w.endMs as number) - w.startMs
          : null;
      out.push({
        text: w.text,
        index: i,
        len: w.text.length,
        timeMs,
        errors: w.errors + missed,
        correct: w.typed === w.text,
      });
    }
    return out;
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
