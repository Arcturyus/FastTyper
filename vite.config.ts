import { defineConfig } from "vite";

// Port figé (strictPort) : localStorage est lié à l'origine host:port.
// Sans port stable, un changement de port (5173 occupé → 5174, ou dev/preview
// sur des ports différents) crée une nouvelle origine et les stats semblent
// « remises à zéro ». On fixe donc le même port pour dev et preview, et on
// échoue franchement plutôt que de glisser silencieusement sur un autre port.
export default defineConfig({
  server: { port: 5173, strictPort: true },
  preview: { port: 5173, strictPort: true },
});
