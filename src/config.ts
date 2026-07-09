import type { Config } from "./types";

const KEY = "ft:config";

export const DEFAULT_CONFIG: Config = {
  lang: "fr",
  wordCount: 25,
  colorBy: "both",
  minAttempts: 3,
  slowWpm: 35,
  fastWpm: 65,
  errWarnRate: 0.25,
  practiceMinAttempts: 3,
  practiceErrRate: 0.2,
  practiceMaxWpm: 40,
  practicePoolSize: 30,
  paceCaret: false,
  paceAvgCount: 10,
};

export function loadConfig(): Config {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_CONFIG };
    return { ...DEFAULT_CONFIG, ...(JSON.parse(raw) as Partial<Config>) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(cfg: Config): void {
  localStorage.setItem(KEY, JSON.stringify(cfg));
}
