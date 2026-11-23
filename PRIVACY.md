# Règles de confidentialité — Memory

Memory est un serveur personnel, utilisé par son seul auteur. Il n'est pas proposé au public.

## Données Google utilisées

Avec l'autorisation de l'utilisateur, Memory accède à **un seul agenda Google**, choisi par l'utilisateur, pour synchroniser ses rendez-vous :

- lecture et écriture des événements de cet agenda (titre, description, date et heure) ;
- lecture de la liste des agendas, uniquement pour permettre de choisir cet agenda.

## Stockage et partage

- Les données sont stockées dans la base privée de l'utilisateur (Cloudflare D1), accessible à lui seul.
- Le jeton d'accès Google est conservé dans cette base, n'est jamais exporté dans les sauvegardes et n'est transmis à aucun tiers.
- Aucune donnée n'est vendue, partagée ou utilisée à des fins publicitaires.

## Révocation

L'accès peut être retiré à tout moment depuis l'interface d'administration (« Déconnecter ») ou depuis https://myaccount.google.com/permissions.

## Contact

Via le dépôt : https://github.com/NicolasPineau/claude-memory-mcp
