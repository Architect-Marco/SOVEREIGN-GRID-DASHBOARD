# Radio Sync — Setup Guide

Connects your dashboard's Radio Station page to the live WKOR and CDFM
sites: add/remove/reorder a track (or flip On Air) on the dashboard,
and both public sites update automatically within ~20 seconds.

Three pieces, in the order you should set them up:

---

## 1. GitHub token (5 min)

Create a **fine-grained** personal access token — not a classic
token — so it can only touch these two repos, nothing else on your
account.

1. GitHub → Settings → Developer settings → Personal access tokens →
   Fine-grained tokens → **Generate new token**
2. Resource owner: your account (architect-marco)
3. Repository access: **Only select repositories** → check
   `wkorfm-radio` and `cdfm-radio`
4. Permissions → Repository permissions → **Contents: Read and
   write**. Leave everything else as "No access".
5. Generate, and copy the token immediately (GitHub only shows it once).

---

## 2. Deploy the Worker (10 min)

This is the piece that actually holds the token and talks to GitHub.
The dashboard never sees it.

1. https://dash.cloudflare.com → Workers & Pages → **Create** →
   **Create Worker**. Any name (e.g. `radio-sync`).
2. Open the editor, delete the placeholder code, paste in
   **`radio-sync-worker.js`** (attached), Deploy.
3. Go to the Worker's **Settings → Variables and Secrets** → add two
   **secrets** (not plain variables — secrets are hidden after saving):
   - `GITHUB_TOKEN` → the token from step 1
   - `SYNC_SECRET` → any long random string you make up yourself
     (this is just a password so nobody else on the internet can call
     your Worker and rewrite your playlist — it isn't a GitHub value)
4. Save. Copy the Worker's URL from the top of the page — looks like
   `https://radio-sync.<your-subdomain>.workers.dev`.

---

## 3. Wire up the three repos

**a) SBN dashboard (this repo):**
In `shared.js`, near the top of the Radio Station section, fill in:
```js
window.RADIO_SYNC_URL = 'https://radio-sync.<your-subdomain>.workers.dev';
window.RADIO_SYNC_SECRET = '<the same SYNC_SECRET you set on the Worker>';
```
That's it — `shared.js` already has the sync calls wired into add/
delete/reorder track and the On Air toggle. Leaving `RADIO_SYNC_URL`
blank (the default) makes sync silently do nothing, so it's safe to
deploy this file before you've finished the rest of the setup.

**b) wkorfm-radio repo:**
- Commit the attached `playlist.json` to the repo root (only needed
  once, so the widget has something valid to read before the first
  real sync happens).
- Open `index.html`, find the "NOW ON AIR" and "PLAYLIST" sections,
  and replace them with the contents of `radio-sync-widget.html`
  (attached) — keep the element ids exactly as given, the script
  targets them by id.

**c) cdfm-radio repo:**
- Same two steps as WKOR — identical `playlist.json` placeholder,
  identical `radio-sync-widget.html` snippet. Nothing site-specific to
  change; each site only ever reads its own `playlist.json`.

---

## How it flows

```
Dashboard (add/remove/reorder a track, or toggle On Air)
   → shared.js debounces ~800ms, POSTs { tracks, isLive } to the Worker
       (with the shared secret in a header, not a real GitHub token)
   → Worker checks the secret, then for EACH repo:
       - reads playlist.json's current sha
       - commits a new playlist.json via the GitHub Contents API
   → wkorfm-radio and cdfm-radio's own JS polls its local playlist.json
     every 20s and re-renders NOW ON AIR + PLAYLIST
```

## Things worth knowing

- **Cover art is capped at 250 KB per track** inside the Worker. A
  track with a bigger embedded cover image still syncs — just without
  art — rather than failing the whole push. If you want art to come
  through reliably, keep uploaded cover images reasonably small.
- **Audio is streamed straight from the dashboard repo, not duplicated.**
  Your mp3s already live in this repo's `WKOR/`/`CDFM/` folders, and
  this repo is published at
  `https://architect-marco.github.io/SOVEREIGN-GRID-DASHBOARD/`. The
  Worker turns each track's relative path (e.g.
  `WKOR/4 - Rock This Beats....mp3`) into a full URL against that
  base before writing `playlist.json`, so wkorfm-radio and cdfm-radio
  play the files directly from here — you never need to upload a
  copy into either of those two repos.
- Every commit to `playlist.json` shows up in each repo's commit
  history as "sync: update playlist.json from SBN dashboard" — useful
  if you ever want to see when a change went out.
