import { FR_200 } from "./words/fr";
import { FR_1K } from "./words/fr1k";
import { EN_200 } from "./words/en";
import { EN_1K } from "./words/en1k";
import type { Config, LangId, WordStat } from "./types";
import { wordAvgWpm, wordErrRate } from "./store";

export const LANGS: Record<LangId, { label: string; words: string[] }> = {
  fr: { label: "Français (200)", words: FR_200 },
  fr1k: { label: "Français (1k)", words: FR_1K },
  en: { label: "English (200)", words: EN_200 },
  en1k: { label: "English (1k)", words: EN_1K },
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
