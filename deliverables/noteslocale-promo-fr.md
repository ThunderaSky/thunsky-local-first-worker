# NotesLocale — Paragraphe promotionnel (français)

**Statut :** livrable prêt pour relecture humaine — envoyé à personne, rien de publié.
**Généré par :** Local-First Worker (`pnpm local -- run`), modèle `qwen2.5:0.5b-instruct` sur Ollama local.
**Date :** 2026-10-17

## Workflow suivi ( borné, sans publication automatique )

1. Tâche `01M562EP9TADSVXD5KG48XVM2T` → artifact `local-runtime/artifacts/01M562EP9TADSVXD5KG48XVM2T.md`
2. Tâche `01M562PYDMTGCYEBFN3K4FT4C8` → artifact `local-runtime/artifacts/01M562PYDMTGCYEBFN3K4FT4C8.md`
3. Revue et édition manuelle (ci-dessous) — aucune publication, aucun envoi.

## Sortie brute du worker (verbatim)

**Draft 1** (tâche `01M562EP9…`):

> "NotesLocale, votre application de notes 100% hors-ligne, stocke tout en local sur votre PC.
> Ne vous inquiétez pas de l'incertitude de votre compte et de l'incapacité à accéder à
> l'information. Enregistrer vos notes, facile à utiliser, sans besoin de connexion internet.
> L'application vous permet de gérer vos notes de manière sécurisée et pratique. Ne ratez pas
> l'application NotesLocale, votre solution de notes 100% hors-ligne. Contactez-nous pour plus
> de détails et pour obtenir plus d'informations."

**Draft 2** (tâche `01M562PYDM…`, borné à 3 idées) :

> NotesLocale :
> - Tous les documents restent stockés sur votre PC local, ne vous en emettez pas sur internet.
> - L'application fonctionne de la première minute, n'ayez pas de compte à créer.
> - Elle fonctionne même sans connexion, dans le train ou l'avion.

## Revue humaine (édition finale proposée)

Le draft 2 couvre exactement les 3 idées demandées mais ignore le format paragraphe ; le draft 1
a le bon format mais sort des idées (« incertitude de votre compte ») et répète. Édition finale :

> NotesLocale garde vos notes exactement là où elles doivent être : sur votre PC. Rien n'est
> envoyé sur internet, aucun compte n'est à créer, et l'application est utilisable dès la
> première minute — sans connexion, dans le train comme en avion. Vos pensées restent les
> vôtres, stockées en local et prêtes dès que vous ouvrez l'application. Essayez NotesLocale :
> vos notes, enfin chez vous.

(≈ 60 mots, CTA « Essayez NotesLocale » — conforme aux contraintes.)

## Points de vigilance connus (modèle 0,5 Md)

- Sorties parfois hors format (listes au lieu d'un paragraphe) — vérification `verify.output`
  détecte le vide/échec, pas le style.
- Répétitions et locutions maladroites possibles : double relecture humaine recommandée avant
  tout usage commercial.