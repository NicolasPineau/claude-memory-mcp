export const VERSION = "2.0.0";

export const CHUNK = 900_000; // taille d'un morceau de fichier stocké en base (base64, multiple de 4)
export const CHUNK_BYTES = (CHUNK / 4) * 3; // octets bruts par morceau (multiple de 3)
export const MAX_FILE_MB = 20;
export const MAX_BYTES = MAX_FILE_MB * 1024 * 1024;

export const DL_TTL_MS = 60 * 60 * 1000; // lien de téléchargement : 1 h
export const UP_TTL_MS = 10 * 60 * 1000; // lien d'envoi : 10 min

export const INSTRUCTIONS = `Ce connecteur est la mémoire à long terme de l'utilisateur, partagée entre tous ses comptes, appareils et conversations. Utilise-le comme le ferait une personne qui se souvient.
1. Au début de la conversation SEULEMENT : appelle une fois \`list_projects\` avec \`noms_seulement: true\` (noms des projets et des tags, très court). Si, d'après ces seuls noms, la demande de l'utilisateur semble liée à un projet ou un thème existant, charge-le avec \`project_context\` (ou \`recall\` pour un tag). Sinon, n'insiste pas. Ensuite, ne consulte plus la mémoire de ta propre initiative pendant la conversation : seulement si l'utilisateur le demande (« regarde dans ta mémoire », « tu te souviens… », « on reprend le projet X »).
2. N'enregistre rien en cours de conversation. Une seule fois, à la fin (quand l'utilisateur dit « merci », « au revoir », « c'est tout », « on a fini » ou conclut autrement), si l'échange a produit quelque chose qui mérite d'être retenu (décisions, avancement d'un projet, faits utiles, idées), propose en une phrase d'en garder un résumé (ex. « Je garde un résumé de cette session dans ta mémoire ? ») et n'appelle \`remember\` qu'après son accord. Écris un souvenir autonome (compréhensible sans la conversation), avec un titre clair, un projet si pertinent et des tags thématiques (ex. bricolage, scoutisme).
3. À ce même moment, si l'échange est conséquent et qu'aucun projet n'a été identifié au début, propose de créer un projet (nom + courte description) avec \`set_project\` et d'y rattacher le résumé. Si un souvenir existant devient faux ou incomplet, propose de le mettre à jour (\`update_memory\`) plutôt que d'en créer un doublon.
4. Les fichiers importants peuvent être conservés avec \`attach_file\` (petits textes). Pour un fichier binaire ou volumineux, n'envoie pas son contenu : utilise \`prepare_upload\` (lien d'envoi pour curl) ou propose à l'utilisateur son interface d'administration (/admin), où il peut envoyer des fichiers. \`read_file\` renvoie par défaut un lien de téléchargement. \`delete_file\` efface un fichier (demande confirmation à l'utilisateur avant).
5. Tout projet appartient à un groupe (ex. « Perso », « Pro », « Perso › Scoutisme »). Pour créer un projet, choisis son groupe avec \`list_groups\` ; s'il n'est pas évident, demande-le à l'utilisateur. Un souvenir sans projet va dans le groupe indiqué, sinon dans le groupe par défaut de la clé. Tu ne vois que les groupes autorisés pour ce connecteur, certains en lecture seule.
Ne stocke jamais de mots de passe ou secrets.`;

export const STATUTS = ["actif", "en pause", "termine", "archive"];
