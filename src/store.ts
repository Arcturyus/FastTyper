import type {
  BigramStat,
  HistoryEntry,
  LangId,
  TestKind,
  TestLog,
  TestMode,
  TestResult,
  WordStat,
} from "./types";
import { ALL_FAMILIES, FAMILY_OF, type LangFamily } from "./lang";
import { storage } from "./db";

// les clés de stockage sont partagées par famille (fr/fr1k → "fr", en/en1k → "en") :
// un mot pratiqué dans un pool profite immédiatement à l'autre taille de pool.
const wordsKey = (lang: LangId) => `ft:words:${FAMILY_OF[lang]}`;
const bigramsKey = (lang: LangId) => `ft:bigrams:${FAMILY_OF[lang]}`;
const confusionsKey = (lang: LangId) => `ft:confusions:${FAMILY_OF[lang]}`;
const testLogKey = (lang: LangId) => `ft:testlog:${FAMILY_OF[lang]}`;
const HISTORY_KEY = "ft:history";
const HISTORY_MAX = 500;
const TESTLOG_MAX = 1500; // tests bruts conservés par famille (terminés + abandonnés)

function read<T>(key: string, fallback: T): T {
  try {
    const raw = storage.getItem(key);
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
const SECONDARY_VARIANT: Partial<Record<LangFamily, LangId>> = { fr: "fr1k", en: "en1k" };

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
  const raw = storage.getItem(legacyKey);
  if (!raw) return;
  try {
    const legacy = JSON.parse(raw) as T;
    const current = read(targetKey, empty);
    storage.setItem(targetKey, JSON.stringify(merge(current, legacy)));
  } catch {
    // données corrompues : on abandonne la fusion mais on nettoie quand même la clé
  }
  storage.removeItem(legacyKey);
}

function migrateToFamilyStorage(): void {
  if (storage.getItem(STORAGE_VERSION_KEY) === "2") return;
  for (const family of ALL_FAMILIES) {
    const secondary = SECONDARY_VARIANT[family];
    if (!secondary) continue; // familles sans variante héritée (ex. code)
    mergeLegacyBucket(`ft:words:${secondary}`, wordsKey(family), mergeWordStatsRecords, {});
    mergeLegacyBucket(`ft:bigrams:${secondary}`, bigramsKey(family), mergeBigramStatsRecords, {});
    mergeLegacyBucket<TestLog[]>(
      `ft:testlog:${secondary}`,
      testLogKey(family),
      (a, b) => [...a, ...b].sort((x, y) => x.date - y.date).slice(-TESTLOG_MAX),
      []
    );
  }
  storage.setItem(STORAGE_VERSION_KEY, "2");
}

/**
 * Initialise le stockage : migration par famille. À appeler APRÈS `initDb()`
 * (le cache mémoire doit être chargé) et avant tout accès aux stats.
 */
export function initStore(): void {
  migrateToFamilyStorage();
}

export function loadWordStats(lang: LangId): Record<string, WordStat> {
  return read(wordsKey(lang), {});
}

export function loadBigramStats(lang: LangId): Record<string, BigramStat> {
  return read(bigramsKey(lang), {});
}

/** Confusions : `${bigrammeAttendu}\t${lettreTapée}` → nb (voir TestEngine.confusions). */
export function loadConfusions(lang: LangId): Record<string, number> {
  return read(confusionsKey(lang), {});
}

/** Fusionne les confusions de plusieurs familles de langue. */
export function loadConfusionsMerged(families: LangFamily[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const family of families) {
    for (const [k, n] of Object.entries(loadConfusions(family))) out[k] = (out[k] ?? 0) + n;
  }
  return out;
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
  storage.setItem(
    testLogKey(entry.lang),
    JSON.stringify(log.slice(-TESTLOG_MAX))
  );
}

/** Retire du journal brut l'entrée datée `date` (suppression manuelle d'un test). */
export function removeTestLog(lang: LangId, date: number): void {
  const log = loadTestLog(lang);
  const next = log.filter((t) => t.date !== date);
  if (next.length !== log.length) {
    storage.setItem(testLogKey(lang), JSON.stringify(next));
  }
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

/**
 * Reconstruit les stats par mot directement depuis le journal brut fourni, sans
 * passer par les agrégats persistés. Sert à l'onglet Mots : en filtrant les
 * journaux par mode en amont, on obtient des stats « tests normaux seulement »
 * (ou tout autre sous-ensemble), rétroactivement sur tout l'historique — un
 * entraînement ne pollue donc jamais le taux de faute ou la vitesse affichés.
 * Les `posErrors` proviennent du journal (absents des tests d'avant cette mise à
 * jour : la répartition par position se reconstruit alors au fil des tests).
 */
export function wordStatsFromLogs(logs: TestLog[]): TaggedWord[] {
  const map = new Map<string, TaggedWord>();
  for (const t of logs) {
    const family = FAMILY_OF[t.lang];
    for (const w of t.words) {
      const key = `${family} ${w.text}`;
      let e = map.get(key);
      if (!e) {
        e = {
          family,
          word: w.text,
          stat: {
            attempts: 0, errors: 0, errorAttempts: 0, posErrors: [],
            timeMs: 0, timedChars: 0, timedAttempts: 0, last: 0,
          },
        };
        map.set(key, e);
      }
      const s = e.stat;
      s.attempts += 1;
      s.errors += w.errors;
      if (w.errors > 0) s.errorAttempts += 1;
      const pe = w.posErrors;
      if (pe) for (let p = 0; p < pe.length; p++) s.posErrors[p] = (s.posErrors[p] ?? 0) + (pe[p] ?? 0);
      if (w.timeMs !== null && w.timeMs > 0) {
        s.timeMs += w.timeMs;
        s.timedChars += w.len;
        s.timedAttempts += 1;
      }
      if (t.date > s.last) s.last = t.date;
    }
  }
  return [...map.values()];
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
    if (t.mode !== "normal") continue; // la coloration reflète tes tests réels
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

/**
 * Intègre un résultat de test dans les stats persistées. Les agrégats par mot et
 * par bigramme ne reçoivent QUE les tests en mode normal : un entraînement ne
 * doit jamais faire baisser (ou monter) artificiellement les stats d'un mot ou
 * d'une paire — il reste visible via le journal brut (timeline, mode filtrable).
 * L'historique et les records, eux, gardent tous les modes.
 */
export function applyResult(
  result: TestResult,
  bigrams: Map<string, BigramStat>,
  confusions: Map<string, number>,
  meta?: { kind?: TestKind; target?: number; consistency?: number }
): void {
  if (result.mode === "normal") applyAggregates(result, bigrams, confusions);

  const history = loadHistory();
  history.push({
    date: result.date,
    lang: result.lang,
    mode: result.mode,
    wordCount: result.wordCount,
    durationMs: result.durationMs,
    wpm: result.wpm,
    accuracy: result.accuracy,
    kind: meta?.kind,
    target: meta?.target,
    consistency: meta?.consistency,
  });
  storage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-HISTORY_MAX)));
}

/** Écrit la contribution d'un test aux agrégats par mot, bigramme et confusion. */
function applyAggregates(
  result: TestResult,
  bigrams: Map<string, BigramStat>,
  confusions: Map<string, number>
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
  storage.setItem(wordsKey(result.lang), JSON.stringify(stats));

  const bg = loadBigramStats(result.lang);
  for (const [key, b] of bigrams) {
    const cur = bg[key] ?? { count: 0, gapMs: 0, errors: 0 };
    cur.count += b.count;
    cur.gapMs += b.gapMs;
    cur.errors += b.errors;
    cur.last = result.date;
    bg[key] = cur;
  }
  storage.setItem(bigramsKey(result.lang), JSON.stringify(bg));

  const conf = loadConfusions(result.lang);
  for (const [key, n] of confusions) conf[key] = (conf[key] ?? 0) + n;
  storage.setItem(confusionsKey(result.lang), JSON.stringify(conf));
}

/**
 * Défait exactement l'intégration d'un test : inverse de {@link applyResult}
 * (stats par mot, bigrammes, historique) et recalcule le record de la config
 * concernée. Le journal brut est retiré à part via {@link removeTestLog}. Sert à
 * la suppression manuelle d'un test qu'on ne veut pas compter. Comme
 * {@link applyResult}, les agrégats par mot/bigramme ne sont touchés que pour
 * les tests normaux (un entraînement n'y a jamais été ajouté).
 */
export function revertResult(
  result: TestResult,
  bigrams: Map<string, BigramStat>,
  confusions: Map<string, number>,
  meta?: { kind?: TestKind; target?: number }
): void {
  if (result.mode === "normal") revertAggregates(result, bigrams, confusions);

  // historique : on retire une entrée de même date (identifiant du test)
  const history = loadHistory();
  const idx = history.findIndex((h) => h.date === result.date && h.lang === result.lang);
  if (idx >= 0) {
    history.splice(idx, 1);
    storage.setItem(HISTORY_KEY, JSON.stringify(history));
  }

  // record : le test supprimé le détenait peut-être — on le recalcule depuis
  // l'historique désormais amputé.
  recomputeRecord({
    lang: result.lang,
    mode: result.mode,
    kind: meta?.kind,
    target: meta?.target,
    wordCount: result.wordCount,
  });
}

/** Retire la contribution d'un test des agrégats par mot, bigramme et confusion. */
function revertAggregates(
  result: TestResult,
  bigrams: Map<string, BigramStat>,
  confusions: Map<string, number>
): void {
  const stats = loadWordStats(result.lang);
  for (const w of result.words) {
    const s = stats[w.text];
    if (!s) continue;
    s.attempts -= 1;
    s.errors = Math.max(0, s.errors - w.errors);
    if (w.errors > 0) s.errorAttempts = Math.max(0, s.errorAttempts - 1);
    if (s.posErrors) {
      for (let p = 0; p < w.posErrors.length; p++) {
        s.posErrors[p] = Math.max(0, (s.posErrors[p] ?? 0) - (w.posErrors[p] ?? 0));
      }
    }
    if (w.timeMs !== null && w.timeMs > 0) {
      s.timeMs = Math.max(0, s.timeMs - w.timeMs);
      s.timedChars = Math.max(0, s.timedChars - w.text.length);
      s.timedAttempts = Math.max(0, s.timedAttempts - 1);
    }
    if (s.attempts <= 0) delete stats[w.text];
    else stats[w.text] = s;
  }
  storage.setItem(wordsKey(result.lang), JSON.stringify(stats));

  const bg = loadBigramStats(result.lang);
  for (const [key, b] of bigrams) {
    const cur = bg[key];
    if (!cur) continue;
    cur.count = Math.max(0, cur.count - b.count);
    cur.gapMs = Math.max(0, cur.gapMs - b.gapMs);
    cur.errors = Math.max(0, cur.errors - b.errors);
    if (cur.count === 0 && cur.errors === 0) delete bg[key];
    else bg[key] = cur;
  }
  storage.setItem(bigramsKey(result.lang), JSON.stringify(bg));

  const conf = loadConfusions(result.lang);
  for (const [key, n] of confusions) {
    const cur = (conf[key] ?? 0) - n;
    if (cur <= 0) delete conf[key];
    else conf[key] = cur;
  }
  storage.setItem(confusionsKey(result.lang), JSON.stringify(conf));
}

/**
 * Supprime un test ancien repéré par (langue, date d'historique). Retire l'entrée
 * d'historique et l'entrée de journal correspondante, défait sa contribution aux
 * stats par mot depuis le journal, et recalcule le record de la config.
 *
 * Limites assumées (négligeables pour un nettoyage ponctuel) : les `posErrors`
 * par position et les bigrammes ne sont pas stockés par test dans le journal,
 * donc pas défaits — ils dérivent très légèrement. Pour un test tout juste
 * terminé, préférer {@link revertResult}, qui lui est exact.
 *
 * Renvoie true si un test a bien été trouvé et supprimé.
 */
export function deleteHistoricalTest(lang: LangId, date: number): boolean {
  const history = loadHistory();
  const hIdx = history.findIndex((h) => h.date === date && h.lang === lang);
  if (hIdx < 0) return false;
  const entry = history[hIdx] as HistoryEntry;

  // journal brut : l'entrée du même test. Sa date est calée sur l'historique
  // pour les tests récents ; pour les anciens, elle diffère de quelques ms — on
  // prend donc la plus proche dans une tolérance étroite (jamais deux tests si
  // rapprochés).
  const log = loadTestLog(lang);
  let best = -1;
  let bestDiff = Infinity;
  for (let i = 0; i < log.length; i++) {
    const diff = Math.abs((log[i] as TestLog).date - date);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = i;
    }
  }
  if (best >= 0 && bestDiff <= 5000) {
    // les agrégats par mot n'ont reçu que les tests normaux : on ne les défait
    // que pour ceux-là. Le journal, lui, est retiré quel que soit le mode.
    if (entry.mode === "normal") {
      const stats = loadWordStats(lang);
      for (const w of (log[best] as TestLog).words) {
        const s = stats[w.text];
        if (!s) continue;
        s.attempts -= 1;
        s.errors = Math.max(0, s.errors - w.errors);
        if (w.errors > 0) s.errorAttempts = Math.max(0, s.errorAttempts - 1);
        if (w.timeMs !== null && w.timeMs > 0) {
          s.timeMs = Math.max(0, s.timeMs - w.timeMs);
          s.timedChars = Math.max(0, s.timedChars - w.len);
          s.timedAttempts = Math.max(0, s.timedAttempts - 1);
        }
        if (s.attempts <= 0) delete stats[w.text];
        else stats[w.text] = s;
      }
      storage.setItem(wordsKey(lang), JSON.stringify(stats));
    }
    log.splice(best, 1);
    storage.setItem(testLogKey(lang), JSON.stringify(log));
  }

  history.splice(hIdx, 1);
  storage.setItem(HISTORY_KEY, JSON.stringify(history));
  recomputeRecord({
    lang,
    mode: entry.mode,
    kind: entry.kind,
    target: entry.target,
    wordCount: entry.wordCount,
  });
  return true;
}

// ---------------------------------------------------------------------------
//  Records personnels par configuration (langue × type × cible × mode)
// ---------------------------------------------------------------------------
const RECORDS_KEY = "ft:records";
type RecordEntry = { wpm: number; date: number };
export type RecordMeta = {
  lang: LangId;
  mode: TestMode;
  kind?: TestKind;
  target?: number; // nb de mots (words) ou secondes (time)
  wordCount?: number; // repli si target absent (anciennes entrées)
};

function recordKey(m: RecordMeta): string {
  const kind = m.kind ?? "words";
  const target = m.target ?? m.wordCount ?? 0;
  return `${m.lang}|${kind}|${target}|${m.mode}`;
}

/** Charge les records, en les amorçant depuis l'historique au premier accès. */
function loadRecords(): Record<string, RecordEntry> {
  const existing = read<Record<string, RecordEntry> | null>(RECORDS_KEY, null);
  if (existing) return existing;
  const recs: Record<string, RecordEntry> = {};
  for (const h of loadHistory()) {
    const k = recordKey(h);
    if (!recs[k] || h.wpm > (recs[k] as RecordEntry).wpm) recs[k] = { wpm: h.wpm, date: h.date };
  }
  storage.setItem(RECORDS_KEY, JSON.stringify(recs));
  return recs;
}

/** Meilleur wpm enregistré pour cette configuration, ou null. */
export function bestRecord(m: RecordMeta): number | null {
  const r = loadRecords()[recordKey(m)];
  return r ? r.wpm : null;
}

/**
 * Enregistre le résultat s'il bat le record de sa configuration. Renvoie true
 * dès qu'un nouveau record est posé — y compris le tout premier test d'une
 * configuration (il devient d'office le record). À appeler AVANT d'ajouter le
 * test à l'historique.
 */
export function saveRecord(m: RecordMeta, wpm: number, date: number): boolean {
  const recs = loadRecords();
  const k = recordKey(m);
  const prev = recs[k];
  if (prev && wpm <= prev.wpm) return false;
  recs[k] = { wpm, date };
  storage.setItem(RECORDS_KEY, JSON.stringify(recs));
  return true; // record posé (premier test inclus)
}

/**
 * Recalcule le record d'une configuration depuis l'historique (à appeler APRÈS
 * en avoir retiré un test). Si plus aucun test ne correspond, la clé est purgée.
 */
export function recomputeRecord(m: RecordMeta): void {
  const recs = loadRecords();
  const k = recordKey(m);
  let best: RecordEntry | null = null;
  for (const h of loadHistory()) {
    if (recordKey(h) !== k) continue;
    if (!best || h.wpm > best.wpm) best = { wpm: h.wpm, date: h.date };
  }
  if (best) recs[k] = best;
  else delete recs[k];
  storage.setItem(RECORDS_KEY, JSON.stringify(recs));
}

export const ALL_LANGS: LangId[] = ["fr", "fr1k", "fr5k", "fracc", "en", "en1k", "en5k", "code"];

export function exportData(): string {
  const data: Record<string, unknown> = {
    version: 2,
    config: read("ft:config", null),
    history: loadHistory(),
    records: read(RECORDS_KEY, null),
  };
  for (const family of ALL_FAMILIES) {
    data[`words:${family}`] = loadWordStats(family);
    data[`bigrams:${family}`] = loadBigramStats(family);
    data[`confusions:${family}`] = loadConfusions(family);
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
    storage.setItem("ft:config", JSON.stringify(data["config"]));
  }
  if (Array.isArray(data["history"])) {
    storage.setItem(HISTORY_KEY, JSON.stringify(data["history"]));
  }
  if (data["records"]) {
    storage.setItem(RECORDS_KEY, JSON.stringify(data["records"]));
  } else {
    storage.removeItem(RECORDS_KEY); // ré-amorcé depuis l'historique importé
  }

  if (version === 2) {
    for (const family of ALL_FAMILIES) {
      if (data[`words:${family}`]) {
        storage.setItem(wordsKey(family), JSON.stringify(data[`words:${family}`]));
      }
      if (data[`bigrams:${family}`]) {
        storage.setItem(bigramsKey(family), JSON.stringify(data[`bigrams:${family}`]));
      }
      if (data[`confusions:${family}`]) {
        storage.setItem(confusionsKey(family), JSON.stringify(data[`confusions:${family}`]));
      }
      if (data[`testlog:${family}`]) {
        storage.setItem(testLogKey(family), JSON.stringify(data[`testlog:${family}`]));
      }
    }
    return;
  }

  // version 1 (héritage) : sections par variante (fr/fr1k/en/en1k), à fusionner par famille
  for (const lang of ALL_LANGS) {
    const words = data[`words:${lang}`] as Record<string, WordStat> | undefined;
    if (words) {
      storage.setItem(
        wordsKey(lang),
        JSON.stringify(mergeWordStatsRecords(read(wordsKey(lang), {}), words))
      );
    }
    const bg = data[`bigrams:${lang}`] as Record<string, BigramStat> | undefined;
    if (bg) {
      storage.setItem(
        bigramsKey(lang),
        JSON.stringify(mergeBigramStatsRecords(read(bigramsKey(lang), {}), bg))
      );
    }
    const logs = data[`testlog:${lang}`] as TestLog[] | undefined;
    if (logs) {
      const merged = [...read<TestLog[]>(testLogKey(lang), []), ...logs]
        .sort((a, b) => a.date - b.date)
        .slice(-TESTLOG_MAX);
      storage.setItem(testLogKey(lang), JSON.stringify(merged));
    }
  }
}

export function resetData(): void {
  const keys: string[] = [HISTORY_KEY, RECORDS_KEY];
  for (const family of ALL_FAMILIES) {
    keys.push(wordsKey(family), bigramsKey(family), confusionsKey(family), testLogKey(family));
  }
  for (const k of keys) storage.removeItem(k);
}
