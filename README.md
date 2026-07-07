# Song Ranker

A tiny static site that lets visitors rank songs by comparing two at a time.
Every vote updates each song's **Elo rating**, and a live leaderboard shows the
current standings. Results are saved per-visitor in `localStorage`, so no
backend is required — this is designed to be dropped straight onto **GitHub
Pages**.

## Features

- Head-to-head pairwise voting with Elo ratings (K = 32)
- "Too close to call" ties and skip options
- Keyboard shortcuts: `←` / `→` to pick, `Space` to skip, `0` for a tie
- Live leaderboard with W-L-T record and win %
- **Visitors can add their own songs** from the Songs tab; entries persist per
  browser in `localStorage` and immediately join the matchup rotation
- **Add whole albums at once** — paste track titles (one per line); every track
  becomes a rankable song with shared album metadata
- Filter the song list by built-in / user-added
- Export current standings as CSV
- Reset votes at any time
- Fully editable base song list via `songs.json` (no build step)
- Dark + light theme via `prefers-color-scheme`
- Mobile responsive

## Project structure

```
.
├── index.html       # Markup + views (Vote / Leaderboard / About)
├── styles.css       # Styling, responsive layout, themes
├── script.js        # Elo, pair selection, storage, rendering
├── songs.json       # ← Edit this to change the song list
├── .nojekyll        # Tells GitHub Pages to skip Jekyll processing
└── README.md
```

## Customize the song list

There are two ways to add songs:

### 1. From the site itself (per-visitor)

Any visitor can open the **Songs** tab:

- **Add song** — one track at a time, with optional album name and cover upload
- **Add album** — album title, artist, optional cover upload, and track names
  (one per line). Every track is added as its own song and shares the cover.

Entries are saved in that browser's `localStorage` and survive a refresh.
Each visitor sees their own additions — nothing is synced across browsers.

Storage keys:

- `song-ranker.custom-songs.v1` — user-added songs (including album tracks)
- `song-ranker.custom-albums.v1` — album metadata for bulk-added albums

Uploaded covers are resized and stored as compressed JPEG data URLs in
`localStorage`. Built-in songs in `songs.json` can still use remote image URLs.

## Run locally

Because the page reads `songs.json` with `fetch()`, browsers block it when
you open `index.html` directly from disk. Serve the folder over HTTP instead:

```bash
# Python 3
python -m http.server 8000

# or Node
npx serve .
```

Then open <http://localhost:8000>.

## Deploy to GitHub Pages

1. Create a new GitHub repository and push these files to the default branch
   (usually `main`):

   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```

2. On GitHub, go to **Settings → Pages**.
3. Under **Build and deployment**, set:
   - **Source:** *Deploy from a branch*
   - **Branch:** `main` / `/ (root)`
4. Save. After a minute or two your site will be live at
   `https://<you>.github.io/<repo>/`.

That's it — no build step, no CI required.

## How the ranking works

Each song starts at 1000. After every matchup we compute the expected score
using the standard Elo formula:

```
E_A = 1 / (1 + 10^((R_B - R_A) / 400))
```

and update ratings with:

```
R_A' = R_A + K * (S_A - E_A)   // S_A = 1 win, 0.5 tie, 0 loss
```

We use `K = 32`, which is punchy enough that a couple dozen votes already
produce a meaningful order. Ties nudge both songs toward each other.

## Notes on data & privacy

All state lives in the visitor's browser under two `localStorage` keys:

- `song-ranker.v1` — vote counts and Elo ratings
- `song-ranker.custom-songs.v1` — songs the visitor added via the Songs tab
- `song-ranker.custom-albums.v1` — albums the visitor added (tracks live in custom-songs)

Nothing is transmitted anywhere. If you want a global leaderboard or globally
shared user-added songs across all visitors, you'd need to add a backend
(e.g. a Cloudflare Worker, Supabase, or Firebase) and swap `saveState()` /
`saveCustomSongs()` for HTTP calls.
