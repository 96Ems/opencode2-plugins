# Subagents Manager — plugin TUI opencode2

Plugin sidebar opencode2 (build A, next-17276) : liste les subagents de la
session courante, leur statut, leur durée d'exécution, et ouvre leur session
d'un clic pour discuter directement avec eux (micromanagement).

## Installation

Le plugin est déclaré globalement dans `~/.config/opencode/cli.json` :

```json
{
  "plugins": [
    "./plugins/tui-go-usage.tsx",
    "/home/emericclement/dev/subagents-manager/plugins/subagents-manager.tsx"
  ]
}
```

Dépendances installées localement (mêmes versions que le bundle du binaire) :

```sh
bun install   # @opentui/solid@0.4.5, @opentui/core@0.4.5, solid-js@1.9.10
```

Pas de hot-reload pour les plugins listés dans cli.json : **redémarrer le TUI**
(quitter et relancer `opencode2`) après toute modification.

## Fonctionnalités

- Section **Subagents** dans la sidebar (sous la section Contexte), visible
  uniquement quand la session courante a des enfants (`data.session.family()`).
- Une ligne par subagent : statut coloré (`▶` running, `✓` terminé, `✕`
  error, `–` interrompu), agent (ex. `explore`, `general`), titre de la tâche,
  et temps écoulé en direct pour les subagents en cours d'exécution.
- **Preview des derniers tools** : le dialog affiche les 4 derniers appels
  d'outils du subagent (nom + cible : path/pattern/commande…) chargés via
  `client.session.messages({ sessionID, limit, order: "desc" })`.
- **Input dans la session subagent** : le TUI remplace le prompt par le picker
  subagent quand on ouvre une session enfant — le plugin injecte un mini-input
  via le slot `session.composer.top` (monté inconditionnellement) : `return`
  envoie (steer si le subagent tourne, prompt normal sinon), `esc` quitte.
- Compteur "N active" dans le header, liste plafonnée à 8 lignes
  (`+N more`), enfants directs d'abord puis sous-subagents, plus récents en
  premier.

## API utilisée (contrat build A, vérifié dans le binaire next-17276)

| Besoin | API |
| --- | --- |
| Module | `export default { id, setup(ctx) }` — validé par `"setup" in U && typeof U.setup === "function"` |
| Rendu sidebar | `ctx.ui.slot({ append: "sidebar.content", render: (input) => ... })` — `input.sessionID` = session courante |
| Arbre des subagents | `ctx.data.session.family(sessionID)` → ids (session + descendants) |
| Statut / objet session | `ctx.data.session.status(id)` (`running`/`completed`/`cancelled`/`error`), `ctx.data.session.get(id)` (`parentID`, `title`, `agent`, `time.created`) |
| Événements | `ctx.data.on("session.execution.started", e => ...)` (`e.sessionID`, `e.created`) ; aussi `succeeded`/`failed`/`interrupted` |
| Navigation | `ctx.ui.router.navigate({ type: "session", sessionID })` |
| Clic | prop `onMouseDown` sur `box` |

## Pistes d'évolution

- Bouton **abort** par subagent : `ctx.client.session.interrupt({ sessionID })`
  (présent dans le SDK : `session.interrupt`, `session.prompt` avec
  `delivery: "steer" | "queue"`).
- Dialog de text input (`ctx.ui.dialog.show(...)`) pour steener un subagent
  sans quitter la session parente.
- Extension `home_prompt` / `session_prompt` slots pour le prompt rapide.

## Debug

- Vérifier la forme du module : `bun -e 'const m=(await import("./plugins/subagents-manager.tsx")).default; console.log(m.id, typeof m.setup)'`
- Logs : `~/.local/share/opencode/log/opencode.log` (filtrer `role=cli`),
  `OPENCODE_LOG_LEVEL=DEBUG` si besoin.
- Plugin manager : `ctrl+x` → commande `Plugins`.
