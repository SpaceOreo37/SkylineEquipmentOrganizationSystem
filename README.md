# Skyline EOS — Equipment Organization System

A web app for Skyline's science department to track equipment loans (check-in / check-out). Built for ~12 teachers with plain HTML, CSS, and vanilla JS — no build tools, no frameworks.

## Stack

- **Frontend:** Plain HTML + CSS + vanilla JS (ES modules)
- **Auth:** Firebase Authentication (Email/Password)
- **Database:** Firebase Firestore
- **Hosting:** Vercel (static, auto-deploys from GitHub)

## Project structure

```
index.html          — single page; toggles between login and dashboard views
styles.css
js/
  firebase-init.js  — Firebase app init; exports `auth` and `db`
  auth.js           — signIn / signOut wrappers
  firestore.js      — Firestore read helpers
  app.js            — entry point; wires UI to auth + firestore
firestore.rules     — paste into Firebase console → Firestore → Rules
```

## Running locally

Because the JS files use `import` (ES modules), browsers block them when you open `index.html` as a `file://` URL — you must serve them over HTTP.

Any of these one-liners work from the project root:

```bash
# Python 3 (usually pre-installed on macOS/Linux)
python3 -m http.server 8000

# Node.js (if installed)
npx serve .

# VS Code — install the "Live Server" extension, then click "Go Live"
```

Then open `http://localhost:8000` in your browser.

## Firebase setup checklist

1. **Authentication** — Firebase console → Authentication → Sign-in method → enable **Email/Password**. Create teacher accounts manually under the Users tab.

2. **Firestore** — Firebase console → Firestore Database → Create database. Start in production mode.

3. **Security rules** — Paste the contents of `firestore.rules` into Firebase console → Firestore → Rules → Publish.

4. **Firebase SDK version** — The app currently imports `v11.0.0` from the gstatic CDN. To use a different version, do a find-and-replace of `11.0.0` across all files in `js/`. Check [firebase.google.com/docs/web/setup](https://firebase.google.com/docs/web/setup) for the latest CDN snippet.

## Data model

### `equipment` collection

| Field      | Type   | Values                        |
|------------|--------|-------------------------------|
| `name`     | string | e.g. `"Bunsen Burner"`        |
| `category` | string | e.g. `"Heat Sources"`         |
| `status`   | string | `"available"` \| `"checked-out"` |
| `location` | string | e.g. `"Cabinet A3"`           |

### `checkouts` collection

| Field              | Type      | Notes                     |
|--------------------|-----------|---------------------------|
| `equipmentId`      | string    | doc ID from `equipment`   |
| `teacherEmail`     | string    |                           |
| `checkoutDate`     | timestamp |                           |
| `expectedReturn`   | timestamp |                           |
| `actualReturn`     | timestamp | `null` until returned     |

## Deploying to Vercel

1. Push the repo to GitHub.
2. Import the repo on [vercel.com](https://vercel.com) — no build command, output directory is `/` (root).
3. Every push to `main` auto-deploys.
