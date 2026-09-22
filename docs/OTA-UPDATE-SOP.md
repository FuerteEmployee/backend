# OTA update — standard operating procedure

How to ship a **web-layer** change to installed apps without building an APK.

OTA replaces the HTML/CSS/JS inside the app. It **cannot** deliver anything
native: a new Android permission, a Capacitor plugin, a change under
`android/app/src/main/java/`, or a `build.gradle` bump all need a real APK.
If your change touches any of those, stop — this is the wrong procedure.

---

## Before you start

| Thing | Staging | Production |
|---|---|---|
| Web | `staging.beontimeofficial.com` → `~/frontend-staging/dist` | `botcrm.beontimeofficial.com` → `~/frontend/dist` |
| API | `staging-api…` → pm2 `bot-api-staging` (`~/backend-staging`, port 5001) | `api…` → pm2 `backend` (`~/backend`) |
| Build mode | `--mode staging` (`.env.staging`) | `npm run build` (`.env.production`) |
| Server | `ssh -i ~/.ssh/beontime-key.pem ubuntu@13.202.48.15` | same box |

**Never mix them.** The API URL is baked into the bundle at build time and
cannot be changed afterwards.

---

## 1. Build the web bundle

```bash
cd botcrm-frontend-
npx vite build --mode staging      # or: npm run build   (production)
```

### 1a. VERIFY THE BAKED API URL — do not skip this

```bash
grep -rl "staging-api.beontimeofficial.com" dist/assets/*.js   # expect a hit
grep -rl "https://api.beontimeofficial.com"  dist/assets/*.js   # expect NOTHING
```

This has already gone wrong once. A `dist/` left over from a production build
was about to be published to the staging pilot — which would have silently
repointed every staging phone at the **production API and database**. The bundle
looks identical; only this grep tells them apart.

Also confirm no stray `.env.local` exists — it silently overrides
`.env.production` in Vite builds.

---

## 2. Deploy the API first, if it changed

The bundle may call endpoints or send fields the old server does not know.
Mongoose strict mode **silently drops** unknown fields, so a mismatch looks
like "the feature does nothing" rather than an error.

```bash
# What differs from what is running? (content, not timestamps)
cd backend
find src -type f -name "*.js" | sort | while read f; do
  echo "$(sha256sum "$f" | cut -c1-12)  $f"; done > /tmp/local.txt
ssh -i ~/.ssh/beontime-key.pem ubuntu@13.202.48.15 \
  'cd ~/backend-staging && find src -type f -name "*.js" | sort | while read f; do
     echo "$(sha256sum "$f" | cut -c1-12)  $f"; done' > /tmp/remote.txt
diff /tmp/local.txt /tmp/remote.txt
```

Back up, then ship **`src/` only**:

```bash
ssh -i ~/.ssh/beontime-key.pem ubuntu@13.202.48.15 \
  'tar czf ~/backups/backend-staging-$(date +%Y%m%d-%H%M%S).tgz \
     --exclude=node_modules --exclude=apks --exclude=.git -C ~ backend-staging'

tar czf - src | ssh -i ~/.ssh/beontime-key.pem ubuntu@13.202.48.15 \
  'cd ~/backend-staging && sha256sum .env | cut -c1-16 && tar xzf - \
   && sha256sum .env | cut -c1-16 && pm2 restart bot-api-staging'
```

- **Never copy `.env`.** It is tracked in a public repo but the server's copy is
  different and is edited by hand. Print its hash before and after — they must
  match. Copying `src/` only makes this structurally safe.
- **Never `git pull` on the server.** Same reason.
- Check the restart: `pm2 logs bot-api-staging --lines 20 --nostream`. You want
  `MongoDB Connected` and the three scheduler lines.

> ⚠️ **Server-local edits.** Some files were edited directly on the server and
> never committed. A deploy overwrites them. This already removed the staging
> CORS origins from `src/app.js` and broke every login until it was restored.
> If the diff shows a file you did not change, look at it before overwriting.

---

## 3. Deploy the web (browser users)

```bash
cd botcrm-frontend-
tar czf - dist | ssh -i ~/.ssh/beontime-key.pem ubuntu@13.202.48.15 '
cd ~/frontend-staging
rm -rf dist.prev2; [ -d dist.prev ] && mv dist.prev dist.prev2
[ -d dist ] && cp -r dist dist.prev
rm -rf dist.incoming && mkdir dist.incoming && cd dist.incoming && tar xzf - && cd ..
if [ -f dist.incoming/dist/index.html ]; then
  rm -rf dist && mv dist.incoming/dist dist && rm -rf dist.incoming && echo OK
else echo "EXTRACT FAILED — dist untouched"; rm -rf dist.incoming; fi'
```

Extract-then-swap: a broken transfer must never replace a working site.
`dist.prev` is the one-step rollback.

Confirm the live page serves the new hash:

```bash
curl -s https://staging.beontimeofficial.com/ | grep -o 'assets/index-[A-Za-z0-9_-]*\.js'
```

---

## 4. Publish the OTA bundle (installed apps)

Run this **on the server**, so the zip lands in the directory that serves it.

```bash
ssh -i ~/.ssh/beontime-key.pem ubuntu@13.202.48.15
cd ~/backend-staging
FRONTEND_DIST=$HOME/frontend-staging/dist \
  node publishBundle.js <version> --pilot <adminId>
```

- `FRONTEND_DIST` is **required on staging**. Without it the script finds
  `~/frontend/dist` — the *production* build.
- **Version must be strictly greater** than the current release, compared
  numerically per segment. Check first:
  `node -e "..."` or look at Super admin → releases. Latest wins; equal or lower
  is never offered.
- `--pilot <adminId>` targets one tenant. `--production` targets everyone.
  Fuerte Developers = `6a6990c0835fb1fb12e33268`.
- Add `--notes "…"` — without it the in-app prompt shows a generic message.

The script refuses to publish a bundle that cannot boot: it checks
`index.html` is at the zip root and rewrites Windows `\` path separators.
Both checks exist because bundle 1.2.2 shipped broken and every device
re-downloaded it on a loop over mobile data.

---

## 5. Verify — before you tell anyone it is done

```bash
# A device on the previous version is offered the new one
curl -s -X POST https://staging-api.beontimeofficial.com/api/app/update \
  -H "Content-Type: application/json" \
  -d '{"platform":"android","version_name":"<PREVIOUS>","custom_id":"<adminId>","device_id":"verify"}'
# → {"version":"<NEW>","url":…,"checksum":…}

# A device already on the new version is NOT offered it again (no update loop)
curl -s -X POST https://staging-api.beontimeofficial.com/api/app/update \
  -H "Content-Type: application/json" \
  -d '{"platform":"android","version_name":"<NEW>","custom_id":"<adminId>","device_id":"verify"}'
# → {"kind":"up_to_date"}

# The file downloads and matches the checksum recorded at publish time
curl -s <bundle url> -o /tmp/b.zip -w "HTTP %{http_code} %{size_download}\n"
sha256sum /tmp/b.zip
```

Do not wait for a real device — simulate both sides. "It didn't offer" and
"it offers forever" are the two failure modes, and both are invisible until
someone complains.

---

## 6. Rollback

| Layer | How |
|---|---|
| OTA bundle | `PUT /api/app/releases/:id` with `{"enabled": false}` — the id is printed on publish. Devices fall back to the previous release. |
| Web | `cd ~/frontend-staging && rm -rf dist && mv dist.prev dist` |
| API | restore the `~/backups/backend-staging-*.tgz` taken in step 2, then `pm2 restart bot-api-staging` |

---

## When OTA is not enough

Rebuild and distribute an APK if the change touches:

- `android/` — any Kotlin, the manifest, or a permission
- `capacitor.config.ts`, or adding/removing a Capacitor plugin
- `versionCode` / `versionName` in `build.gradle`

### ⚠️ Set `CAP_OTA_URL` before `cap sync` for a staging APK

```bash
CAP_OTA_URL=https://staging-api.beontimeofficial.com/api/app/update   npx cap sync android
```

The OTA endpoint is baked into the APK from `capacitor.config.ts`, and it
**defaults to production**. It does not come from `.env.staging`, and the web
layer's API URL has no influence on it — an APK can talk to the staging API for
everything and still ask the *production* server for updates.

This happened to builds 10 and 11. Symptom: "no update available" on the phone
while the staging server shows no request at all, because the device was asking
a server that has nothing for it. Verify after every sync:

```bash
grep -o '"updateUrl": "[^"]*"' android/app/src/main/assets/capacitor.config.json
```

The worse failure is silent: if production ever publishes a bundle, a staging
handset pointed at it will download the **production** web layer and start
writing to the production database.

APK rules:

- Bump **`versionCode`** — it is the only thing compared. `versionName` is
  display text.
- Give it a **distinct `versionName`** too. Two releases both called "1.8"
  produced "update to 1.8" on a phone already running 1.8.
- **Keep the same signing key.** Verify before distributing:
  `apksigner verify --print-certs app-staging.apk` — the SHA-256 must match the
  installed build, or users get "App not installed" and must uninstall first,
  losing queued offline fixes.
- The APK metadata you enter when uploading **must match the file**. A release
  row claiming `versionCode 9` while the file is `versionCode 8` makes every
  device update, stay on 8, and be told again — forever.

---

## Quick checklist

```
[ ] Change is web-only (no android/, no plugin, no gradle)
[ ] Built with the right --mode
[ ] Baked API URL verified by grep (staging present, production absent)
[ ] Backend diffed, backed up, src/ only, .env hash unchanged, restarted clean
[ ] Web deployed, live hash matches the build
[ ] Bundle version strictly greater than current
[ ] FRONTEND_DIST set when publishing on staging
[ ] --notes written
[ ] Offer check passes for old version; up_to_date for new
[ ] Bundle downloads, checksum matches
[ ] Rollback id noted
```

## APK checklist

```
[ ] CAP_OTA_URL set before cap sync (staging) — then grep the baked config
[ ] versionCode bumped; versionName distinct
[ ] Web layer grep: staging present, production absent
[ ] apksigner cert SHA-256 matches the installed build
[ ] Upload metadata matches the file's real versionCode/versionName
```
