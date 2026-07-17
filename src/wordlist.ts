import { FR_200 } from "./words/fr";
import { FR_1K } from "./words/fr1k";
import { EN_200 } from "./words/en";
import { EN_1K } from "./words/en1k";
import { CODE_WORDS } from "./words/code";
import type { BigramStat, Config, LangId, WordStat } from "./types";
import type { WordInput } from "./engine";
import { wordAvgWpm, wordErrRate } from "./store";

// Pool « accents » : mots du français (1k) contenant au moins un caractère
// accentué, pour cibler les touches mortes / AltGr. Dérivé, pas de liste dédiée.
const FR_ACCENTS = FR_1K.filter((w) => /[àâäéèêëîïôöùûüçœæ]/i.test(w));

export const LANGS: Record<LangId, { label: string; words: string[] }> = {
  fr: { label: "Français (200)", words: FR_200 },
  fr1k: { label: "Français (1k)", words: FR_1K },
  fracc: { label: "Français (accents)", words: FR_ACCENTS },
  en: { label: "English (200)", words: EN_200 },
  en1k: { label: "English (1k)", words: EN_1K },
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

/**
 * Entraînement « révision d'un mot » : on écrit le mot en boucle, puis de plus en
 * plus espacé (un sur deux, un sur trois) parmi des mots aléatoires du pool, pour
 * l'ancrer sans le taper mécaniquement.
 */
export function generateWordDrill(word: string, count: number, pool: string[]): string[] {
  const rnd = () => pool[Math.floor(Math.random() * pool.length)] ?? word;
  const pattern: boolean[] = [];
  for (let i = 0; i < 5; i++) pattern.push(true); // le mot seul
  for (let i = 0; i < 6; i++) pattern.push(i % 2 === 0); // un sur deux
  for (let i = 0; i < 9; i++) pattern.push(i % 3 === 0); // un sur trois
  while (pattern.length < count) pattern.push(Math.random() < 0.34);
  return pattern.slice(0, count).map((t) => (t ? word : rnd()));
}

export type PracticeCandidate = {
  word: string;
  score: number;
  avgWpm: number | null;
  errRate: number;
  attempts: number;
};

/**
 * Mots à retravailler : filtrés selon les seuils de config,
 * triés par un score de "difficulté" (erreurs + lenteur).
 */
export function practicePool(
  lang: LangId,
  cfg: Config,
  stats: Record<string, WordStat>
): PracticeCandidate[] {
  // les stats sont partagées par famille (fr/fr1k, en/en1k) : on ne garde que les
  // mots du pool réellement sélectionné pour cette session.
  const pool = new Set(LANGS[lang].words);
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
