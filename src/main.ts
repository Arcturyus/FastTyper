import "./style.css";
import { initDb } from "./db";
import { initStore } from "./store";
import { mountTestView } from "./ui/test-view";
import { mountStatsView } from "./ui/stats-view";
import { mountSettingsView } from "./ui/settings-view";

type Route = "test" | "stats" | "settings";

const view = document.getElementById("view");
if (!view) throw new Error("élément #view introuvable");

let controller: AbortController | null = null;

function currentRoute(): Route {
  const hash = location.hash.replace("#", "");
  if (hash === "stats" || hash === "settings") return hash;
  return "test";
}

function render(): void {
  controller?.abort();
  controller = new AbortController();
  const route = currentRoute();

  for (const link of document.querySelectorAll<HTMLAnchorElement>("nav a")) {
    link.classList.toggle("active", link.dataset["route"] === route);
  }

  const root = view as HTMLElement;
  switch (route) {
    case "stats":
      mountStatsView(root, controller.signal);
      break;
    case "settings":
      mountSettingsView(root, controller.signal);
      break;
    default:
      mountTestView(root, controller.signal);
  }
}

initDb().then(() => {
  initStore();
  window.addEventListener("hashchange", render);
  render();
});

// PWA : installe le service worker pour un fonctionnement hors-ligne
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // enregistrement impossible (contexte non sécurisé, etc.) : l'app reste en ligne
    });
  });
}
