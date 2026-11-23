# Idées à discuter

Pistes notées par l'utilisateur, **pas encore cadrées** : à discuter avec lui (interview) avant toute spec ou tout code.

## Timeline (notée le 23/11/2026)

Une vue chronologique dans `/admin` pour visualiser l'évolution de la mémoire dans le temps :
- icônes pour distinguer les types d'éléments (fichiers, souvenirs, souvenirs « importants »…) ;
- reste à définir : ce qui rend un souvenir « important », les filtres (groupe, projet, tags), l'échelle de temps, et si la vue sert aussi à Claude via MCP.

## Tâches, rappels et rendez-vous (cadrée le 23/11/2026)

Périmètre validé avec l'utilisateur lors d'une interview. Priorité : les rappels.

### Objectif

- Dès qu'une conversation démarre, quel que soit le sujet, Claude annonce d'abord les tâches du jour, en retard et à venir (surtout les critiques).
- Les tâches datées déclenchent une alerte sur le téléphone (Android) selon leur criticité.
- Les rendez-vous se synchronisent dans les deux sens avec un agenda Google dédié.

### Modèle

- **Tâche** = souvenir avec : type de tâche, niveau de criticité, statut (`a_faire` / `fait` / `annule`), échéance (date + heure facultative), récurrence facultative, `fait_le`.
- **Types de tâche**, administrables dans `/admin` (ajout, modification, suppression) : au départ « Tâche » et « Rendez-vous ». Un type porte son comportement de synchro (ex. « Rendez-vous » = synchro avec l'agenda Google dédié).
- **Niveaux de criticité**, administrables dans `/admin` : au départ critique / normale / basse. Chaque niveau définit :
  - l'horizon d'affichage : combien de jours avant l'échéance la tâche remonte en début de conversation (ex. critique 7 j, normale 3 j, basse 0 j) ;
  - l'alerte : aucune / notification ntfy / alarme ntfy (priorité max, sonne en boucle).
- Suppression d'un type ou d'un niveau : l'admin choisit le type ou niveau vers lequel basculer les tâches existantes.
- Le type de projet « rappels » envisagé au départ est **abandonné** : toute tâche datée remonte, quel que soit son projet.
- Migration : les souvenirs de type `tache` existants (projet « Choses à penser ») passent en `a_faire`, criticité « normale », sans échéance (à confirmer).

### Récurrence

- Simple : tous les N jours / semaines / mois / ans (pas de RRULE).
- Quand une occurrence est cochée « fait », la suivante est créée à la **prochaine date prévue** (loyer le 5, fait le 8 → suivante le 5 du mois suivant).

### Début de conversation

- `list_projects` avec `noms_seulement: true` (déjà appelé au démarrage) renvoie en plus une section « Rappels » : tâches en retard, du jour, et à venir selon l'horizon de leur niveau ; tri par criticité puis échéance.
- `INSTRUCTIONS` (`src/config.js`) : Claude annonce ces rappels en premier, quel que soit le sujet ; il passe une tâche à `fait` quand l'utilisateur le dit.
- Ce qui remonte dépend des **droits de la clé** : l'interface de génération des clés dans `/admin` doit permettre de régler quelles tâches une clé voit (ex. compte pro Nodevo sans les tâches perso).

### Alertes (ntfy)

- Un Cron Trigger du Worker envoie les alertes à l'heure de l'échéance. Sans heure : heure fixe le matin, réglable dans `/admin` (ex. 8 h).
- Android, app ntfy : priorité max + option « continuer à alerter » pour l'alarme des tâches critiques.
- Boutons d'action sur la notification :
  - **Fait** : action `http` vers le Worker ;
  - **Reporter** : choix paramétrables dans `/admin` (au départ +1 h, ce soir 18 h, demain matin, +1 semaine) ;
  - **Modifier** : action `view` qui ouvre une petite page mobile d'édition (ntfy ne permet pas de saisir du texte dans la notification).
- Liens des actions et de la page d'édition : **jetons signés**, limités à une tâche, avec expiration (pas de Cloudflare Access, pour un accès en un clic).

### Rendez-vous ↔ Google Agenda

- Synchro **bidirectionnelle côté serveur** (OAuth Google sur le Worker, jeton de rafraîchissement en secret) avec un agenda dédié que l'utilisateur va créer.
- RDV supprimé dans Google → statut `annule` dans Memory (historique conservé, ne remonte plus).
- Les RDV ont aussi une criticité et les alertes ntfy correspondantes (les rappels Google peuvent rester actifs en plus).

### Découpage

1. **Lot 1** : modèle, admin des types et niveaux, rappels au démarrage. **Prêt pour le dev** (décisions ci-dessous).
2. **Lot 2** : alertes ntfy (Cron, actions, page d'édition).
3. **Lot 3** : synchro Google Agenda.

### Décisions du lot 1 (23/11/2026)

- **Stockage** : table dédiée `taches` (statut, échéance, heure facultative, criticité, type, récurrence, `fait_le`), liée à son souvenir (texte, projet, tags, groupe). Les types et niveaux vont dans leurs propres tables, administrables.
- **Récurrence** : une ligne par occurrence. L'occurrence cochée reste `fait` avec sa date, et une nouvelle ligne est créée pour la suivante (historique complet).
- **Droits des clés** : les tâches suivent les groupes de la clé (règle actuelle). L'interface des clés gagne une case « affiche les rappels » : une clé peut accéder aux tâches sans qu'elles s'affichent d'office au démarrage.
- **Outils MCP dédiés** : `add_task`, `update_task` (statut, échéance, report, criticité…) et `list_tasks` (filtres : statut, période, criticité, projet).
- **Plafond au démarrage** : réglable dans `/admin`, **5 par défaut**. Au-delà, une ligne « + N autres » renvoie vers `list_tasks`.

### Questions à trancher pour les lots 2 et 3

- Lot 2 : ntfy.sh public (topic secret) ou instance auto-hébergée, authentification ; précision du Cron (1 ou 5 min) ; fuseau horaire (échéances en Europe/Paris, Cron en UTC, heure d'été) ; « Reporter » modifie l'échéance ou un champ « prochaine alerte » ; répétition d'une alarme ignorée.
- Lot 3 : mise en place d'OAuth (projet Google Cloud, consentement, refresh token depuis `/admin`) ; criticité, projet et groupe par défaut d'un RDV créé directement dans Google.

### Points ouverts

- Synchro Google : webhook `watch` (temps réel, canal à renouveler) ou interrogation périodique par le Cron (plus simple, quelques minutes de délai).
- Conflit si un RDV est modifié des deux côtés : la dernière modification gagne ?
- Contraintes du plan gratuit : 10 ms de CPU par requête, nombre de Cron Triggers, quotas (`checkQuota()` sur les nouvelles routes).
- Nouvelles tables à ajouter à `EXPORT_TABLES` (sauvegarde).
