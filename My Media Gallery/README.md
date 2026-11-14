# My Media Gallery

A static, GitHub Pages-compatible media gallery that keeps the existing dark/purple interface and uses Firebase for authentication and metadata, Google Drive for new uploads, and Supabase Storage for legacy media.

## Included files

- `.firebaserc`, `firebase.json`: Firebase project/deployment configuration.
- `index.html`, `style.css`, `app.js`: website interface and application logic.
- `config.js`: public browser configuration.
- `firebase.js`: Firebase initialization.
- `404.html`: GitHub Pages not-found page.
- `.gitignore`: common local files to ignore.
- `supabase-setup.sql`: original Supabase schema/policy setup reference.

## Storage behavior

- Existing Firestore media records without `storage_provider: "google_drive"` are treated as legacy Supabase media.
- New uploads are sent to Google Drive using the Drive API resumable-upload protocol.
- New Google Drive files are shared as `Anyone with the link — Viewer`, so visitors can view them without signing in.
- Firestore stores the title, description, category, Drive file ID, MIME type, file size and public URL.
- When an administrator deletes a media card, the app deletes the binary file from its provider first and then deletes its Firestore record. If storage deletion fails, the Firestore record is kept.
- Visitor favorites remain in that visitor's browser local storage.

**Privacy:** This gallery is public. Do not upload private or sensitive material. Anyone with a published media link may be able to view or download it.

## Required services

1. Firebase Authentication and Firestore (existing project: `my-media-gallery-3f535`).
2. Google Drive API and OAuth web client (existing project configured by the site owner).
3. Supabase Storage for the existing legacy media only.

## Google Cloud setup

In the Google Cloud project that owns the OAuth Client ID:

1. Enable **Google Drive API**.
2. In Google Auth Platform → Branding, finish the app information.
3. In Google Auth Platform → Audience, add the storage Google account as a test user while the app is in Testing.
4. In Google Auth Platform → Data Access, add this scope only:

   `https://www.googleapis.com/auth/drive.file`

5. In Google Auth Platform → Clients, use a **Web application** client.
6. Add this Authorized JavaScript origin:

   `https://lovneupane-glitch.github.io`

   Do not add `/Lov/` to the origin. Do not add a redirect URI for this browser token flow.
7. Keep the OAuth app in Testing until you have tested it. Only listed test users can authorize it in Testing mode.

The browser uses Google Identity Services to request a short-lived access token when an administrator uploads or deletes a Drive file. The token is kept in page memory only. No Google Client Secret belongs in this repository.

## Firebase setup

The app expects:

- Firebase Authentication email/password sign-in enabled.
- Firestore collection `media_files`.
- Firestore document `site_info/developer` for the editable developer profile.
- The administrator Firebase UID configured in `config.js`.
- The administrator's Firebase custom claim `role: "authenticated"` because the current app checks that claim in addition to the UID.

The current Firestore rules used by this project should allow public reads and administrator-only create/update/delete for `media_files`, and public reads plus administrator-only writes for `site_info`. The rules must match the UID in `config.js`.

Example rules matching the current administrator UID:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /media_files/{document} {
      allow read: if true;
      allow create, update, delete: if request.auth != null
        && request.auth.uid == "he7YRHqvXlfwImoNZ6suNuu7XpJ2";
    }
    match /site_info/{document} {
      allow read: if true;
      allow create, update, delete: if request.auth != null
        && request.auth.uid == "he7YRHqvXlfwImoNZ6suNuu7XpJ2";
    }
  }
}
```

Do not make writes public. Do not put service-account keys, private keys, OAuth client secrets, or Firebase Admin credentials in this repository.

## Supabase legacy media

The project retains the existing Supabase URL in `config.js`. The uploaded source ZIP's `SUPABASE_ANON_KEY` value was identical to the Firebase administrator UID and could not be verified as a valid Supabase key, so the new `config.js` deliberately uses a setup placeholder. Legacy public media URLs can still render, but Supabase Storage deletion requires you to replace the placeholder with the real Supabase anon/publishable key from Supabase Project Settings → API.

Supabase deletion requires a valid Storage DELETE policy for the authenticated administrator session. The current browser code supplies the Firebase ID token to the Supabase client as in the original project. That works only if the Supabase project is configured to trust and authorize that Firebase JWT. If Supabase reports an authorization error, the app will keep the Firestore record and show the error rather than pretending the file was deleted. Do not use a Supabase `service_role` key in browser code.

The included `supabase-setup.sql` is the original setup reference and contains a placeholder UUID. Do not run it unchanged. Do not assume it matches the Firebase authentication setup without verifying the Supabase Auth/JWT configuration.

## Publish on GitHub Pages

1. Keep a backup of the currently published repository.
2. Extract this ZIP.
3. Upload the contents of the `My Media Gallery` folder to the repository root (not the containing folder).
4. Commit the changes to the branch configured for GitHub Pages (usually `main`).
5. Wait for GitHub Pages to publish, then open `https://lovneupane-glitch.github.io/Lov/`.
6. Test administrator sign-in, a small photo upload, visitor viewing, download, and deletion before trying larger files.

The `firebase.json` and `.firebaserc` are retained for Firebase Hosting/CLI workflows; GitHub Pages does not use them to publish the site.

## Upload limits and reliability

Google Drive's account quota is shared with other Google services. The usable quota is the amount actually available in the storage account, not automatically 15 GB. Google Drive also enforces per-user and API limits.

Uploads use 8 MiB chunks with Google's resumable-upload session protocol and query the session after interrupted requests to continue from the acknowledged byte position. Browser, network, API quota, account quota, and Google Drive limits still apply. Start with a small test file, then increase gradually. A successful 2 GB upload is not guaranteed merely because the account has enough free quota.

## Important implementation notes

- The Google Drive file is made link-viewable so the public gallery can display it.
- Drive's preview/playback behavior can differ by file type and size. Very large videos may be better served by a dedicated media CDN/object-storage service.
- If a Drive upload succeeds but the subsequent Firestore write fails, the uploaded Drive file is left in Drive (not automatically deleted) to avoid accidental data loss. The browser console logs its Drive file ID for recovery.
- This is a static client-side application. Security depends on Firebase Firestore rules, Google OAuth consent and Drive permissions, and Supabase policies. Never rely only on hiding administrator buttons in the browser.
