import { defineConfig } from "vite";

// Port figé (strictPort) : localStorage est lié à l'origine host:port.
// Sans port stable, un changement de port (5177 occupé → 5178, ou dev/preview
// sur des ports différents) crée une nouvelle origine et les stats semblent
// « remises à zéro ». On fixe donc le même port pour dev et preview, et on
// échoue franchement plutôt que de glisser silencieusement sur un autre port.
export default defineConfig({
  server: { port: 5177, strictPort: true },
  preview: { port: 5177, strictPort: true },
});
