import { DEFAULT_CONFIG, loadConfig, saveConfig } from "../config";
import { exportData, importData } from "../store";
import type { Config } from "../types";
import { el, toast } from "./common";

/** Déclenche le téléchargement d'un fichier texte côté navigateur. */
function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = el("a");
  a.href = url;
  a.download = filename;
  a.click();
  // Libère l'URL après un court délai (le clic est synchrone mais la lecture peut suivre).
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

type NumField = {
  key: keyof Config;
  label: string;
  min: number;
  max: number;
  step?: number;
  asPercent?: boolean;
};

/** Déclenche `action` au clic, puis en rafale accélérée tant que le bouton reste enfoncé. */
function bindRepeat(btn: HTMLButtonElement, action: () => void, signal: AbortSignal): void {
  let timer: number | undefined;
  let delay = 400;

  const stop = () => {
    window.clearTimeout(timer);
    timer = undefined;
    delay = 400;
  };
  const tick = () => {
    if (btn.disabled) {
      stop();
      return;
    }
    action();
    delay = Math.max(40, delay * 0.75);
    timer = window.setTimeout(tick, delay);
  };

  btn.addEventListener(
    "pointerdown",
    (e) => {
      if (btn.disabled) return;
      e.preventDefault();
      action();
      timer = window.setTimeout(tick, delay);
    },
    { signal }
  );
  for (const evt of ["pointerup", "pointerleave", "pointercancel"]) {
    btn.addEventListener(evt, stop, { signal });
  }
}

export function mountSettingsView(root: HTMLElement, signal: AbortSignal): void {
  let cfg = loadConfig();
  root.innerHTML = "";
  root.append(el("h2", "page-title", "Réglages"));

  function numRow(field: NumField): HTMLElement {
    const row = el("div", "field-row");
    row.append(el("label", undefined, field.label));

    // Tout se passe dans l'espace « affiché » (pourcentage entier si asPercent,
    // sinon la valeur brute) — la conversion vers cfg n'a lieu qu'à l'écriture.
    const step = field.step ?? 1;
    const raw = cfg[field.key] as number;
    const toDisplay = (v: number) => (field.asPercent ? Math.round(v * 100) : v);
    const toStored = (v: number) => (field.asPercent ? v / 100 : v);

    const stepper = el("div", "num-stepper");
    const minusBtn = el("button", "num-stepper-btn", "−");
    minusBtn.type = "button";
    const input = el("input", "num-stepper-input");
    input.type = "number";
    input.min = String(field.min);
    input.max = String(field.max);
    input.step = String(step);
    input.inputMode = "numeric";
    input.value = String(toDisplay(raw));
    const plusBtn = el("button", "num-stepper-btn", "+");
    plusBtn.type = "button";

    function updateDisabled(): void {
      const v = Number(input.value);
      minusBtn.disabled = v <= field.min;
      plusBtn.disabled = v >= field.max;
    }

    const commit = (displayValue: number) => {
      const clamped = Math.min(field.max, Math.max(field.min, displayValue));
      input.value = String(clamped);
      (cfg[field.key] as number) = toStored(clamped);
      saveConfig(cfg);
      updateDisabled();
    };

    bindRepeat(minusBtn, () => commit(Number(input.value) - step), signal);
    bindRepeat(plusBtn, () => commit(Number(input.value) + step), signal);
    input.addEventListener(
      "change",
      () => {
        const value = Number(input.value);
        if (Number.isNaN(value)) return;
        commit(value);
      },
      { signal }
    );

    updateDisabled();
    stepper.append(minusBtn, input, plusBtn);
    row.append(stepper);
    return row;
  }

  function checkboxRow(
    key: keyof Config,
    label: string
  ): HTMLElement {
    const row = el("div", "field-row");
    row.append(el("label", undefined, label));
    const toggle = el("label", "toggle");
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
    const track = el("span", "toggle-track");
    toggle.append(input, track);
    row.append(toggle);
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

  // --- sauvegarde ---
  const backupGroup = el("div", "settings-group");
  backupGroup.append(el("h3", undefined, "Sauvegarde"));
  backupGroup.append(
    el(
      "p",
      "hint",
      "Exporte toutes tes données (réglages, historique, stats par mot, journaux) dans un fichier. Transfère-le sur un autre appareil puis importe-le pour retrouver ta progression. Sans compte ni serveur."
    )
  );

  const backupRow = el("div", "field-row");
  backupRow.append(el("label", undefined, "Fichier de sauvegarde"));
  const backupBtns = el("div", "num-stepper");

  const exportBtn = el("button", "btn", "⬇ Télécharger");
  exportBtn.type = "button";
  exportBtn.addEventListener(
    "click",
    () => {
      const stamp = new Date().toISOString().slice(0, 10); // AAAA-MM-JJ
      downloadText(`fasttyper-sauvegarde-${stamp}.json`, exportData());
      toast("Sauvegarde téléchargée.");
    },
    { signal }
  );

  const importBtn = el("button", "btn", "⬆ Importer");
  importBtn.type = "button";
  const fileInput = el("input");
  fileInput.type = "file";
  fileInput.accept = "application/json,.json";
  fileInput.hidden = true;
  importBtn.addEventListener("click", () => fileInput.click(), { signal });
  fileInput.addEventListener(
    "change",
    async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        importData(text);
        toast("Sauvegarde importée.");
        // Recharge pour que toutes les vues reflètent les données importées.
        setTimeout(() => location.reload(), 600);
      } catch {
        toast("Import impossible : fichier invalide.");
      } finally {
        fileInput.value = ""; // permet de réimporter le même fichier
      }
    },
    { signal }
  );

  backupBtns.append(exportBtn, importBtn, fileInput);
  backupRow.append(backupBtns);
  backupGroup.append(backupRow);
  root.append(backupGroup);

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
