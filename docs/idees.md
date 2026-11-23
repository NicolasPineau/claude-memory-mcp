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

- **Tâche** = souvenir avec : type de tâche, niveau de criticité, statut (`a_faire` / `silencieux` / `fait` / `annule`), échéance (date + heure facultative), récurrence facultative, `fait_le`.
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
- Boutons d'action sur la notification (ntfy : 3 boutons maximum) :
  - **Fait** : action `http` vers le Worker ;
  - **Vu** : action `http`, accuse réception (arrête les relances), la tâche reste à faire ;
  - **Repousser…** : action `view` qui ouvre la page mobile sur les choix de report, paramétrables dans `/admin` (au départ +1 h, ce soir 18 h, demain matin, +1 semaine). Repousser **décale l'échéance** elle-même.
  - Toucher la notification (`click`) ouvre la même page en mode modification (ntfy ne permet pas de saisir du texte dans la notification).
- Liens des actions et de la page d'édition : **jetons signés**, limités à une tâche, avec expiration (pas de Cloudflare Access, pour un accès en un clic).

### Rendez-vous ↔ Google Agenda

- Synchro **bidirectionnelle côté serveur** (OAuth Google sur le Worker, voir « Décisions du lot 3 ») avec un agenda dédié que l'utilisateur va créer.
- RDV supprimé dans Google → statut `annule` dans Memory (historique conservé, ne remonte plus).
- Les RDV ont aussi une criticité et les alertes ntfy correspondantes (les rappels Google peuvent rester actifs en plus).

### Découpage

1. **Lot 1** : modèle, admin des types et niveaux, rappels au démarrage. **Prêt pour le dev** (décisions ci-dessous).
2. **Lot 2** : alertes ntfy (Cron, actions, page d'édition). **Prêt pour le dev.**
3. **Lot 3** : synchro Google Agenda. **Prêt pour le dev.**

### Décisions du lot 1 (23/11/2026)

- **Stockage** : table dédiée `taches` (statut, échéance, heure facultative, criticité, type, récurrence, `fait_le`), liée à son souvenir (texte, projet, tags, groupe). Les types et niveaux vont dans leurs propres tables, administrables.
- **Récurrence** : une ligne par occurrence. L'occurrence cochée reste `fait` avec sa date, et une nouvelle ligne est créée pour la suivante (historique complet).
- **Droits des clés** : les tâches suivent les groupes de la clé (règle actuelle). L'interface des clés gagne une case « affiche les rappels » : une clé peut accéder aux tâches sans qu'elles s'affichent d'office au démarrage.
- **Outils MCP dédiés** : `add_task`, `update_task` (statut, échéance, report, criticité…) et `list_tasks` (filtres : statut, période, criticité, projet).
- **Plafond au démarrage** : réglable dans `/admin`, **5 par défaut**. Au-delà, une ligne « + N autres » renvoie vers `list_tasks`.
- **Statut `silencieux`** : statuts possibles `a_faire` / `silencieux` / `fait` / `annule`. Une tâche silencieuse reste à faire et visible dans `list_tasks`, mais ne déclenche aucun rappel : ni au démarrage, ni alerte ntfy. On la réactive en la repassant à `a_faire`.

### Économie de tokens (exigence transverse)

Tout ce que le serveur renvoie à Claude doit être aussi court que possible :
- **Démarrage** : section « Rappels » omise si elle est vide. Une ligne par tâche, sans le texte complet du souvenir : `#12 !! Appeler le plombier — 25/11 14h` (`!!` critique, `!` normale, rien pour basse ; « retard » si dépassée). Dates courtes, sans l'année si c'est l'année en cours.
- **`list_tasks`** : même format compact par défaut ; le détail complet seulement via un paramètre explicite ou `read_memory`.
- **`add_task` / `update_task`** : réponse minimale (`ok #12`, plus la date de l'occurrence suivante pour une récurrence), sans renvoyer la tâche.
- **Descriptions d'outils et `INSTRUCTIONS`** : phrases courtes, sans exemples superflus (elles sont envoyées à chaque conversation).
- **Annonce par Claude** : les `INSTRUCTIONS` demandent de reprendre les rappels en une ou deux lignes, sans commentaire.

### Décisions du lot 2 (23/11/2026)

- **ntfy.sh public**, topic secret (longue chaîne aléatoire) stocké en secret Worker, jamais dans le code.
- **Cron toutes les 15 minutes** (96 exécutions par jour, requête D1 indexée). Les heures d'échéance et les reports se calent sur ce pas.
- **Fuseau** : échéances et plages stockées en heure de Paris (`Europe/Paris`), conversion depuis l'UTC du Cron avec gestion de l'heure d'été.
- **Plage d'alerte par niveau de criticité**, réglable dans `/admin` (ex. normale 7 h–minuit, critique 24 h/24). Une alerte qui tombe hors plage part au début de la plage suivante.
- **Relances par niveau**, réglables dans `/admin` (ex. critique : toutes les heures jusqu'à Vu ou Fait ; normale : une fois ; basse : jamais).
- Boutons **Fait / Vu / Repousser…** et page mobile au toucher : voir « Alertes (ntfy) ».

### Décisions du lot 3 (23/11/2026)

- **Synchro entrante par le Cron** (toutes les 15 min), avec la synchro incrémentale de Google (`syncToken`) : seuls les changements sont lus. Pas de webhook.
- **Conflit** : la dernière modification gagne (comparaison des dates de modification des deux côtés).
- **RDV créé dans Google** : groupe, projet et criticité par défaut réglables dans `/admin` (au départ : groupe Perso, sans projet, criticité normale), modifiables ensuite.
- **OAuth** : bouton « Connecter Google » dans `/admin`, route de retour sur le Worker qui stocke le jeton de rafraîchissement ; reconnexion en un clic si l'accès est révoqué. Prérequis : projet Google Cloud avec l'app en mode « Production » (en mode « Test », l'autorisation expire au bout de 7 jours). Scope limité à l'agenda.

### Contraintes techniques (tous lots)

- Plan gratuit : 10 ms de CPU par requête, nombre de Cron Triggers limité (un seul Cron pour les lots 2 et 3), `checkQuota()` sur les nouvelles routes (actions ntfy, page mobile, retour OAuth).
- Nouvelles tables à ajouter à `EXPORT_TABLES` (sauvegarde), sauf les jetons et l'état de synchro si on préfère ne pas les sauvegarder.
- Secrets (topic ntfy, client OAuth Google) en secrets Worker uniquement.
