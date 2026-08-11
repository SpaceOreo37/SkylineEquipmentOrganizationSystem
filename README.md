# Skyline EOS — Equipment Organization System

A web app for Skyline's science department to track equipment loans (check-in / check-out). Built for ~12 teachers with plain HTML, CSS, and vanilla JS — no build tools, no frameworks.

## Stack

- **Frontend:** Plain HTML + CSS + vanilla JS (ES modules)
- **Auth:** Firebase Authentication (Email/Password)
- **Database:** Firebase Firestore
- **Hosting:** Vercel (static, auto-deploys from GitHub)

## Project structure

```
index.html            — sign-in page
inventory.html        — section cards + all-equipment search
sections/section.html — equipment types within one section
checkout.html         — check-out form
dashboard.html        — your active checkouts + department overview
styles.css
js/
  firebase-init.js    — Firebase app init; exports `auth` and `db`
  auth.js             — signIn / signOut wrappers
  firestore.js        — all Firestore reads/writes
  ui-common.js        — shared helpers: escaping, toasts, caches, profile
  app.js              — sign-in page
  inventory.js        — inventory.html
  section.js          — sections/section.html
  checkout.js         — checkout.html
  dashboard.js        — dashboard.html
firestore.rules       — paste into Firebase console → Firestore → Rules
```

Every page's HTML and JS is loaded with a `?v=N` query string. Bump `N`
across all files together whenever page structure and script change in the
same commit — it busts stale browser caches, and each page's version-skew
guard shows a "hard-refresh required" banner if the two ever mismatch.

Note the one gap: the `.html` files themselves are plain URLs with no `?v=`,
so a browser holding a cached copy of a page will keep asking for the *old*
`styles.css?v=N-1` and render a version behind. If one page looks stale after
a deploy while the others updated, hard-refresh it (`Cmd`/`Ctrl`+`Shift`+`R`).

Layout is driven by two custom properties. `--content-width` (1440px) is the
column for the list pages, applied to `<main>` and mirrored in the header's
padding so the bar stays full-bleed while its contents stay aligned to the
same column. `--content-width-narrow` (540px) is opted into per page with
`<main class="main--narrow">` — currently just the checkout form.

`inventory.html` and `dashboard.html` are the two top-level tabs and carry
the centred `<nav class="tabs">` bar in their header. `checkout.html` and
`sections/section.html` are flow / drill-down pages: no tabs, just a
`.back-btn` out. To add a third tab, copy the `<nav class="tabs">` block into
each page and move `aria-current="page"` onto the link for the page you are
editing — that attribute is what both the active styling and the screen
reader state key off.

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

Equipment is modelled in two collections: one document per *type* of thing
(`equipmentTypes`), and one document per physical *unit* of it
(`equipmentUnits`). Units are what get checked out.

### `equipmentTypes` collection

| Field      | Type   | Notes                            |
|------------|--------|----------------------------------|
| `name`     | string | e.g. `"Bunsen Burner"`           |
| `section`  | string | e.g. `"Chemistry"` — groups the inventory page |
| `category` | string | optional sub-grouping            |

### `equipmentUnits` collection

One document per physical item.

| Field        | Type   | Notes                                  |
|--------------|--------|----------------------------------------|
| `typeId`     | string | doc ID from `equipmentTypes`           |
| `status`     | string | `"available"` \| `"checked-out"`       |
| `homeRoom`   | string | room the unit normally lives in        |
| `assignedTo` | string | teacher uid while checked out, else absent |
| `checkoutId` | string | doc ID from `checkouts` while out      |

### `checkouts` collection

| Field                | Type      | Notes                                     |
|----------------------|-----------|-------------------------------------------|
| `teacherUid`         | string    | Firebase Auth uid                         |
| `teacherName`        | string    | denormalised for display                  |
| `equipmentTypeId`    | string    | doc ID from `equipmentTypes`              |
| `equipmentTypeName`  | string    | denormalised for display                  |
| `unitIds`            | string[]  | units taken out                           |
| `returnedUnitIds`    | string[]  | subset already brought back               |
| `quantity`           | number    | `unitIds.length` at checkout time         |
| `checkoutDate`       | timestamp | `serverTimestamp()`                       |
| `expectedReturnDate` | timestamp | local midnight of the chosen day          |
| `returnedDate`       | timestamp | `null` until fully returned               |
| `status`             | string    | `"in-use"` \| `"partial"` \| `"returned"` |
| `notes`              | string    |                                           |
| `returnNotes`        | string    | `null` until returned                     |

### `users` collection

Keyed by Firebase Auth uid. Created manually per teacher.

| Field         | Type   | Notes                       |
|---------------|--------|-----------------------------|
| `displayName` | string | shown as the teacher's name |
| `roomNumber`  | string | drives home-room preference at checkout |

## Read budget

The project runs on Firestore's free Spark tier, so pages are written to
spend as few document reads as possible:

- Never `getDocs()` the whole `equipmentUnits` collection — use `count()`
  aggregations (1 read each) for availability.
- Query `checkouts` filtered by `status`; fully-returned checkouts pile up
  forever and must never be loaded.
- The dashboard runs **one** `onSnapshot` on active checkouts and splits it
  into "yours" and "department" in memory rather than issuing two queries.
- The equipment type list and the teacher's profile are handed between pages
  through `sessionStorage`, not re-fetched.

## Deploying to Vercel

1. Push the repo to GitHub.
2. Import the repo on [vercel.com](https://vercel.com) — no build command, output directory is `/` (root).
3. Every push to `main` auto-deploys.
