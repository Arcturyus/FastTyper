import type { LangId } from "./types";

/**
 * Famille de langue : fr/fr1k partagent le français (fr1k n'est qu'un pool plus
 * large), en/en1k partagent l'anglais. Les stats de mots/bigrammes/journaux sont
 * stockées par famille pour que la pratique se transfère entre tailles de pool.
 */
export type LangFamily = "fr" | "en";

export const FAMILY_OF: Record<LangId, LangFamily> = {
  fr: "fr",
  fr1k: "fr",
  en: "en",
  en1k: "en",
};

export const ALL_FAMILIES: LangFamily[] = ["fr", "en"];

export const FAMILY_LABEL: Record<LangFamily, string> = {
  fr: "Français",
  en: "English",
};
