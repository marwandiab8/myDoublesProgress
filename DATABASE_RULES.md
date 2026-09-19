# Realtime Database Rules

The app stores everything in the Realtime Database under `/users/{uid}`:

| Path | Contents |
| --- | --- |
| `users/{uid}/state/activeSession` | The round in progress (timer, cursor, per-double attempts). |
| `users/{uid}/state/lifetime` | Lifetime attempts and hits per double. |
| `users/{uid}/sessions/{sessionKey}` | One row per finished round (history). |

`state` is kept apart from `sessions` so the transaction and listener that run on every throw never load or
rewrite the growing history. Data from before this split (`users/{uid}/activeSession` and
`users/{uid}/lifetime`) is moved into `state` by the page the first time a user signs in.

`database.rules.json` lets a signed-in user read and write only their own `users/{uid}` node, denies
everything else, and indexes `sessions` by `startedAtMs` (the "From" date and heatmap queries order by it;
without the index the client downloads every session and filters locally). The Cloud Functions use the Admin
SDK, which bypasses these rules.

## Before deploying the rules

The rules in this repo were written without seeing the ones currently live. In the Firebase console
(Realtime Database → Rules) compare them with `database.rules.json`, and keep anything the app relies on that
this file doesn't cover.

Then deploy only the rules with:

```bash
firebase deploy --only database --project mydoublesprogress
```

A plain `firebase deploy` (no `--only`) also deploys these rules.
