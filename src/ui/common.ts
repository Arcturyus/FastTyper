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
