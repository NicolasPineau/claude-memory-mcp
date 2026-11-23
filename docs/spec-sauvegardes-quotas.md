# Feat 2 — Sauvegardes automatiques et garde-fous de consommation

Statut : spec arrêtée le 23/11/2026, à implémenter. Cible : v3.0.0.

## 1. Besoin

- **Sauvegardes** : Time Travel de D1 ne remonte qu'à 7 jours sur le plan gratuit. On veut des copies complètes plus anciennes, hors de D1.
- **Garde-fous** : ne jamais dépasser les offres gratuites de Cloudflare. On compte tout et on refuse les appels avant d'atteindre les limites, avec des seuils volontairement en dessous des limites réelles, pour garder de la marge si les offres gratuites sont réduites.

## 2. Limites gratuites actuelles (vérifiées le 23/11/2026)

| Service | Limite gratuite | Période | Dépassement |
|---|---|---|---|
| Workers : requêtes | 100 000 | par jour (00:00 UTC) | erreurs, pas de facturation |
| Workers : CPU | 10 ms | par requête | erreur 1102 |
| D1 : lignes lues | 5 000 000 | par jour | requêtes en échec (depuis le 01/09/2026) |
| D1 : lignes écrites | 100 000 | par jour | requêtes en échec |
| D1 : taille d'une base | 500 Mo | — | écritures refusées |
| D1 : stockage du compte | 5 Go | — | — |
| D1 : Time Travel | 7 jours | — | — |
| R2 : stockage | 10 Go-mois | par mois | **facturé** (0,015 $/Go-mois) |
| R2 : opérations classe A (écritures) | 1 000 000 | par mois | **facturé** |
| R2 : opérations classe B (lectures) | 10 000 000 | par mois | **facturé** |
| Cron Triggers | 5 | par compte | — |

Sources : documentation Cloudflare (limites Workers, limites et tarifs D1, tarifs R2).

À retenir :
- Sur le plan gratuit, dépasser Workers ou D1 ne coûte rien, mais **bloque tout le compte** jusqu'à minuit UTC, y compris les autres Workers.
- **R2 est le seul service qui peut être facturé**, car son activation demande un moyen de paiement. C'est là que le garde-fou est le plus important.
- Les limites Workers et D1 sont **par compte**, pas par Worker : un autre projet sur le même compte consomme le même quota.

## 3. Garde-fous

### Seuils (proposition : 50 % des limites gratuites)

Chaque seuil est réglable par une variable d'environnement, sans redéploiement.

| Variable | Défaut | Limite réelle |
|---|---|---|
| `QUOTA_REQUESTS_DAY` | 50 000 | 100 000 |
| `QUOTA_D1_READS_DAY` | 2 500 000 | 5 000 000 |
| `QUOTA_D1_WRITES_DAY` | 50 000 | 100 000 |
| `QUOTA_D1_SIZE_MB` | 250 | 500 |
| `QUOTA_R2_STORAGE_GB` | 5 | 10 |
| `QUOTA_R2_CLASS_A_MONTH` | 500 000 | 1 000 000 |
| `QUOTA_R2_CLASS_B_MONTH` | 5 000 000 | 10 000 000 |

### Comptage

Deux approches possibles (voir §6) :

- **A. Compteurs maison dans D1** : une table `usage(periode, metrique, valeur)`. Le Worker additionne les `rows_read` et `rows_written` renvoyés par D1 à chaque requête, et compte les requêtes et les opérations R2. C'est simple, mais ça ne voit que ce Worker, et chaque requête coûte une écriture de plus.
- **B. API Analytics de Cloudflare (GraphQL)** : lit la consommation réelle **du compte entier** (requêtes, lignes D1, stockage et opérations R2), mise en cache quelques minutes. C'est exact et sans écriture supplémentaire, mais il faut un jeton d'API en lecture seule (secret `CF_API_TOKEN`) et les chiffres arrivent avec quelques minutes de décalage.

### Comportement quand un seuil est atteint

- **Connecteur MCP** : chaque outil répond « Quota du jour atteint (lignes D1 écrites : 50 000 / 50 000). Réessaie après minuit UTC. » Aucune requête D1 n'est faite.
- **Liens d'envoi et de téléchargement** : réponse 429 avec le même message.
- **Sauvegarde** : elle est sautée si elle ferait dépasser un seuil R2, et le saut est consigné.
- **`/admin`** : reste accessible pour voir la consommation, mais refuse les écritures.
- **Avertissement** à partir de 80 % d'un seuil :
  - une ligne est ajoutée à la fin de **la réponse de chaque outil MCP**, lectures comme écritures, par exemple « ⚠️ Quota : lignes D1 écrites 41 200 / 50 000 (82 %) aujourd'hui, remise à zéro à minuit UTC. » ;
  - la même ligne apparaît quand l'API Analytics ne répond pas (« ⚠️ Quota : consommation non vérifiée depuis HH:MM ») ;
  - les instructions du serveur (`INSTRUCTIONS`) demandent à Claude de **signaler toute ligne « ⚠️ Quota » à l'utilisateur** dans sa réponse ;
  - un bandeau s'affiche dans `/admin`.

### Tableau de bord dans `/admin`

Consommation du jour et du mois pour chaque métrique : valeur, seuil, limite réelle et pourcentage.

## 4. Sauvegardes

- **Fréquence** : une fois par semaine (proposition : dimanche à 03:00 heure de Paris).
- **Contenu** : export SQL complet de la base `memoire`, fichiers joints compris, compressé.
- **Destination** : un bucket R2 privé `memoire-sauvegardes`, fichiers `AAAA-MM-JJ.sql.gz`.
- **Rétention** : les 8 dernières sauvegardes (environ 2 mois), réglable par `BACKUP_KEEP`. Les plus anciennes sont supprimées (opération gratuite dans R2).
- **Dans `/admin`** : liste des sauvegardes (date, taille), téléchargement, et procédure de restauration documentée.

### Comment produire l'export (voir §6)

- **A. GitHub Actions** : un workflow planifié lance `wrangler d1 export` puis `wrangler r2 object put`. Le Worker n'est pas sollicité, donc la limite de 10 ms de CPU ne pose pas de problème. Il faut un secret `CLOUDFLARE_API_TOKEN` dans le dépôt : les secrets ne sont jamais visibles, même si le dépôt est public, et l'export ne passe jamais par GitHub.
- **B. Cron Trigger du Worker** : le Worker demande l'export à l'API D1, puis copie le fichier vers R2. Tout reste chez Cloudflare, mais il faut aussi un jeton d'API, et la limite de 10 ms de CPU impose de ne faire que de la copie, sans compression dans le Worker.

## 5. Critères d'acceptation

- [ ] Au-delà d'un seuil, tous les outils MCP refusent l'appel avec un message clair, sans requête D1.
- [ ] Entre 80 % et 100 % d'un seuil, chaque réponse d'outil MCP se termine par la ligne « ⚠️ Quota » avec la métrique concernée.
- [ ] Les seuils se règlent par variable d'environnement, sans redéploiement.
- [ ] `/admin` affiche la consommation et reste consultable quand un seuil est atteint.
- [ ] Une sauvegarde hebdomadaire arrive dans R2. Il n'en reste jamais plus que `BACKUP_KEEP`.
- [ ] Une sauvegarde qui ferait dépasser un seuil R2 n'est pas envoyée.
- [ ] Une sauvegarde restaurée sur une base vide redonne les mêmes données (test de restauration).

## 6. Décisions

| Question | Choix | Pourquoi |
|---|---|---|
| Comptage | **B. API Analytics de Cloudflare**, avec la consommation du compte mise en cache 5 minutes dans D1 (une écriture toutes les 5 min, soit environ 300 par jour) | Chiffres exacts et valables pour tout le compte, autres Workers compris. Les compteurs maison ne verraient que ce Worker, et chaque requête coûterait une écriture D1. Le décalage de quelques minutes est couvert par la marge de 50 %. |
| Si l'API Analytics ne répond pas | Le connecteur continue de servir (on garde les derniers chiffres connus, avec un avertissement dans `/admin`). La sauvegarde, elle, est annulée. | Une panne de l'API ne doit pas couper la mémoire. En revanche, rien ne s'écrit dans R2, le seul service facturable, sans chiffres fiables. |
| Export | **A. GitHub Actions** (`wrangler d1 export`, puis envoi dans R2) | Pas de limite de 10 ms de CPU, aucun code d'export à maintenir, gratuit pour un dépôt public. Le workflow ne journalise que des tailles et des noms de fichiers, jamais le contenu. |
| Rétention | **Règle de cycle de vie R2** : suppression automatique après 60 jours | Plus simple et plus sûr qu'un code de nettoyage. La suppression est gratuite. |
| Seuils | **50 % des limites gratuites** | Marge confortable si les offres gratuites baissent. Réglables à tout moment. |
| Comportement au seuil | **Tout est refusé** (lectures et écritures) jusqu'à la remise à zéro de la période | C'est la consigne : on compte tout et on refuse dès qu'un seuil est atteint. |
| Alertes | Ligne « ⚠️ Quota » dans **toutes** les réponses MCP dès 80 % d'un seuil, relayée à l'utilisateur par Claude. Bandeau dans `/admin` à 80 % et à 100 %. Pas d'e-mail maison. | Cloudflare envoie déjà un e-mail quand une limite D1 est atteinte. Inutile d'ajouter un service d'envoi. |

## 7. Prérequis côté Cloudflare (à faire par l'utilisateur)

1. Activer R2 et créer le bucket privé `memoire-sauvegardes`, avec une règle de cycle de vie « supprimer après 60 jours ».
2. Créer deux jetons d'API :
   - lecture seule Analytics (compte) : secret `CF_API_TOKEN` du Worker ;
   - D1 (lecture et export) et R2 (écriture sur le bucket) : secret `CLOUDFLARE_API_TOKEN` du dépôt GitHub, utilisé par le workflow.
