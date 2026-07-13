import type {
  BigramStat,
  HistoryEntry,
  LangId,
  TestLog,
  TestMode,
  TestResult,
  WordStat,
} from "./types";
import { ALL_FAMILIES, FAMILY_OF, type LangFamily } from "./lang";

// les clés de stockage sont partagées par famille (fr/fr1k → "fr", en/en1k → "en") :
// un mot pratiqué dans un pool profite immédiatement à l'autre taille de pool.
const wordsKey = (lang: LangId) => `ft:words:${FAMILY_OF[lang]}`;
const bigramsKey = (lang: LangId) => `ft:bigrams:${FAMILY_OF[lang]}`;
const testLogKey = (lang: LangId) => `ft:testlog:${FAMILY_OF[lang]}`;
const HISTORY_KEY = "ft:history";
const HISTORY_MAX = 500;
const TESTLOG_MAX = 1500; // tests bruts conservés par famille (terminés + abandonnés)

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
//  Migration ponctuelle : avant la fusion par famille, les données étaient
//  cloisonnées par variante de pool (fr/fr1k/en/en1k). On replie la variante
//  « secondaire » (fr1k, en1k) dans le panier de la famille (dont la clé
//  coïncide avec la variante « primaire », fr/en) puis on supprime l'ancienne
//  clé. Exécuté une seule fois au chargement du module.
// ---------------------------------------------------------------------------
const STORAGE_VERSION_KEY = "ft:storageVersion";
const SECONDARY_VARIANT: Record<LangFamily, LangId> = { fr: "fr1k", en: "en1k" };

function mergeWordStat(a: WordStat, b: WordStat): WordStat {
  const len = Math.max(a.posErrors?.length ?? 0, b.posErrors?.length ?? 0);
  const posErrors: number[] = [];
  for (let p = 0; p < len; p++) posErrors[p] = (a.posErrors?.[p] ?? 0) + (b.posErrors?.[p] ?? 0);
  return {
    attempts: a.attempts + b.attempts,
    errors: a.errors + b.errors,
    errorAttempts: a.errorAttempts + b.errorAttempts,
    posErrors,
    timeMs: a.timeMs + b.timeMs,
    timedChars: a.timedChars + b.timedChars,
    timedAttempts: a.timedAttempts + b.timedAttempts,
    last: Math.max(a.last, b.last),
  };
}

function mergeWordStatsRecords(
  a: Record<string, WordStat>,
  b: Record<string, WordStat>
): Record<string, WordStat> {
  const out: Record<string, WordStat> = { ...a };
  for (const [word, s] of Object.entries(b)) {
    out[word] = out[word] ? mergeWordStat(out[word]!, s) : s;
  }
  return out;
}

function mergeBigramStat(a: BigramStat, b: BigramStat): BigramStat {
  return { count: a.count + b.count, gapMs: a.gapMs + b.gapMs, errors: a.errors + b.errors };
}

function mergeBigramStatsRecords(
  a: Record<string, BigramStat>,
  b: Record<string, BigramStat>
): Record<string, BigramStat> {
  const out: Record<string, BigramStat> = { ...a };
  for (const [key, s] of Object.entries(b)) {
    out[key] = out[key] ? mergeBigramStat(out[key]!, s) : s;
  }
  return out;
}

function mergeLegacyBucket<T>(
  legacyKey: string,
  targetKey: string,
  merge: (a: T, b: T) => T,
  empty: T
): void {
  const raw = localStorage.getItem(legacyKey);
  if (!raw) return;
  try {
    const legacy = JSON.parse(raw) as T;
    const current = read(targetKey, empty);
    localStorage.setItem(targetKey, JSON.stringify(merge(current, legacy)));
  } catch {
    // données corrompues : on abandonne la fusion mais on nettoie quand même la clé
  }
  localStorage.removeItem(legacyKey);
}

function migrateToFamilyStorage(): void {
  if (localStorage.getItem(STORAGE_VERSION_KEY) === "2") return;
  for (const family of ALL_FAMILIES) {
    const secondary = SECONDARY_VARIANT[family];
    mergeLegacyBucket(`ft:words:${secondary}`, wordsKey(family), mergeWordStatsRecords, {});
    mergeLegacyBucket(`ft:bigrams:${secondary}`, bigramsKey(family), mergeBigramStatsRecords, {});
    mergeLegacyBucket<TestLog[]>(
      `ft:testlog:${secondary}`,
      testLogKey(family),
      (a, b) => [...a, ...b].sort((x, y) => x.date - y.date).slice(-TESTLOG_MAX),
      []
    );
  }
  localStorage.setItem(STORAGE_VERSION_KEY, "2");
}

migrateToFamilyStorage();

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

/** Médiane d'une liste (copie triée), ou null si vide. */
export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

/** WPM moyen sur les n derniers tests de cette langue, ou null si aucun */
export function recentAvgWpm(lang: LangId, n: number): number | null {
  const entries = loadHistory()
    .filter((h) => h.lang === lang)
    .slice(-Math.max(1, n));
  if (entries.length === 0) return null;
  return entries.reduce((sum, h) => sum + h.wpm, 0) / entries.length;
}

/**
 * Cible du curseur de rythme : WPM MÉDIAN sur les n derniers tests de cette
 * langue ET de ce mode. La médiane résiste aux tests aberrants (une hésitation
 * ou un abandon ne fausse pas la cible). En entraînement, on ne compare qu'aux
 * entraînements ; en normal, qu'aux tests normaux.
 */
export function paceTargetWpm(lang: LangId, n: number, mode: TestMode): number | null {
  const wpms = loadHistory()
    .filter((h) => h.lang === lang && h.mode === mode)
    .slice(-Math.max(1, n))
    .map((h) => h.wpm);
  return median(wpms);
}

/** WPM moyen d'un mot, ou null si aucun essai chronométré */
export function wordAvgWpm(s: WordStat): number | null {
  if (s.timedAttempts === 0 || s.timeMs <= 0) return null;
  return (s.timedChars / 5) / (s.timeMs / 60000);
}

/** Un mot avec sa famille de langue d'origine (fr/fr1k et en/en1k sont fusionnés). */
export type TaggedWord = { family: LangFamily; word: string; stat: WordStat };

/** Charge les stats de mots de plusieurs familles de langue (une par famille, sans doublon). */
export function loadWordStatsTagged(families: LangFamily[]): TaggedWord[] {
  const out: TaggedWord[] = [];
  for (const family of families) {
    const stats = loadWordStats(family);
    for (const [word, stat] of Object.entries(stats)) {
      out.push({ family, word, stat });
    }
  }
  return out;
}

/** Fusionne les stats de bigrammes de plusieurs familles de langue (clé = transition). */
export function loadBigramStatsMerged(families: LangFamily[]): Record<string, BigramStat> {
  let merged: Record<string, BigramStat> = {};
  for (const family of families) {
    merged = mergeBigramStatsRecords(merged, loadBigramStats(family));
  }
  return merged;
}

/** Concatène les journaux bruts de plusieurs familles de langue. */
export function loadTestLogMulti(families: LangFamily[]): TestLog[] {
  const out: TestLog[] = [];
  for (const family of families) out.push(...loadTestLog(family));
  return out;
}

/**
 * Vitesse d'un mot ventilée selon l'issue de l'essai : réussi (tapé juste) vs
 * fauté (tapé en entier mais avec au moins une erreur). Reconstruit depuis le
 * journal brut, donc rétroactif sur les données existantes. Fusionné par
 * famille de langue (fr/fr1k, en/en1k).
 */
export type OutcomeSpeed = {
  family: LangFamily;
  word: string;
  okChars: number;
  okMs: number;
  okN: number; // essais réussis chronométrés
  badChars: number;
  badMs: number;
  badN: number; // essais fautés mais complets, chronométrés
};

const outcomeKey = (family: LangFamily, word: string) => `${family} ${word}`;

/** Agrège, par (famille, mot), la vitesse en réussite vs en échec. */
export function wordOutcomeSpeeds(logs: TestLog[]): Map<string, OutcomeSpeed> {
  const map = new Map<string, OutcomeSpeed>();
  for (const t of logs) {
    const family = FAMILY_OF[t.lang];
    for (const w of t.words) {
      if (w.timeMs === null || w.timeMs <= 0) continue; // uniquement les mots chronométrés
      const key = outcomeKey(family, w.text);
      let o = map.get(key);
      if (!o) {
        o = { family, word: w.text, okChars: 0, okMs: 0, okN: 0, badChars: 0, badMs: 0, badN: 0 };
        map.set(key, o);
      }
      if (w.correct) {
        o.okChars += w.len;
        o.okMs += w.timeMs;
        o.okN += 1;
      } else {
        o.badChars += w.len;
        o.badMs += w.timeMs;
        o.badN += 1;
      }
    }
  }
  return map;
}

/** WPM sur les essais réussis, ou null si aucun. */
export function okWpm(o: OutcomeSpeed): number | null {
  return o.okN > 0 && o.okMs > 0 ? o.okChars / 5 / (o.okMs / 60000) : null;
}

/** WPM sur les essais fautés (mais complets), ou null si aucun. */
export function badWpm(o: OutcomeSpeed): number | null {
  return o.badN > 0 && o.badMs > 0 ? o.badChars / 5 / (o.badMs / 60000) : null;
}

/**
 * Vitesse « hors erreur » (WPM sur essais réussis) par mot pour une langue,
 * reconstruite depuis le journal brut. Sert au surlignage : la couleur reflète
 * la vitesse pure du mot, l'erreur étant déjà signalée par le soulignage.
 */
export function okWpmByWord(lang: LangId): Map<string, number> {
  const map = new Map<string, number>();
  for (const o of wordOutcomeSpeeds(loadTestLog(lang)).values()) {
    const w = okWpm(o);
    if (w !== null) map.set(o.word, w);
  }
  return map;
}

/**
 * Vitesse MÉDIANE hors erreur par mot, reconstruite depuis le journal brut.
 * Contrairement à {@link okWpmByWord} (qui est un rapport de sommes, donc une
 * moyenne pondérée), on garde ici chaque essai réussi comme un échantillon et on
 * en prend la médiane : un mot ponctuellement tapé très lentement (hésitation)
 * ne teinte plus tout le mot en « lent ».
 */
export function okWpmMedianByWord(lang: LangId): Map<string, number> {
  const samples = new Map<string, number[]>();
  for (const t of loadTestLog(lang)) {
    for (const w of t.words) {
      if (w.timeMs === null || w.timeMs <= 0 || !w.correct) continue;
      const wpm = w.len / 5 / (w.timeMs / 60000);
      let arr = samples.get(w.text);
      if (!arr) samples.set(w.text, (arr = []));
      arr.push(wpm);
    }
  }
  const map = new Map<string, number>();
  for (const [word, arr] of samples) {
    const m = median(arr);
    if (m !== null) map.set(word, m);
  }
  return map;
}

/** Un essai daté d'un mot précis, reconstruit depuis le journal brut. */
export type WordTrial = {
  date: number;
  mode: TestMode;
  wpm: number | null; // null si le mot n'a pas été tapé en entier (non chronométré)
  errors: number; // frappes fausses commises sur cet essai
  faulted: boolean; // au moins une faute
};

/**
 * Reconstruit la chronologie des essais d'un mot précis (famille + texte) depuis
 * le journal brut, du plus ancien au plus récent. Sert à visualiser l'évolution
 * de la vitesse et des fautes sur ce mot, notamment au fil des entraînements.
 * Agrège les deux tailles de pool d'une même famille (fr/fr1k, en/en1k).
 */
export function wordTrials(logs: TestLog[], family: LangFamily, word: string): WordTrial[] {
  const out: WordTrial[] = [];
  for (const t of logs) {
    if (FAMILY_OF[t.lang] !== family) continue;
    for (const w of t.words) {
      if (w.text !== word) continue;
      out.push({
        date: t.date,
        mode: t.mode,
        wpm: w.timeMs !== null && w.timeMs > 0 ? w.len / 5 / (w.timeMs / 60000) : null,
        errors: w.errors,
        faulted: w.errors > 0,
      });
    }
  }
  out.sort((a, b) => a.date - b.date);
  return out;
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

export const ALL_LANGS: LangId[] = ["fr", "fr1k", "en", "en1k"];

export function exportData(): string {
  const data: Record<string, unknown> = {
    version: 2,
    config: read("ft:config", null),
    history: loadHistory(),
  };
  for (const family of ALL_FAMILIES) {
    data[`words:${family}`] = loadWordStats(family);
    data[`bigrams:${family}`] = loadBigramStats(family);
    data[`testlog:${family}`] = loadTestLog(family);
  }
  return JSON.stringify(data, null, 2);
}

export function importData(json: string): void {
  const data = JSON.parse(json) as Record<string, unknown>;
  const version = data["version"];
  if (typeof data !== "object" || data === null || (version !== 1 && version !== 2)) {
    throw new Error("Format de fichier non reconnu");
  }
  if (data["config"]) {
    localStorage.setItem("ft:config", JSON.stringify(data["config"]));
  }
  if (Array.isArray(data["history"])) {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(data["history"]));
  }

  if (version === 2) {
    for (const family of ALL_FAMILIES) {
      if (data[`words:${family}`]) {
        localStorage.setItem(wordsKey(family), JSON.stringify(data[`words:${family}`]));
      }
      if (data[`bigrams:${family}`]) {
        localStorage.setItem(bigramsKey(family), JSON.stringify(data[`bigrams:${family}`]));
      }
      if (data[`testlog:${family}`]) {
        localStorage.setItem(testLogKey(family), JSON.stringify(data[`testlog:${family}`]));
      }
    }
    return;
  }

  // version 1 (héritage) : sections par variante (fr/fr1k/en/en1k), à fusionner par famille
  for (const lang of ALL_LANGS) {
    const words = data[`words:${lang}`] as Record<string, WordStat> | undefined;
    if (words) {
      localStorage.setItem(
        wordsKey(lang),
        JSON.stringify(mergeWordStatsRecords(read(wordsKey(lang), {}), words))
      );
    }
    const bg = data[`bigrams:${lang}`] as Record<string, BigramStat> | undefined;
    if (bg) {
      localStorage.setItem(
        bigramsKey(lang),
        JSON.stringify(mergeBigramStatsRecords(read(bigramsKey(lang), {}), bg))
      );
    }
    const logs = data[`testlog:${lang}`] as TestLog[] | undefined;
    if (logs) {
      const merged = [...read<TestLog[]>(testLogKey(lang), []), ...logs]
        .sort((a, b) => a.date - b.date)
        .slice(-TESTLOG_MAX);
      localStorage.setItem(testLogKey(lang), JSON.stringify(merged));
    }
  }
}

export function resetData(): void {
  const keys: string[] = [HISTORY_KEY];
  for (const family of ALL_FAMILIES) {
    keys.push(wordsKey(family), bigramsKey(family), testLogKey(family));
  }
  for (const k of keys) localStorage.removeItem(k);
}
