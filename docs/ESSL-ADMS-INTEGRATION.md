# eSSL/ZKTeco Biometric Device → BOT HRMS Attendance Integration

**Status:** Live in production as of 2026-07-31. First real device (eSSL MB20+ID, SN `EUF7254400194`, Fuerte Developers tenant) confirmed pushing real punches into `/attendance`.

## 1. What this does

Physical eSSL/ZKTeco biometric devices (fingerprint, face, card) push every punch event directly to our backend using the **ADMS** ("push SDK") protocol built into their firmware. No vendor middleware (e.g. eSSL's own "eBioServer" product) is involved — punches land straight in the same `Attendance` collection used by the employee app and the BOTLens camera, and go through the exact same punch-in/punch-out business logic (late detection, shift lookups, etc.).

```
eSSL device (ADMS push, plain HTTP)
    │  POST/GET /iclock/cdata(.aspx), /iclock/getrequest(.aspx), /iclock/devicecmd(.aspx)
    ▼
Nginx  (api.beontimeofficial.com — /iclock/* exempted from the site's HTTP→HTTPS redirect)
    ▼
Node/Express, PM2 process "backend"
    ▼
src/controllers/iclock_controller.js
    │  resolve device SN → tenant adminId (ESSL_DEVICES env var)
    │  resolve PIN → employee (User.deviceUserId)
    │  decide punch-in vs punch-out (no open Attendance today → in, else → out)
    ▼
attendance_controller.js  punchIn() / punchOut()   ← same functions the app & BOTLens use
    ▼
MongoDB Attendance collection → shows in /attendance, /employees, /shifts
```

## 2. Code changes made (this repo + frontend repo)

### Backend — `github.com/FuerteEmployee/backend`

| File | Change |
|---|---|
| `src/models/User.js` | Added `deviceUserId` (String) + sparse index `{adminId, deviceUserId}`. This is the PIN the employee is enrolled under on the physical device. |
| `src/controllers/iclock_controller.js` *(new)* | Implements the ADMS handlers — see §3 below. |
| `src/routes/iclock_routes.js` *(new)* | Mounts handlers at `/iclock/*`. Registers **both** extension-less and `.aspx`-suffixed paths — this device's firmware ("iClock Proxy" client) calls the `.aspx` variants. Applies `express.text()` scoped to this router only, since the device sends plain text, never JSON. |
| `src/app.js` | Mounted `app.use('/iclock', ...)` at the domain root — the path is hardcoded in device firmware, cannot live under `/api`. |
| server `.env` (not committed) | `ESSL_DEVICES=<serialNumber>:<adminPhone>[,<sn2>:<phone2>,...]` |

### Frontend — `github.com/FuerteEmployee/botcrm-frontend-`

| File | Change |
|---|---|
| `src/services/employee-service.ts` | Added `deviceUserId?: string` to the `Employee` interface. |
| `src/routes/_app/employees.create.tsx` | Added a "Biometric Device ID" input in the Employment Terms section, so admins can record each employee's on-device PIN. |

### Infra — AWS EC2 `13.202.48.15`

- `/etc/nginx/sites-enabled/api`, port-80 server block: added a `location /iclock/ { proxy_pass http://localhost:5000; ... }` block **before** the catch-all `return 301 https://...`. eSSL's push client speaks plain HTTP only and doesn't follow redirects, so without this exception every request 404s/redirects and the device just retries forever.
- PM2 process is named **`backend`** (not `bot-api` — earlier deploy notes had the wrong name).

## 3. The four ADMS endpoints, in plain terms

- **`GET /iclock/cdata`** (+ `.aspx`) — handshake. Device connects with `?SN=...&options=all`. We reply with a fixed plain-text config block telling it to push attendance logs (`TransTables=ATTLOG`), poll every ~30s (`Delay=30`), in real time (`Realtime=1`).
- **`POST /iclock/cdata`** (+ `.aspx`) — actual data push. Query has `?SN=...&table=ATTLOG` (or `OPERLOG`/other tables we ignore). Body is tab-separated lines: `PIN\tTimestamp\tStatus\tVerifyMode\t...`. We only act on `table=ATTLOG`; anything else is acked with `OK` and logged (so future traffic can tell us if we need to handle more).
- **`GET /iclock/getrequest`** (+ `.aspx`) — device polls "any commands for me?". We never queue any, so always reply `OK`.
- **`POST /iclock/devicecmd`** (+ `.aspx`) — device reporting back a command result. We never issue commands, but must still ack with `OK` or the device may retry.

Response body format matters: the device expects **plain text**, not JSON — `res.type('text/plain').send(...)`.

## 4. SOP — onboarding a new device (same client or a new one)

1. **Get the device serial number.** On the device: Menu → System Info / Device Info → *Serial Number*.
2. **Identify the tenant.** Which admin account (company) in BOT HRMS owns this device — note their login phone number.
3. **Register the device on the server.**
   ```
   ssh -i <key.pem> ubuntu@13.202.48.15
   cd ~/backend
   echo ',<NEW_SN>:<adminPhone>' >> .env   # append to existing ESSL_DEVICES line, comma-separated
   pm2 restart backend --update-env
   ```
4. **Get it on a network with internet access.** LAN or WiFi, any normal internet uplink. No port-forwarding, no VPN, no firewall change needed — the device only ever connects *outbound*.
5. **Configure Cloud Server Settings on the device** (Menu → Comm → Cloud Server Settings, naming varies by firmware):
   - Server Mode: **ADMS**
   - Enable Domain Name: **ON**
   - Server Address: **`api.beontimeofficial.com`** — ⚠️ NOT `botcrm.beontimeofficial.com` (that's the static frontend, has no `/iclock` routes)
   - Enable Proxy Server: **OFF** (unless the site genuinely requires an HTTP proxy to reach the internet)
6. **Reboot the device.** These devices generally only (re-)initiate the ADMS connection on boot or network change, not immediately on saving the setting.
7. **Enroll employees on the device** (Menu → User Mgt → New User) — note the **User ID / PIN** assigned to each person as you enroll them.
8. **Enter that PIN in BOT HRMS.** Employee profile → Employment Terms → *Biometric Device ID* → save.
9. **Verify end-to-end:**
   - `pm2 logs backend | grep iclock` on the server — look for `[iclock] processed N/M ATTLOG line(s) from SN=...`
   - Have the person punch on the device, then check `/attendance` in the app within ~30 seconds.

## 5. Troubleshooting

| Symptom | Likely cause / check |
|---|---|
| Nginx access log shows `404` on `/iclock/cdata.aspx` etc. | Device firmware uses a path variant we don't handle yet. Check `access.log` for the exact path/User-Agent and add it to `iclock_routes.js`. |
| Device retries every ~5s instead of settling to ~30s | It's still failing the handshake (not getting a 200). Confirm Server Address is exactly `api.beontimeofficial.com`, confirm via `sudo tail -f /var/log/nginx/access.log` while it retries. |
| Device shows an IP / "connected" but nothing ever reaches the server | `sudo tcpdump -i any -n 'tcp port 80 and tcp[tcpflags] & tcp-syn != 0'` on the server. **SYN packets arriving** = network path is fine, it's an application-layer/path issue (check access log). **Nothing at all** = the device's network doesn't actually have a route to the internet, or Server Address wasn't saved correctly. |
| Logs show "processed" but the punch never appears in `/attendance` | `deviceUserId` on the employee doesn't exactly match the PIN string the device sent (check for stray whitespace), or `ESSL_DEVICES` maps the SN to the wrong admin phone. |
| Punch recorded under the wrong status (e.g. half-day for two quick test taps) | Expected — the punch-direction heuristic just toggles in/out based on whether today's record is open; two punches seconds apart will look like an in-then-immediately-out shift, same as it would from the app. |

## 6. Building this in a brand-new codebase — minimum requirements

This is written generically so it's reusable outside this specific repo.

1. **Four HTTP endpoints implementing the ADMS "push" protocol** (a de facto standard across ZKTeco/eSSL and most clone firmware, not vendor-specific):
   - `GET /iclock/cdata` — handshake, reply with plain-text config
   - `POST /iclock/cdata` — data push, parse `table=ATTLOG` tab-separated lines
   - `GET /iclock/getrequest` — command poll, reply `OK` if nothing queued
   - `POST /iclock/devicecmd` — command-result ack, reply `OK`
   - Also register **`.aspx`-suffixed** variants of all four — some firmware calls them this way (confirmed on this exact device model).
2. **Raw-text body parsing scoped to just these routes.** The device never sends JSON; a global `express.json()` (or framework equivalent) will silently leave the body unparsed. Add a text/raw parser only on this router.
3. **A PIN → user mapping field** on the employee/user model. The device only ever sends a bare numeric PIN, never a name — you must let an admin record which PIN maps to which person.
4. **A device → tenant mapping**, if the system is multi-tenant. The device protocol has zero concept of "company" — you need your own registry (env var, DB table, whatever fits the system's scale) from serial number to which tenant's data a push belongs to.
5. **A punch-direction heuristic that doesn't trust the device's own status field.** That field (0=in, 1=out, etc.) is inconsistently configured across sites/installers in practice. Instead: no open attendance record today → treat as punch-in; an open one → treat as punch-out. This was the actually-reliable approach here.
6. **Reuse existing punch-in/punch-out business logic** rather than writing a separate insert path — treat the device as just another "trusted device" channel, same tier as any other automated/camera-based attendance source, so late/shift/status logic doesn't have to be duplicated.
7. **Infra:**
   - Serve `/iclock/*` at the domain root — not configurable, hardcoded in device firmware.
   - If the site force-redirects HTTP→HTTPS, **exempt `/iclock/*` from that redirect** — most of these devices speak plain HTTP only and won't follow a 301.
   - No inbound firewall/port-forwarding needed; the device always connects outbound.
8. **Production hardening not yet done here, worth doing eventually:**
   - Explicitly reject pushes from unrecognized serial numbers instead of just logging a warning.
   - Rate-limit/dedupe ATTLOG lines — devices sometimes resend a batch that wasn't cleanly acked.
   - A small admin UI for the SN→tenant mapping instead of a hand-edited env var, once there are more than a couple of devices.

## 7. Known limitations / open items

- Only `EUF7254400194` (Fuerte Developers tenant) is registered. New devices need a manual `ESSL_DEVICES` env var edit + `pm2 restart backend --update-env` (see §4).
- Punch timestamp used is **server receive time**, not the device's own reported timestamp. Fine for real-time push (seconds of drift), but if a device ever goes offline and later flushes a backlog of old punches, those will be timestamped "now" rather than when they actually happened. Not currently handled — would need `pushData` to parse and use the timestamp from each ATTLOG line instead of calling `punchIn`/`punchOut`'s `new Date()`.
- `backend/.env` (containing the MongoDB URI, JWT secret, Cloudinary secret, camera API key) is committed in git history on `github.com/FuerteEmployee/backend`. Flagged separately during this work; left as-is per explicit instruction, not resolved.
