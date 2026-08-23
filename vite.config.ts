import { defineConfig } from "vite";

// Port figé (strictPort) : localStorage est lié à l'origine host:port.
// Sans port stable, un changement de port (5177 occupé → 5178, ou dev/preview
// sur des ports différents) crée une nouvelle origine et les stats semblent
// « remises à zéro ». On fixe donc le même port pour dev et preview, et on
// échoue franchement plutôt que de glisser silencieusement sur un autre port.
export default defineConfig({
  // Chemins relatifs : l'app doit tourner aussi bien à la racine d'un domaine
  // qu'à la racine d'un sous-chemin (GitHub Pages sert le projet sous
  // /FastTyper/). Avec `base: "./"`, les assets, le manifeste et le service
  // worker se résolvent depuis la page courante — aucun chemin absolu « / » à
  // maintenir en double entre le dev local et la production.
  base: "./",
  server: { port: 5177, strictPort: true },
  preview: { port: 5177, strictPort: true },
});
