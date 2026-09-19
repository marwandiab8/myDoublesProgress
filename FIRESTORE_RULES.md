# Firestore Rules

Firebase reported that the Cloud Firestore database was still using expired Test Mode rules. The app code currently uses Firebase Authentication with Realtime Database paths under `/users/{uid}` and does not use any client Firestore collections.

For production safety, `firestore.rules` denies all client Firestore reads and writes. This keeps Firestore private instead of extending Test Mode or opening unused collections.

Deploy only the Firestore rules with:

```bash
firebase deploy --only firestore:rules --project mydoublesprogress
```
