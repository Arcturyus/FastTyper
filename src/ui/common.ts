import type { Config, WordStat } from "../types";
import { wordAvgWpm, wordErrRate } from "../store";

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Classes de coloration d'un mot selon son historique et la config */
export function wordClasses(
  stat: WordStat | undefined,
  cfg: Config
): string[] {
  if (!stat || cfg.colorBy === "off" || stat.attempts < cfg.minAttempts) {
    return [];
  }
  const classes: string[] = [];
  if (cfg.colorBy === "speed" || cfg.colorBy === "both") {
    const wpm = wordAvgWpm(stat);
    if (wpm !== null) {
      if (wpm <= cfg.slowWpm) classes.push("w-slow");
      else if (wpm >= cfg.fastWpm) classes.push("w-fast");
    }
  }
  if (cfg.colorBy === "errors" || cfg.colorBy === "both") {
    if (wordErrRate(stat) >= cfg.errWarnRate) classes.push("w-err");
  }
  return classes;
}

/**
 * Rang (0..1) d'une vitesse dans la distribution triée (croissante) des vitesses
 * de tes mots : le mot le plus lent → 0, le plus rapide → 1. L'échelle s'adapte
 * ainsi à TA répartition, indépendamment des seuils de réglage.
 */
export function speedPercentile(wpm: number, sortedAsc: number[]): number {
  const n = sortedAsc.length;
  if (n <= 1) return 0.5;
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((sortedAsc[mid] as number) <= wpm) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(0, Math.min(1, (lo - 1) / (n - 1))); // rang du mot lui-même
}

/**
 * Teinte d'encre d'un mot d'après son rang de vitesse (`pct`, 0..1). Le corps de
 * l'échelle reste bronze mat (`spd` : bronze foncé lent → bronze cuivré rapide) ;
 * seuls les deux extrêmes s'allument, de façon symétrique et lumineuse :
 * `gold` vire à l'or sur le top 1 % (l'élite) et `redMix` vire au rouge orangé
 * sanguin sur les ~30 % les plus lents, en montant très fort vers les tout plus
 * lents — aussi flagrant que l'or.
 */
export function speedShade(
  pct: number
): { spd: number; redMix: number; gold: number } {
  const red = Math.max(0, Math.min(1, (0.3 - pct) / 0.3)); // 30% les plus lents
  const redMix = Math.pow(red, 1.6); // monte très fort vers les tout plus lents
  const gold = Math.max(0, Math.min(1, (pct - 0.99) / 0.01)); // or : top 1% seulement
  return { spd: pct, redMix, gold };
}

export function fmt(n: number, digits = 0): string {
  return n.toLocaleString("fr-FR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function fmtPct(rate: number): string {
  return fmt(rate * 100) + " %";
}

let toastTimer: number | undefined;
export function toast(message: string): void {
  const node = document.getElementById("toast");
  if (!node) return;
  node.textContent = message;
  node.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    node.hidden = true;
  }, 3000);
}
