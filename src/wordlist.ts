import { FR_200 } from "./words/fr";
import { FR_1K } from "./words/fr1k";
import { FR_5K } from "./words/fr5k";
import { EN_200 } from "./words/en";
import { EN_1K } from "./words/en1k";
import { EN_5K } from "./words/en5k";
import { CODE_WORDS } from "./words/code";
import type { BigramStat, Config, LangId, WordStat } from "./types";
import type { WordInput } from "./engine";
import { FAMILY_OF, type LangFamily } from "./lang";
import { wordAvgWpm, wordErrRate, wordPosErrorRates } from "./store";

// Pool « accents » : mots du français (1k) contenant au moins un caractère
// accentué, pour cibler les touches mortes / AltGr. Dérivé, pas de liste dédiée.
const FR_ACCENTS = FR_1K.filter((w) => /[àâäéèêëîïôöùûüçœæ]/i.test(w));

export const LANGS: Record<LangId, { label: string; words: string[] }> = {
  fr: { label: "Français (200)", words: FR_200 },
  fr1k: { label: "Français (1k)", words: FR_1K },
  fr5k: { label: "Français (5k)", words: FR_5K },
  fracc: { label: "Français (accents)", words: FR_ACCENTS },
  en: { label: "English (200)", words: EN_200 },
  en1k: { label: "English (1k)", words: EN_1K },
  en5k: { label: "English (5k)", words: EN_5K },
  code: { label: "Code & chiffres", words: CODE_WORDS },
};

function sample(pool: string[], count: number): string[] {
  const out: string[] = [];
  let prev = "";
  for (let i = 0; i < count; i++) {
    let w = pool[Math.floor(Math.random() * pool.length)] ?? "";
    // évite les répétitions immédiates quand le pool le permet
    for (let tries = 0; w === prev && pool.length > 1 && tries < 10; tries++) {
      w = pool[Math.floor(Math.random() * pool.length)] ?? "";
    }
    out.push(w);
    prev = w;
  }
  return out;
}

export function generateWords(lang: LangId, count: number): string[] {
  return sample(LANGS[lang].words, count);
}

/**
 * Saupoudre ponctuation et majuscules sur une liste de mots pour se rapprocher
 * d'un texte réel. Le mot nu reste la clé des stats (`base`) : seule la forme
 * tapée (`text`) porte la décoration. La casse de phrase et les virgules/points
 * sont posées au fil de l'eau.
 */
export function decoratePunctuation(words: string[]): WordInput[] {
  const out: WordInput[] = [];
  let sentenceStart = true;
  for (let i = 0; i < words.length; i++) {
    const base = words[i] as string;
    let text = base;
    if (sentenceStart) {
      text = text.charAt(0).toUpperCase() + text.slice(1);
      sentenceStart = false;
    }
    const last = i === words.length - 1;
    const r = Math.random();
    if (last) {
      text += ".";
    } else if (r < 0.1) {
      text += ",";
    } else if (r < 0.18) {
      text += ".";
      sentenceStart = true;
    } else if (r < 0.21) {
      text += "?"; // question rare
      sentenceStart = true;
    }
    out.push(text === base ? base : { text, base });
  }
  return out;
}

/** Difficulté d'un bigramme : erreurs pondérées + lenteur (0 si trop peu de données). */
export function bigramDifficulty(b: BigramStat): number {
  const total = b.count + b.errors;
  if (total < 4) return 0;
  const err = b.errors / total;
  const gap = b.count > 0 ? b.gapMs / b.count : 0;
  return err * 2 + Math.min(1, gap / 400);
}

/**
 * Entraînement ciblé sur tes pires bigrammes : repère les paires de lettres les
 * plus fautées/lentes, puis tire des mots du pool qui les contiennent (pondérés
 * par le nombre de bigrammes difficiles présents). Renvoie null si trop peu de
 * données de bigrammes.
 */
export function generateBigramPractice(
  lang: LangId,
  count: number,
  bigrams: Record<string, BigramStat>
): string[] | null {
  const targets = Object.entries(bigrams)
    .map(([k, b]) => ({ k, score: bigramDifficulty(b) }))
    .filter((d) => d.score > 0 && !d.k.includes(" ")) // paires de lettres seulement
    .sort((a, b) => b.score - a.score)
    .slice(0, 12)
    .map((d) => d.k);
  if (targets.length === 0) return null;
  const weighted: string[] = [];
  for (const w of LANGS[lang].words) {
    let s = 0;
    for (const t of targets) if (w.includes(t)) s += 1;
    for (let i = 0; i < s; i++) weighted.push(w);
  }
  if (weighted.length === 0) return null;
  return sample(weighted, count);
}

// ===========================================================================
//  Entraînement « révision d'un mot » : échelle de fragments graduée
// ===========================================================================
// Réglages de pondération, regroupés ici pour être ajustés facilement.
//
// Score de difficulté d'un fragment (une tranche du mot) : on additionne, pour
// chaque LETTRE de la tranche, son taux de faute local dans ce mot précis
// (posErrors) — c'est là qu'on veut le plus insister — et, pour chaque BIGRAMME
// interne, sa difficulté globale (fautes + lenteur, toutes sources confondues).
// Les deux poids arbitrent l'importance relative des deux signaux.
const DRILL_POS_W = 2; // poids des zones fautées du mot (posErrors)
const DRILL_BG_W = 1; // poids de la difficulté globale des bigrammes
// Base ajoutée au score de chaque fragment avant de répartir les répétitions :
// garantit qu'un fragment sans aucune donnée d'erreur apparaît quand même, pour
// couvrir tout le mot (plus c'est haut, plus la couverture prime sur le ciblage).
const DRILL_SMOOTH = 0.15;
// Longueur cible du drill dérivée du mot : un drill est volontairement copieux,
// indépendamment du nombre de mots choisi pour un test normal.
const DRILL_PER_LETTER = 5; // fragments visés par lettre du mot
const DRILL_MIN = 24; // plancher (mots très courts)
const DRILL_MAX = 70; // plafond (mots très longs)
// Poids de budget par palier de longueur (fragments) + mot complet. Le budget
// total (count) est réparti entre paliers au prorata de ces poids.
const DRILL_W_BIGRAM = 4; // tranches de 2 lettres : le plus gros paquet
const DRILL_W_MID = 3; // tranches de ~4 lettres
const DRILL_W_LARGE = 2; // tranches de ~moitié du mot
const DRILL_W_FULL = 2; // mot entier (martelé puis espacé)
// Part du budget « mot complet » tapée d'affilée (le reste est espacé parmi des
// mots du pool, pour tester la restitution sans support).
const DRILL_FULL_SOLID = 0.6;

/**
 * Répartit `budget` répétitions entre des fragments d'après leur score : les
 * plus difficiles reviennent le plus souvent, mais chaque fragment garde sa
 * chance (via {@link DRILL_SMOOTH}) pour couvrir tout le mot. Méthode du plus
 * fort reste pour tomber pile sur `budget`. Renvoie le nombre de répétitions
 * par fragment (même ordre que `scores`).
 */
function allocateReps(scores: number[], budget: number): number[] {
  const n = scores.length;
  const reps = new Array<number>(n).fill(0);
  if (n === 0 || budget <= 0) return reps;
  const weights = scores.map((s) => s + DRILL_SMOOTH);
  const totalW = weights.reduce((a, b) => a + b, 0);
  const raw = weights.map((w) => (w / totalW) * budget);
  for (let i = 0; i < n; i++) reps[i] = Math.floor(raw[i] as number);
  let used = reps.reduce((a, b) => a + b, 0);
  const byFrac = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; used < budget; k++, used++) {
    const idx = (byFrac[k % n] as { i: number }).i;
    reps[idx] = (reps[idx] as number) + 1;
  }
  return reps;
}

/**
 * Entraînement « révision d'un mot » : une échelle de fragments de plus en plus
 * longs, tous découpés dans le mot lui-même, du bigramme au mot entier. À chaque
 * palier (2 lettres, ~4 lettres, ~moitié du mot), on balaie le mot par fenêtres
 * glissantes qui se chevauchent (« sous-versions ») et on répète chaque tranche
 * d'autant plus qu'elle est difficile — la difficulté combinant les zones où tu
 * fautes dans CE mot et la difficulté globale de ses bigrammes. On finit par le
 * mot complet, martelé puis espacé parmi des mots du pool.
 *
 * Les fragments (plus courts que le mot) sont marqués `noStats` : leurs frappes
 * comptent dans le WPM et nourrissent les stats de bigrammes, mais ne polluent
 * pas les stats par mot (« on », « ir »… ne sont pas comptés comme des mots).
 *
 * La longueur du drill est dérivée du mot ({@link DRILL_PER_LETTER}), au moins
 * `count` : un drill reste copieux même si le test est réglé sur peu de mots.
 */
export function generateWordDrill(
  word: string,
  count: number,
  pool: string[],
  bigrams: Record<string, BigramStat> = {},
  stat?: WordStat
): WordInput[] {
  const L = word.length;
  const rnd = () => pool[Math.floor(Math.random() * pool.length)] ?? word;
  const target = Math.max(
    count,
    Math.min(DRILL_MAX, Math.max(DRILL_MIN, Math.round(L * DRILL_PER_LETTER)))
  );

  // mot trop court pour des fragments : martèlement puis espacement
  if (L < 3) {
    const out: WordInput[] = [];
    const solid = Math.max(1, Math.round(target * DRILL_FULL_SOLID));
    for (let i = 0; i < solid; i++) out.push(word);
    for (let i = 0; out.length < target; i++) out.push(i % 2 === 0 ? rnd() : word);
    return out.slice(0, target);
  }

  const posRate = stat ? wordPosErrorRates(stat, L) : [];
  const bgDiff = (i: number): number => {
    const b = bigrams[word.slice(i, i + 2)];
    return b ? bigramDifficulty(b) : 0;
  };
  // score d'une tranche [start, start+len) : fautes locales + bigrammes internes
  const chunkScore = (start: number, len: number): number => {
    let s = 0;
    for (let p = start; p < start + len; p++) s += DRILL_POS_W * (posRate[p] ?? 0);
    for (let i = start; i < start + len - 1; i++) s += DRILL_BG_W * bgDiff(i);
    return s;
  };

  // paliers de longueur croissante (chunks < L), chacun avec son poids de budget
  const levels: { len: number; weight: number }[] = [{ len: 2, weight: DRILL_W_BIGRAM }];
  const midLen = Math.min(4, L - 1);
  if (midLen > 2) levels.push({ len: midLen, weight: DRILL_W_MID });
  const largeLen = Math.ceil(L / 2);
  if (largeLen > midLen && largeLen < L) levels.push({ len: largeLen, weight: DRILL_W_LARGE });

  // budget : on réserve d'abord le mot complet, le reste va aux fragments
  const totalWeight = levels.reduce((a, l) => a + l.weight, 0) + DRILL_W_FULL;
  const fullBudget = Math.max(2, Math.round((target * DRILL_W_FULL) / totalWeight));
  const chunkBudget = Math.max(0, target - fullBudget);
  const levelWeightSum = levels.reduce((a, l) => a + l.weight, 0);

  const out: WordInput[] = [];
  let spent = 0;
  for (let li = 0; li < levels.length; li++) {
    const lvl = levels[li] as { len: number; weight: number };
    const isLast = li === levels.length - 1;
    const budget = isLast
      ? chunkBudget - spent
      : Math.round((chunkBudget * lvl.weight) / levelWeightSum);
    spent += budget;
    const starts: number[] = [];
    for (let i = 0; i + lvl.len <= L; i++) starts.push(i);
    const reps = allocateReps(starts.map((s) => chunkScore(s, lvl.len)), budget);
    // ordre de lecture : gauche → droite ; la difficulté se traduit en répétitions
    for (let w = 0; w < starts.length; w++) {
      const frag = word.slice(starts[w] as number, (starts[w] as number) + lvl.len);
      for (let r = 0; r < (reps[w] as number); r++) {
        out.push({ text: frag, base: frag, noStats: true });
      }
    }
  }

  // mot complet : martelé, puis espacé parmi des mots du pool (restitution)
  const remaining = Math.max(1, target - out.length);
  const solid = Math.max(1, Math.round(remaining * DRILL_FULL_SOLID));
  for (let i = 0; i < solid; i++) out.push(word);
  for (let i = 0; i < remaining - solid; i++) out.push(i % 2 === 0 ? rnd() : word);
  return out.slice(0, target);
}

export type PracticeCandidate = {
  word: string;
  score: number;
  avgWpm: number | null;
  errRate: number;
  attempts: number;
};

/** Union des pools d'une famille : tous les mots connus, aucune variante n'exclut l'autre. */
export function familyWords(family: LangFamily): Set<string> {
  const out = new Set<string>();
  for (const [id, l] of Object.entries(LANGS)) {
    if (FAMILY_OF[id as LangId] === family) for (const w of l.words) out.add(w);
  }
  return out;
}

/**
 * Mots à retravailler : filtrés selon les seuils de config,
 * triés par un score de "difficulté" (erreurs + lenteur).
 * `poolOverride` élargit le filtre (ex. union des pools d'une famille, pour
 * l'affichage dans Stats) ; par défaut, seul le pool de la langue compte.
 */
export function practicePool(
  lang: LangId,
  cfg: Config,
  stats: Record<string, WordStat>,
  poolOverride?: Set<string>
): PracticeCandidate[] {
  // les stats sont partagées par famille (fr/fr1k, en/en1k) : on ne garde que les
  // mots du pool réellement sélectionné pour cette session.
  const pool = poolOverride ?? new Set(LANGS[lang].words);
  const candidates: PracticeCandidate[] = [];
  for (const [word, s] of Object.entries(stats)) {
    if (!pool.has(word)) continue;
    if (s.attempts < cfg.practiceMinAttempts) continue;
    const avg = wordAvgWpm(s);
    const err = wordErrRate(s);
    const tooSlow = avg !== null && avg <= cfg.practiceMaxWpm;
    const tooManyErrors = err >= cfg.practiceErrRate;
    if (!tooSlow && !tooManyErrors) continue;
    // score : les erreurs pèsent plus lourd que la lenteur
    const slowness =
      avg === null ? 0 : Math.max(0, (cfg.practiceMaxWpm - avg) / cfg.practiceMaxWpm);
    candidates.push({
      word,
      score: err * 2 + slowness,
      avgWpm: avg,
      errRate: err,
      attempts: s.attempts,
    });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, cfg.practicePoolSize);
}

/** Génère un test d'entraînement pondéré : les pires mots reviennent plus souvent */
export function generatePractice(
  lang: LangId,
  count: number,
  cfg: Config,
  stats: Record<string, WordStat>
): string[] | null {
  const pool = practicePool(lang, cfg, stats);
  if (pool.length === 0) return null;
  const weighted: string[] = [];
  for (const c of pool) {
    const copies = 1 + Math.min(4, Math.round(c.score * 3));
    for (let i = 0; i < copies; i++) weighted.push(c.word);
  }
  return sample(weighted, count);
}
