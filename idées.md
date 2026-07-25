# Idées d'améliorations — FastTyper

- [x] ajouter les english francais 5k mots les plus utilisés
- [x] dans les stats cochés de base, il y a normal pas entrainmeent et francais anglais pas code
- [x] Sur toutes la partie stats mots : faire en sorte que le click sur un mot propose un test entrâinement spécifique à ce mot (reproduire juste les bigrammes de deux lettres qui coincent sur ce mot, puis le mots complet)

- [x] La confusion sur l'écran de stats bigrammes pourrait ajouter quelle type de faute : substitution, transposition, omission, insertion
- [x] mettre 2 chiffres post virgules sur le hover du graph dans stats : Progression du WPM 

## Pour aider les utilisateurs à progresser

- [ ] **Coach au démarrage** : bandeau discret sur l'écran de test qui propose un entraînement ciblé sur les 3 pires mots du moment (réutiliser le pool `practicePool` / « Priorités d'entraînement » de l'onglet Mots). Un clic → lance directement le drill.
- [ ] **Répétition espacée** des mots difficiles : refaire remonter un mot travaillé à intervalles croissants (aujourd'hui, +2 j, +1 sem.) à la manière d'Anki, au lieu de repondérer seulement sur le taux de faute. S'appuyer sur `WordStat.last` + un score de rappel.
- [ ] **Bilan avant/après drill** : à la fin d'une révision lancée depuis Stats (`drillWord`), afficher « ce mot est passé de X → Y wpm » et « −N fautes » pour rendre l'effort tangible (données déjà dans la timeline du mot).
- [ ] **Onboarding / aide « ? »** : overlay expliquant les codes couleur (bronze→or = vitesse, soulignement rouge = fautes), les indices, le mode entraînement et les raccourcis. Affiché à la première visite, rappelable via un bouton « ? ».



