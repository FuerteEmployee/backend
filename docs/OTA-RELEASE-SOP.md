# Pushing an OTA update — SOP

The Android app is a web bundle inside a WebView, so most releases ship as a
zip of `dist/` rather than a new APK. This is how to push one, how to check it
landed, and how to pull it back.

Read §1 first. Shipping the wrong layer is the mistake that costs a day.

---

## 1. Can this change go OTA at all?

| Change | Ships how |
|---|---|
| React, CSS, screens, copy, most fixes | **OTA** |
| Backend behaviour | backend deploy (not OTA) |
| Kotlin under `android/.../tracker/` | **APK only** |
| `AndroidManifest.xml`, permissions, `build.gradle`, `res/` | **APK only** |
| New/updated Capacitor plugin | **APK only** |
| `capacitor.config.ts` | **APK only** (baked into native assets at `cap sync`) |

One check settles it:

```bash
cd botcrm-frontend-
git status --porcelain android/ | grep -vE "assets/public|/build/"
```

Anything listed → you need an APK. Nothing listed → OTA is enough.

---

## 2. Before you start

- `zip` on the server (`sudo apt-get install -y zip`) — `publishBundle.js` shells out to it.
- Know the tenant's `adminId` for a pilot. Fuerte Developers is `6a6990c0835fb1fb12e33268`.
- Pick the **next** version number. Never reuse one. See §6.1.

---

## 3. Staging

Three steps: build, deploy the web, publish the bundle. Do all three — the web
deploy serves `staging.beontimeofficial.com`, the bundle serves the app.

```bash
KEY=~/.ssh/beontime-key.pem
H=ubuntu@13.202.48.15

# 3.1 Build
cd botcrm-frontend-
rm -rf dist
npx vite build --mode staging          # bakes VITE_API_URL from .env.staging

# 3.2 Deploy the web layer
tar -czf /tmp/sd.tar.gz -C dist .
scp -i $KEY /tmp/sd.tar.gz $H:/tmp/
ssh -i $KEY $H '
  set -e
  cd ~/frontend-staging
  rm -rf dist.old && mv dist dist.old && mkdir dist
  tar -xzf /tmp/sd.tar.gz -C dist
  sudo nginx -t && sudo systemctl reload nginx
'

# 3.3 Publish the bundle
ssh -i $KEY $H '
  cd ~/backend-staging
  FRONTEND_DIST=/home/ubuntu/frontend-staging/dist \
  BASE_URL=https://staging-api.beontimeofficial.com \
  node publishBundle.js 1.4.5 \
    --pilot 6a6990c0835fb1fb12e33268 \
    --notes "Plain sentences an employee will read in the update prompt."
'
```

`FRONTEND_DIST` is **not optional**. Without it the script resolves
`../frontend/dist`, which on this box is *production's* build — you would ship
the production bundle to staging devices. Same for `BASE_URL`: it decides the
download URL written into the release row.

---

## 4. Production

Same shape, different paths — and one correction that is easy to get wrong.

```bash
# 4.1 Build
cd botcrm-frontend-
rm -rf dist
npx vite build                         # production mode; check for a stray .env.local first

# 4.2 Deploy the web layer  (nginx root: /home/ubuntu/frontend/dist)
tar -czf /tmp/pd.tar.gz -C dist .
scp -i $KEY /tmp/pd.tar.gz $H:/tmp/
ssh -i $KEY $H '
  set -e
  cd ~/frontend
  rm -rf dist.old && mv dist dist.old && mkdir dist
  tar -xzf /tmp/pd.tar.gz -C dist
  sudo nginx -t && sudo systemctl reload nginx
'

# 4.3 Publish  — note BASE_URL, see the warning below
ssh -i $KEY $H '
  cd ~/backend
  FRONTEND_DIST=/home/ubuntu/frontend/dist \
  BASE_URL=https://api.beontimeofficial.com \
  node publishBundle.js 1.3.0 --pilot <adminId> --notes "..."
'
```

> **`BASE_URL` in `~/backend/.env` is `https://botcrm.beontimeofficial.com` — the
> WEB domain. Bundles are served by Express from the API domain
> (`app.js` mounts `express.static` at `/bundles`). If you let the publish
> inherit that value, the release row gets a URL on the web host, where nginx's
> SPA fallback answers **`200 OK` with `index.html`** instead of a zip. The app
> downloads 900 bytes of HTML, fails its checksum, and retries forever. Always
> pass `BASE_URL=https://api.beontimeofficial.com` explicitly on production.**

Roll out with `--pilot <adminId>` first. `--production` targets every tenant and
should only follow a pilot that has been confirmed on a real handset.

---

## 5. Verify — every time, before you tell anyone

```bash
API=https://staging-api.beontimeofficial.com     # or https://api.beontimeofficial.com
ADMIN=6a6990c0835fb1fb12e33268

# a) the server offers it
curl -s -X POST $API/api/app/update -H 'Content-Type: application/json' \
  -d "{\"platform\":\"android\",\"version_name\":\"0.0.0\",\"custom_id\":\"$ADMIN\",\"device_id\":\"verify\"}"

# b) the URL it returned is a REAL ZIP — this is the check that catches the
#    BASE_URL trap; a 200 alone proves nothing.
curl -sI "<url from (a)>" | grep -iE "HTTP|content-type|content-length"
#    want: 200, application/zip, ~1.5 MB
#    bad : text/html  -> wrong BASE_URL      500 -> file missing on disk

# c) the web layer is live
curl -s https://staging.beontimeofficial.com/ | grep -o 'assets/index-[A-Za-z0-9_-]*\.js'

# d) production is untouched (when releasing to staging)
curl -s -X POST https://api.beontimeofficial.com/api/app/update \
  -H 'Content-Type: application/json' \
  -d '{"platform":"android","version_name":"1.2","device_id":"x"}'
```

Then confirm a real device picked it up:

```bash
ssh -i $KEY $H 'grep "\[ota\]" ~/.pm2/logs/bot-api-staging-out.log | tail -5'
# want a line reading:  on <old> -> offering <new> (pilot)
# then, after it applies: on <new> -> ...
```

---

## 6. Rules that are not obvious

### 6.1 Versions are compared by EQUALITY, not order

`app_release_controller.checkForUpdate` only asks `versionName === release.version`.
It has no idea which is newer. So a device is "up to date" solely when the
strings match — publishing an older number pushes devices **backwards**. Always
increment, never reuse a number, and never re-publish a number that has shipped.

### 6.2 An APK's built-in bundle must never be older than what is published

Installing an APK replaces whatever OTA had applied with the bundle baked into
it. Ship an APK carrying a stale `dist/` and every installer is silently rolled
back. This happened on 2026-09-16: APK 1.6 shipped bundle 1.3.5 content and
re-introduced a download bug that 1.3.6 had already fixed.

So when building an APK: build the web layer, publish it as a bundle, and cut
the APK from that same `dist/` — then verify they match:

```bash
unzip -p BOT-Staging-1.8.apk assets/public/index.html | grep -o 'assets/index-[A-Za-z0-9_-]*\.js'
curl -s https://staging.beontimeofficial.com/ | grep -o 'assets/index-[A-Za-z0-9_-]*\.js'
# these two must be identical
```

### 6.3 `cap sync` bakes the OTA URL into the APK

`capacitor.config.ts` defaults to the production endpoint. A staging APK must be
synced with the override, or it will ask production for updates and pull the
production bundle onto a staging device:

```bash
CAP_OTA_URL=https://staging-api.beontimeofficial.com/api/app/update npx cap sync android

# confirm it took, before building:
grep -o '"updateUrl"[^,]*' android/app/src/main/assets/capacitor.config.json
# and again in the finished APK:
unzip -p BOT-Staging-1.8.apk assets/capacitor.config.json | grep -o '"updateUrl"[^,]*'
```

### 6.4 Two cold starts, not one

`autoUpdate` checks on a **cold start**, not on resume, and applies the bundle on
the start *after* the one that downloaded it. So a device needs to be swiped out
of recents and reopened twice. From bundle 1.3.4 onward the in-app prompt
(Settings → App version) does it in one go instead.

### 6.5 Write the notes for the employee

`--notes` is shown verbatim in the update prompt. Omitting it produces a generic
message, and a prompt that cannot say what changed teaches people to dismiss
prompts. Plain sentences, no version numbers, no internal names.

---

## 7. Rollback

Disable the release; devices fall back to the previous enabled one.

```bash
ssh -i $KEY $H 'cd ~/backend-staging && node -e "
  require(\"node:dns\").setServers([\"8.8.8.8\",\"1.1.1.1\"]);
  require(\"dotenv\").config();
  const m=require(\"mongoose\");
  (async()=>{
    await m.connect(process.env.MONGO_URI);
    const r=await m.connection.db.collection(\"appreleases\")
      .updateOne({version:\"1.4.5\"},{\$set:{enabled:false}});
    console.log(\"disabled:\", r.modifiedCount);
    await m.disconnect();
  })();
"'
```

`publishBundle.js` prints the release `id` on publish — keep it, it is the
fastest handle for this. The `PUT /api/app/releases/:id` endpoint also exists but
is guarded by `protect` only, with no role check, so prefer the database.

Rollback does **not** un-apply a bundle already installed on a handset. To undo
that you must publish a higher version containing the fix.

---

## 8. Known-bad state (as of 2026-09-17)

**Production OTA is broken and has been for some time.** The enabled production
release points at `https://api.beontimeofficial.com/bundles/bundle-1.2.3.zip`,
which returns `500 ENOENT` — `~/backend/bundles/` on the server is empty. Every
production device that checks for an update downloads nothing and retries
forever, silently.

Fixing it means republishing from `~/backend` with the correct `BASE_URL` (§4),
which writes the zip to `~/backend/bundles/` and mints a working URL. Do that
before relying on production OTA for anything.
