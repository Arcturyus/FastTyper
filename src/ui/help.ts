import { storage } from "../db";
import { el } from "./common";

const SEEN_KEY = "ft:onboarded";

/**
 * Overlay d'aide / onboarding : explique les codes couleur, les indices, le mode
 * entraînement et les raccourcis. Affiché automatiquement à la première visite,
 * rappelable à tout moment via le bouton « ? » de la barre du haut.
 */
export function mountHelp(): void {
  const overlay = buildOverlay();
  document.body.append(overlay);

  const open = (): void => {
    overlay.hidden = false;
  };
  const close = (): void => {
    overlay.hidden = true;
  };

  document.getElementById("help-btn")?.addEventListener("click", open);
  // clic sur le fond (hors carte) ou sur la croix → fermeture
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  overlay.querySelector(".help-close")?.addEventListener("click", close);
  document.addEventListener("keydown", (e) => {
    if (!overlay.hidden && e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  });

  // première visite : on présente le guide, puis on mémorise pour ne plus l'imposer
  if (!storage.getItem(SEEN_KEY)) {
    open();
    storage.setItem(SEEN_KEY, "1");
  }
}

function buildOverlay(): HTMLElement {
  const overlay = el("div", "help-overlay");
  overlay.hidden = true;

  const card = el("div", "help-card");
  const close = el("button", "help-close", "✕");
  close.setAttribute("aria-label", "Fermer l'aide");
  card.append(close);

  card.append(el("h2", "help-title gold-metal", "Bienvenue sur FastTyper"));
  card.append(
    el(
      "p",
      "help-lede",
      "Un entraîneur de frappe qui apprend de toi : il repère tes mots lents et fautés et te propose de les retravailler. Voici comment le lire."
    )
  );

  card.append(section("🎨 Couleur des mots = vitesse", [
    "Chaque mot déjà joué est teinté selon ta vitesse : du bronze foncé (tes mots les plus lents) au bronze cuivré, jusqu'à l'or brillant pour ton élite (top ~1 %).",
    "L'échelle s'adapte à TA répartition : la couleur situe le mot parmi les tiens, pas contre une norme absolue.",
  ]));

  card.append(section("🔴 Soulignement rouge = fautes", [
    "Un trait rouge sous une lettre marque l'endroit où tu te trompes le plus souvent. Plus il est épais, plus tu rates à cet endroit.",
    "En entraînement, il pointe les positions les plus fautées du mot ; en test normal, les bigrammes à risque.",
  ]));

  card.append(section("⚑ Entraînement ciblé", [
    "Le bouton « ⚑ Entraînement » cycle entre tes mots lents/fautés et tes bigrammes difficiles.",
    "Le bandeau « À retravailler » (en haut du test) et l'onglet Stats proposent une révision d'un mot précis : des fragments de plus en plus longs (2 lettres → moitié → mot entier), répétés là où tu fautes.",
    "À la fin d'une révision, un bilan « avant → après » chiffre tes progrès sur le mot.",
  ]));

  card.append(section("💡 Indices", [
    "Le bouton « 💡 Indices » affiche ou masque les surlignages de vitesse et de fautes.",
    "Masqués, ils ne biaisent plus ta frappe — utile pour mesurer ta vitesse « à froid » (voir l'onglet Biais des Stats).",
  ]));

  card.append(section("⏱ Rythme & ☠ Mort subite", [
    "« ⏱ Rythme » affiche un curseur fantôme calé sur ta médiane récente, puis ton record — pour te courser.",
    "« ☠ » active la mort subite : la moindre faute arrête le test.",
  ]));

  const keys = el("div", "help-keys");
  keys.append(el("h3", "help-h3", "⌨️ Raccourcis"));
  const kb = (k: string, d: string) => {
    const row = el("div", "help-kb");
    row.innerHTML = `<kbd>${k}</kbd><span>${d}</span>`;
    return row;
  };
  keys.append(
    kb("Tab / Échap", "recommencer un test"),
    kb("Ctrl + ⌫", "effacer le mot courant")
  );
  card.append(keys);

  const gotIt = el("button", "btn primary help-got", "C'est parti !");
  gotIt.addEventListener("click", () => (overlay.hidden = true));
  card.append(gotIt);

  overlay.append(card);
  return overlay;
}

function section(title: string, paras: string[]): HTMLElement {
  const box = el("div", "help-section");
  box.append(el("h3", "help-h3", title));
  for (const p of paras) box.append(el("p", "help-p", p));
  return box;
}
