# vidhyadeep academy stays on the OLD release: read before any production deploy

**Since 8 Oct 2026, production runs two versions on one database.**
- **vidhyadeep academy** (admin phone **9601272005**, company id `6a2d11c3bee6693b7ae623ab`) is our paying customer. They were promised **no change at all**: same app, same screens, same behaviour.
- **Every other company** runs the latest code.

Pushing the latest code to vidhyadeep, even by accident, breaks that promise. This page says what each side gets and what you must never do.

## Who gets what

| | **vidhyadeep academy** (frozen) | **All other companies** (latest) |
|---|---|---|
| API | `https://api.beontimeofficial.com` | `https://api2.beontimeofficial.com` |
| Server folder / pm2 | `~/backend` / pm2 **`backend`** (port 5000), behind pm2 **`api-shield`** (port 5010) | `~/backend-v2` / pm2 **`backend-v2`** (port 5004) |
| Code | commit `5cc1fac` + the 26 Sept server hotfix (copy in `qa/prod-hotfix-20260926/`) | `staging` branch of both repos |
| Website | `botcrm.beontimeofficial.com`, **classic build** `~/frontend/dist` (served when the browser has cookie `bot_ui=legacy`) | `botcrm.beontimeofficial.com`, **new build** `~/frontend-v2/dist` (the default) |
| Android app | old APK **1.2** (versionCode 3) | APK **2.0.1 or newer** (versionCode ≥ 21) |
| App updates (OTA) | old rows: channel `production` 1.2.3 | channel **`v2`** only, published from `~/backend-v2` |
| Nightly jobs | run by the old backend (for every company, as before) | none (`DISABLE_SCHEDULER=true` in `~/backend-v2`) |
| Database | `cluster0.5orcd9j` / `botdb`, **shared** | same database |

## How vidhyadeep is kept out of the new code

- **`FROZEN_TENANT_IDS=6a2d11c3bee6693b7ae623ab`** in `~/backend-v2/.env`. The new backend refuses every request from vidhyadeep with 403 `frozen_tenant`, before writing anything (`backend/src/utils/frozen_tenants.js`).
- **`VITE_FROZEN_TENANTS=6a2d11c3bee6693b7ae623ab`** in `botcrm-frontend-/.env.production`. The new website moves a vidhyadeep browser to the classic site (`src/lib/legacy-switch.ts`, inline script in `index.html`).
- **`OTA_CHANNEL_SET=v2`** in `~/backend-v2/.env`. New app updates use channels the old backend never reads (`backend/src/utils/ota_channels.js`).
- **nginx `sites-available/botcrm`** picks the website folder by the `bot_ui` cookie.

## NEVER do these

1. **Never deploy, `git pull`, edit, `npm install` or `pm2 restart` in `~/backend`.** It is vidhyadeep's backend.
2. **Never touch `~/frontend/dist`.** It is vidhyadeep's website.
3. **Never run `publishBundle.js` from `~/backend`, or anywhere without `OTA_CHANNEL_SET=v2`.** A `production` or `pilot` bundle is read by the old API and reaches vidhyadeep's phones.
4. **Never give an APK 2.x file to vidhyadeep staff.** It would only say "use the classic website", and Android can't go back to 1.2 without an uninstall.
5. **Never remove or change** `FROZEN_TENANT_IDS`, `VITE_FROZEN_TENANTS`, `OTA_CHANNEL_SET`, or the cookie `map` in the botcrm nginx site.
6. **Never point `api.beontimeofficial.com` at `~/backend-v2`**, and never change the old API's DNS.
7. **Never run a script that writes vidhyadeep's rows** (`adminId 6a2d11c3bee6693b7ae623ab`) in the production database. It is shared, so a "fix" there changes their data under the old code.
8. **Never edit vidhyadeep in Super admin** (account, plan, invoices, machines). The new backend refuses it (409); don't work around that.
9. **Never use `--production` thinking it means "only the new app"** unless you are in `~/backend-v2`. There it writes channel `v2`, which is correct.

## How to release for everyone else (the only allowed production deploy)

```bash
# backend (from your PC, repo backend/, staging branch, tests passing)
tar czf - src/... | ssh ubuntu@13.202.48.15 'cd ~/backend-v2 && tar czf ~/backups/backend-v2-$(date +%Y%m%d-%H%M%S).tgz src && tar xzf - && pm2 restart backend-v2'

# website (botcrm-frontend-, staging branch)
npm run build            # bakes https://api2.beontimeofficial.com; verify-build-target must say OK
# ship dist/ to ~/frontend-v2/dist (extract to dist.new, then swap; keep dist.prev)

# app update for phones on APK 2.x
ssh ... 'cd ~/backend-v2 && FRONTEND_DIST=$HOME/frontend-v2/dist node publishBundle.js <version above the last> --production --notes "..."'
#   must print: published <version> → v2
```

## After every production deploy, prove vidhyadeep was not touched

- `pm2 jlist`: process **`backend`** keeps the same pid and restart count. It was pid 472863 with 379 restarts on 8 Oct.
- `find ~/frontend/dist -type f -exec sha256sum {} + | sort -k2 | sha256sum`: unchanged. It was `486980aaf2059ec2…` on 8 Oct.
- Their data fingerprint: `qa/prod/fingerprint.cjs`, run on the server with `OUT=…` and then compared with `BEFORE=/AFTER=`. Any change must be their own use of the old app.
- Old API answer for their phones: `curl -X POST https://api.beontimeofficial.com/api/app/update -d '{"platform":"android","version_name":"1.2","custom_id":"6a2d11c3bee6693b7ae623ab"}'` must still return `1.2.3`.

## Moving vidhyadeep to the new version (only when the owner says so)

That is a planned migration, not a deploy:
1. Agree a date with the customer.
2. Back up the database.
3. Remove their id from `FROZEN_TENANT_IDS` and `VITE_FROZEN_TENANTS`.
4. Rebuild and redeploy the website.
5. Give their staff APK 2.x.
6. Move the nightly jobs to `~/backend-v2`, and switch off the old backend's scheduler by retiring `~/backend`.

Ask the owner (Bharat) first.

More detail: `CLAUDE.md` ("Production runs two releases on one database") and the 8 Oct entries in `PROJECT_CONTEXT.md`.
