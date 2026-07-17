/**
 * Façade de stockage SYNCHRONE adossée à IndexedDB.
 *
 * Tout le reste de l'app lit/écrit des clés `ft:*` de manière synchrone (comme
 * avec localStorage). On garde donc un cache mémoire (Map) chargé une fois au
 * démarrage via {@link initDb} ; les écritures se font en write-through vers
 * IndexedDB en arrière-plan. IndexedDB lève le plafond ~5 Mo de localStorage,
 * ce qui compte pour le journal brut (jusqu'à 1500 tests × mots par famille).
 *
 * IMPORTANT : appeler `await initDb()` avant tout accès (fait dans main.ts).
 */

const DB_NAME = "fasttyper";
const STORE = "kv";
const IDB_VERSION_KEY = "ft:idbVersion";

const CACHE = new Map<string, string>();
let idb: IDBDatabase | null = null;

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function loadAll(db: IDBDatabase): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (cur) {
        CACHE.set(String(cur.key), String(cur.value));
        cur.continue();
      } else resolve();
    };
    req.onerror = () => reject(req.error);
  });
}

function writeThrough(key: string, value: string): void {
  if (!idb) return;
  try {
    idb.transaction(STORE, "readwrite").objectStore(STORE).put(value, key);
  } catch {
    // transaction impossible (fermeture, quota…) : le cache mémoire reste juste
  }
}

/**
 * Migration unique localStorage → IndexedDB : recopie les clés `ft:*` puis les
 * purge de localStorage. IndexedDB fait foi (on n'écrase pas une clé déjà en
 * cache). Idempotente grâce au drapeau {@link IDB_VERSION_KEY}.
 */
function migrateFromLocalStorage(): void {
  if (CACHE.get(IDB_VERSION_KEY) === "1") return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("ft:")) keys.push(k);
    }
    for (const k of keys) {
      const v = localStorage.getItem(k);
      if (v !== null && !CACHE.has(k)) {
        CACHE.set(k, v);
        writeThrough(k, v);
      }
    }
    for (const k of keys) localStorage.removeItem(k);
  } catch {
    // localStorage inaccessible : rien à migrer
  }
  CACHE.set(IDB_VERSION_KEY, "1");
  writeThrough(IDB_VERSION_KEY, "1");
}

export async function initDb(): Promise<void> {
  try {
    idb = await openIdb();
    await loadAll(idb);
  } catch {
    // IndexedDB indisponible (navigation privée stricte) : cache mémoire seul,
    // alimenté par localStorage sans persistance IDB.
    idb = null;
  }
  migrateFromLocalStorage();
}

/** Mime l'API localStorage, mais sert le cache mémoire (voir en-tête du module). */
export const storage = {
  getItem(key: string): string | null {
    return CACHE.has(key) ? (CACHE.get(key) as string) : null;
  },
  setItem(key: string, value: string): void {
    CACHE.set(key, value);
    writeThrough(key, value);
  },
  removeItem(key: string): void {
    CACHE.delete(key);
    if (!idb) return;
    try {
      idb.transaction(STORE, "readwrite").objectStore(STORE).delete(key);
    } catch {
      // ignore
    }
  },
};
