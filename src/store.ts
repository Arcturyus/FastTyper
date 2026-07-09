import type {
  BigramStat,
  HistoryEntry,
  LangId,
  TestLog,
  TestResult,
  WordStat,
} from "./types";

const wordsKey = (lang: LangId) => `ft:words:${lang}`;
const bigramsKey = (lang: LangId) => `ft:bigrams:${lang}`;
const testLogKey = (lang: LangId) => `ft:testlog:${lang}`;
const HISTORY_KEY = "ft:history";
const HISTORY_MAX = 500;
const TESTLOG_MAX = 1500; // tests bruts conservés par langue (terminés + abandonnés)

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function loadWordStats(lang: LangId): Record<string, WordStat> {
  return read(wordsKey(lang), {});
}

export function loadBigramStats(lang: LangId): Record<string, BigramStat> {
  return read(bigramsKey(lang), {});
}

export function loadHistory(): HistoryEntry[] {
  return read(HISTORY_KEY, []);
}

export function loadTestLog(lang: LangId): TestLog[] {
  return read(testLogKey(lang), []);
}

/** Ajoute un test au journal brut (terminé ou abandonné), avec plafond. */
export function appendTestLog(entry: TestLog): void {
  if (entry.words.length === 0) return;
  const log = loadTestLog(entry.lang);
  log.push(entry);
  localStorage.setItem(
    testLogKey(entry.lang),
    JSON.stringify(log.slice(-TESTLOG_MAX))
  );
}

/** WPM moyen sur les n derniers tests de cette langue, ou null si aucun */
export function recentAvgWpm(lang: LangId, n: number): number | null {
  const entries = loadHistory()
    .filter((h) => h.lang === lang)
    .slice(-Math.max(1, n));
  if (entries.length === 0) return null;
  return entries.reduce((sum, h) => sum + h.wpm, 0) / entries.length;
}

/** WPM moyen d'un mot, ou null si aucun essai chronométré */
export function wordAvgWpm(s: WordStat): number | null {
  if (s.timedAttempts === 0 || s.timeMs <= 0) return null;
  return (s.timedChars / 5) / (s.timeMs / 60000);
}

/** Part des essais comportant au moins une erreur (0..1) */
export function wordErrRate(s: WordStat): number {
  return s.attempts > 0 ? s.errorAttempts / s.attempts : 0;
}

/** Temps moyen entre les deux frappes d'un bigramme (ms) */
export function bigramAvgGap(b: BigramStat): number | null {
  return b.count > 0 ? b.gapMs / b.count : null;
}

/**
 * Taux d'erreur (0..1) à chaque position du mot : posErrors[p] / attempts.
 * La position p correspond à la transition « entre la lettre p-1 et la lettre p ».
 */
export function wordPosErrorRates(s: WordStat, wordLen: number): number[] {
  const arr = s.posErrors ?? []; // tolère les anciennes données sans posErrors
  const rates: number[] = [];
  for (let p = 0; p < wordLen; p++) {
    const errs = arr[p] ?? 0;
    rates.push(s.attempts > 0 ? errs / s.attempts : 0);
  }
  return rates;
}

/** Intègre un résultat de test dans les stats persistées */
export function applyResult(
  result: TestResult,
  bigrams: Map<string, BigramStat>
): void {
  const stats = loadWordStats(result.lang);
  for (const w of result.words) {
    const s: WordStat = stats[w.text] ?? {
      attempts: 0,
      errors: 0,
      errorAttempts: 0,
      posErrors: [],
      timeMs: 0,
      timedChars: 0,
      timedAttempts: 0,
      last: 0,
    };
    if (!s.posErrors) s.posErrors = []; // migration des anciennes données
    s.attempts += 1;
    s.errors += w.errors;
    if (w.errors > 0) s.errorAttempts += 1;
    for (let p = 0; p < w.posErrors.length; p++) {
      s.posErrors[p] = (s.posErrors[p] ?? 0) + (w.posErrors[p] ?? 0);
    }
    if (w.timeMs !== null && w.timeMs > 0) {
      s.timeMs += w.timeMs;
      s.timedChars += w.text.length;
      s.timedAttempts += 1;
    }
    s.last = result.date;
    stats[w.text] = s;
  }
  localStorage.setItem(wordsKey(result.lang), JSON.stringify(stats));

  const bg = loadBigramStats(result.lang);
  for (const [key, b] of bigrams) {
    const cur = bg[key] ?? { count: 0, gapMs: 0, errors: 0 };
    cur.count += b.count;
    cur.gapMs += b.gapMs;
    cur.errors += b.errors;
    bg[key] = cur;
  }
  localStorage.setItem(bigramsKey(result.lang), JSON.stringify(bg));

  const history = loadHistory();
  history.push({
    date: result.date,
    lang: result.lang,
    mode: result.mode,
    wordCount: result.wordCount,
    durationMs: result.durationMs,
    wpm: result.wpm,
    accuracy: result.accuracy,
  });
  localStorage.setItem(
    HISTORY_KEY,
    JSON.stringify(history.slice(-HISTORY_MAX))
  );
}

const ALL_LANGS: LangId[] = ["fr", "fr1k", "en", "en1k"];

export function exportData(): string {
  const data: Record<string, unknown> = {
    version: 1,
    config: read("ft:config", null),
    history: loadHistory(),
  };
  for (const lang of ALL_LANGS) {
    data[`words:${lang}`] = loadWordStats(lang);
    data[`bigrams:${lang}`] = loadBigramStats(lang);
    data[`testlog:${lang}`] = loadTestLog(lang);
  }
  return JSON.stringify(data, null, 2);
}

export function importData(json: string): void {
  const data = JSON.parse(json) as Record<string, unknown>;
  if (typeof data !== "object" || data === null || data["version"] !== 1) {
    throw new Error("Format de fichier non reconnu");
  }
  if (data["config"]) {
    localStorage.setItem("ft:config", JSON.stringify(data["config"]));
  }
  if (Array.isArray(data["history"])) {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(data["history"]));
  }
  for (const lang of ALL_LANGS) {
    if (data[`words:${lang}`]) {
      localStorage.setItem(wordsKey(lang), JSON.stringify(data[`words:${lang}`]));
    }
    if (data[`bigrams:${lang}`]) {
      localStorage.setItem(
        bigramsKey(lang),
        JSON.stringify(data[`bigrams:${lang}`])
      );
    }
    if (data[`testlog:${lang}`]) {
      localStorage.setItem(
        testLogKey(lang),
        JSON.stringify(data[`testlog:${lang}`])
      );
    }
  }
}

export function resetData(): void {
  const keys: string[] = [HISTORY_KEY];
  for (const lang of ALL_LANGS) {
    keys.push(wordsKey(lang), bigramsKey(lang), testLogKey(lang));
  }
  for (const k of keys) localStorage.removeItem(k);
}
