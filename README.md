# FastTyper

Petit site perso de vitesse de frappe, inspiré de [Monkeytype](https://github.com/monkeytype/monkeytype). Mais je voulais plus de fonctionnalités  :  entrainements ciblés,  mots les plus fautés, les plus lents, couleurs adaptés à la vitesse par mots, stats sur les lettres et bi lettres les plus fautés ou lentes...

## Lancer

```bash
npm install
npm run dev      # http://localhost:5177 (fixe vu que sauvergarde en local storage)
npm run build    # production dans dist/
```

## Fonctionnalités

- **Test de frappe** : 10/25/50 mots, listes français (200/1k) et anglais (200/1k), gestion des accents et touches mortes (input caché + composition), caret, Tab/Échap pour recommencer.
- **Stats par mot** (localStorage, par langue) : essais, WPM moyen, % d'essais fautés, erreurs cumulées. Table triable et filtrable dans l'onglet **Stats**.
- **Bigrammes** : délai moyen entre chaque paire de lettres et taux d'erreur — top des paires les plus lentes et les plus fautées.
- **Coloration pendant le test** : fond orangé = mot historiquement lent, fond vert = mot rapide, soulignement rouge = mot souvent fauté. Seuils et mode (vitesse/erreurs/les deux/off) réglables dans **Réglages**.
- **Mode entraînement** (⚑) : génère un test à partir des pires mots (seuils configurables), les pires revenant plus souvent. Depuis l'écran de résultats, on peut aussi s'entraîner directement sur les mots ratés du test.
- **Résultats** : WPM net/brut, précision, courbe WPM par seconde avec survol, détail mot par mot.
- **Export / import JSON** des données, remise à zéro.

...

## Structure

```
src/
  engine.ts       moteur du test (frappes, timing par mot, bigrammes, résultat)
  store.ts        persistance localStorage + agrégation des stats
  wordlist.ts     génération de mots (normale + entraînement pondéré)
  config.ts       réglages utilisateur
  ui/             vues : test, résultats (courbe SVG), stats, réglages
  words/          listes de mots extraites de monkeytype
```
