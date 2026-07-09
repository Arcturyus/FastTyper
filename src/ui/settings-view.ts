import { DEFAULT_CONFIG, loadConfig, saveConfig } from "../config";
import type { Config } from "../types";
import { el, toast } from "./common";

type NumField = {
  key: keyof Config;
  label: string;
  min: number;
  max: number;
  step?: number;
  asPercent?: boolean;
};

export function mountSettingsView(root: HTMLElement, signal: AbortSignal): void {
  let cfg = loadConfig();
  root.innerHTML = "";
  root.append(el("h2", "page-title", "Réglages"));

  function numRow(field: NumField): HTMLElement {
    const row = el("div", "field-row");
    row.append(el("label", undefined, field.label));
    const input = el("input");
    input.type = "number";
    input.min = String(field.min);
    input.max = String(field.max);
    input.step = String(field.step ?? 1);
    const raw = cfg[field.key] as number;
    input.value = String(field.asPercent ? Math.round(raw * 100) : raw);
    input.addEventListener(
      "change",
      () => {
        let value = Number(input.value);
        if (Number.isNaN(value)) return;
        value = Math.min(field.max, Math.max(field.min, value));
        input.value = String(value);
        (cfg[field.key] as number) = field.asPercent ? value / 100 : value;
        saveConfig(cfg);
      },
      { signal }
    );
    row.append(input);
    return row;
  }

  function checkboxRow(
    key: keyof Config,
    label: string
  ): HTMLElement {
    const row = el("div", "field-row");
    row.append(el("label", undefined, label));
    const input = el("input");
    input.type = "checkbox";
    input.checked = cfg[key] as boolean;
    input.addEventListener(
      "change",
      () => {
        (cfg[key] as boolean) = input.checked;
        saveConfig(cfg);
      },
      { signal }
    );
    row.append(input);
    return row;
  }

  // --- rythme ---
  const paceGroup = el("div", "settings-group");
  paceGroup.append(el("h3", undefined, "Curseur de rythme"));
  paceGroup.append(
    el(
      "p",
      "hint",
      "Affiche un curseur fantôme (tirets violets) qui avance à ta vitesse moyenne récente. Reste devant lui pour battre ta moyenne. Se règle aussi via le bouton ⏱ Rythme au-dessus du test."
    )
  );
  paceGroup.append(
    checkboxRow("paceCaret", "Activer le curseur de rythme"),
    numRow({ key: "paceAvgCount", label: "Nombre de tests récents pour la moyenne", min: 1, max: 100 })
  );
  root.append(paceGroup);

  // --- coloration ---
  const colorGroup = el("div", "settings-group");
  colorGroup.append(el("h3", undefined, "Coloration des mots pendant le test"));
  colorGroup.append(
    el(
      "p",
      "hint",
      "Les mots sont teintés selon ton historique : fond orangé = mot lent, fond vert = mot rapide, soulignement rouge = mot souvent fauté."
    )
  );

  const modeRow = el("div", "field-row");
  modeRow.append(el("label", undefined, "Colorer selon"));
  const modeSel = el("select");
  const modes: [Config["colorBy"], string][] = [
    ["both", "vitesse + erreurs"],
    ["speed", "vitesse seulement"],
    ["errors", "erreurs seulement"],
    ["off", "désactivé"],
  ];
  for (const [value, label] of modes) {
    const opt = el("option", undefined, label);
    opt.value = value;
    if (cfg.colorBy === value) opt.selected = true;
    modeSel.append(opt);
  }
  modeSel.addEventListener(
    "change",
    () => {
      cfg.colorBy = modeSel.value as Config["colorBy"];
      saveConfig(cfg);
    },
    { signal }
  );
  modeRow.append(modeSel);
  colorGroup.append(modeRow);

  colorGroup.append(
    numRow({ key: "minAttempts", label: "Essais minimum avant de colorer un mot", min: 1, max: 50 }),
    numRow({ key: "slowWpm", label: "Mot « lent » si wpm moyen ≤", min: 5, max: 200 }),
    numRow({ key: "fastWpm", label: "Mot « rapide » si wpm moyen ≥", min: 10, max: 300 }),
    numRow({
      key: "errWarnRate",
      label: "Mot « à risque » si % d'essais fautés ≥",
      min: 1,
      max: 100,
      asPercent: true,
    })
  );
  root.append(colorGroup);

  // --- entraînement ---
  const practiceGroup = el("div", "settings-group");
  practiceGroup.append(el("h3", undefined, "Mode entraînement"));
  practiceGroup.append(
    el(
      "p",
      "hint",
      "Le mode entraînement génère un test à partir de tes pires mots : ceux qui dépassent le seuil d'erreur ou restent sous le seuil de vitesse. Les pires reviennent plus souvent."
    )
  );
  practiceGroup.append(
    numRow({ key: "practiceMinAttempts", label: "Essais minimum pour qu'un mot soit éligible", min: 1, max: 50 }),
    numRow({
      key: "practiceErrRate",
      label: "Inclure si % d'essais fautés ≥",
      min: 1,
      max: 100,
      asPercent: true,
    }),
    numRow({ key: "practiceMaxWpm", label: "Inclure si wpm moyen ≤", min: 5, max: 200 }),
    numRow({ key: "practicePoolSize", label: "Taille max du pool de mots", min: 5, max: 200 })
  );
  root.append(practiceGroup);

  // --- remise à zéro ---
  const resetGroup = el("div", "settings-group");
  resetGroup.append(el("h3", undefined, "Réinitialiser"));
  const resetBtn = el("button", "btn", "Rétablir les réglages par défaut");
  resetBtn.addEventListener(
    "click",
    () => {
      cfg = { ...DEFAULT_CONFIG, lang: cfg.lang, wordCount: cfg.wordCount };
      saveConfig(cfg);
      toast("Réglages rétablis.");
      mountSettingsView(root, signal);
    },
    { signal }
  );
  resetGroup.append(resetBtn);
  root.append(resetGroup);
}
