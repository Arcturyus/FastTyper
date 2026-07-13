export type LangId = "fr" | "fr1k" | "en" | "en1k";

export type TestMode = "normal" | "practice";

export type LetterState = "correct" | "incorrect" | "extra";

/** État d'un mot pendant le test */
export type TestWord = {
  text: string;
  typed: string;
  states: LetterState[];
  errors: number; // frappes fausses (y compris extras) commises dans ce mot
  posWrong: boolean[]; // position p tapée fausse au moins une fois dans cet essai
  startMs?: number;
  endMs?: number;
};

export type Keystroke = { t: number; correct: boolean };

/** Résultat d'un mot dans un test terminé */
export type WordResult = {
  text: string;
  timeMs: number | null; // null si le mot n'a pas été tapé en entier
  errors: number; // frappes fausses + caractères manqués
  correct: boolean; // tapé complet et sans erreur
  posErrors: number[]; // 1 si la position p a été fautée dans cet essai, sinon 0
};

export type TestResult = {
  date: number;
  lang: LangId;
  mode: TestMode;
  wordCount: number;
  durationMs: number;
  wpm: number;
  rawWpm: number;
  accuracy: number; // 0..1
  words: WordResult[];
  wpmSeries: { t: number; wpm: number }[];
};

/**
 * Un mot tel qu'il a été tapé dans un test donné, avec juste ce qu'il faut pour
 * l'analyse des biais (vitesse / erreurs selon le contexte).
 */
export type WordAttempt = {
  text: string;
  index: number; // position du mot dans le test (0 = premier)
  len: number; // longueur du mot
  timeMs: number | null; // temps sur le mot (null si non tapé en entier)
  errors: number; // frappes fausses (+ caractères manqués si le mot a été validé)
  correct: boolean;
};

/**
 * Journal d'un test complet, terminé OU abandonné (Tab/Échap). Sert uniquement
 * à l'analyse des biais dans Stats : n'alimente pas les stats par mot/bigrammes.
 * Le contexte partagé (rythme, mode…) est stocké une seule fois par test.
 */
export type TestLog = {
  date: number;
  lang: LangId;
  mode: TestMode;
  pace: boolean; // curseur de rythme réellement actif pendant le test
  paceWpm: number | null; // vitesse cible du rythme, si actif
  hints?: boolean; // surlignages/soulignages affichés pendant le test (optionnel : absent des anciens journaux)
  wordCount: number; // longueur voulue du test (10/25/50)
  completed: boolean; // true = test terminé, false = abandonné en cours
  words: WordAttempt[]; // uniquement les mots atteints
};

/** Stats cumulées d'un mot, persistées entre les sessions */
export type WordStat = {
  attempts: number;
  errors: number; // unités d'erreur cumulées
  errorAttempts: number; // essais avec au moins une erreur
  posErrors: number[]; // essais fautés cumulés à chaque position du mot
  timeMs: number; // temps cumulé sur les essais chronométrés
  timedChars: number; // caractères cumulés sur ces essais
  timedAttempts: number;
  last: number; // date du dernier essai
};

/** Stats cumulées d'un bigramme (paire de lettres) */
export type BigramStat = {
  count: number; // transitions correctes mesurées
  gapMs: number; // temps cumulé entre les deux frappes
  errors: number; // deuxième lettre fausse après une première correcte
};

export type HistoryEntry = {
  date: number;
  lang: LangId;
  mode: TestMode;
  wordCount: number;
  durationMs: number;
  wpm: number;
  accuracy: number;
};

export type Config = {
  lang: LangId;
  wordCount: number;
  colorBy: "off" | "speed" | "errors" | "both";
  hints: boolean; // interrupteur global des indices (surlignages/soulignages)
  minAttempts: number; // essais requis avant de colorer un mot
  slowWpm: number; // en dessous ou égal → mot "lent"
  fastWpm: number; // au-dessus ou égal → mot "rapide"
  errWarnRate: number; // part d'essais fautés (0..1) → mot "à risque"
  practiceMinAttempts: number;
  practiceErrRate: number; // seuil d'erreur pour entrer dans l'entraînement
  practiceMaxWpm: number; // seuil de lenteur pour entrer dans l'entraînement
  practicePoolSize: number; // taille max du pool de mots à travailler
  paceCaret: boolean; // curseur fantôme avançant à la moyenne des 10 derniers
  paceAvgCount: number; // nombre de tests récents pris pour la moyenne cible
};
