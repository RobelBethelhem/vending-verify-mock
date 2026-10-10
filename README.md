# Vending machine verify mock server

A tiny Express server that stands in for the "E-commerce pickup address" of an
Android vending machine. When the machine scans a QR code and calls the server
(for example `POST /WXdevelop/VerifyCode`), the server:

- **logs everything** it received: method, URL, headers, query, raw body, parsed body, IP
- **replies with a response you control live from your phone** at `/admin`
- **defaults to SUCCESS**, so the machine should drop the item

It accepts any method and any path (except `/`, `/health`, `/admin`, `/api/*`)
and never returns 404 to the machine. No database is used.

## Run locally

```bash
npm install
npm start          # http://localhost:3000
npm test           # runs the self-tests
```

If you did not set `ADMIN_TOKEN`, a random token is printed in the console together
with a ready-made link like `http://localhost:3000/admin?token=...`.

### Environment variables

| Name          | Default          | Meaning                                                  |
|---------------|------------------|----------------------------------------------------------|
| `PORT`        | `3000`           | Port to listen on (free hosts set this for you).         |
| `ADMIN_TOKEN` | random per start | Password for the admin page/API. **Set it on the host**, otherwise it changes on every restart. |

## Deploy on Render (free plan)

1. Push this folder to a GitHub repository:
   ```bash
   git add .
   git commit -m "Vending verify mock server"
   git branch -M main
   git remote add origin https://github.com/<you>/vending-verify-mock.git
   git push -u origin main
   ```
2. On https://dashboard.render.com click **New > Web Service** and pick the repo.
3. Settings:
   - Runtime: **Node**
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: **Free**
4. Under **Environment** add `ADMIN_TOKEN` = a long random string of your choice.
5. Click **Create Web Service**. After the deploy, your URL is `https://<app>.onrender.com`.

Railway and Koyeb work the same way: connect the GitHub repo, they detect Node and
run `npm install` / `npm start`; add the `ADMIN_TOKEN` variable.

## Point the machine at it

In the vending machine settings, set the **E-commerce pickup address** to:

```
https://<app>.onrender.com/WXdevelop/VerifyCode
```

Any other path also works and is logged, so if the machine appends its own path
you will see it in the logs.

## Using the admin page

Open `https://<app>.onrender.com/admin?token=<ADMIN_TOKEN>` on your phone once.
The token is saved in the browser and removed from the address bar, so next time
just open `/admin`.

- **SUCCESS / FAIL** big buttons switch what the machine gets, instantly.
- **Responses**: edit status code, content-type, extra headers (JSON) and body for
  both the success and the fail reply. Pick a **preset** (generic JSON,
  `{"code":0,"msg":"success"}`, `{"status":1}`, `{"success":true}`, plain `success`,
  `OK`, `1`, `{"errcode":0,"errmsg":"ok"}`, XML) and press **Save**.
- **Delay** waits before answering (to test machine timeouts).
- **Fail codes**: if the scanned value equals one of these (e.g. `FAIL001`) the fail
  response is sent whatever the mode, so you can test failure just by scanning a
  different QR code.
- **Placeholders** in the body: `{{scanned}}` `{{slot}}` `{{machine}}` `{{timestamp}}`
  (unix seconds) `{{timestampMs}}` `{{iso}}` `{{method}}` `{{path}}` `{{query.KEY}}`
  `{{body.KEY}}` (dot paths like `{{body.data.orderNo}}`). Missing values become empty;
  values are JSON-escaped when the content-type is JSON.
- **Test** sends a fake machine call to the server and shows the reply.
- **Requests** list refreshes every 2 s. Tap one to see headers, query, raw body,
  parsed body and the response sent. **Copy as text** / **Copy last request** copy it
  as plain text so you can paste it to Claude and work out the real format.

The server guesses the scanned code (`code`, `qrcode`, `pickupCode`, `orderNo`, ...),
the slot (`slotNo`, `aisle`, `channel`, ...) and the machine id (`deviceId`, `imei`,
`sn`, ...) by searching the body and query case-insensitively, including nested objects.

## curl examples

```bash
APP=https://<app>.onrender.com      # or http://localhost:3000
TOKEN=<your ADMIN_TOKEN>

# Machine-style calls
curl "$APP/WXdevelop/VerifyCode?code=ABC123&slotNo=5"
curl -X POST "$APP/WXdevelop/VerifyCode" -H "Content-Type: application/json" \
     -d '{"code":"ABC123","slotNo":"5","deviceId":"VM001"}'
curl -X POST "$APP/WXdevelop/VerifyCode" -d "code=ABC123&slotNo=5"
curl -X POST "$APP/WXdevelop/VerifyCode" -H "Content-Type: text/plain" -d "ABC123"

# Admin API
curl -H "x-admin-token: $TOKEN" "$APP/api/logs"
curl -H "x-admin-token: $TOKEN" -H "Content-Type: application/json" \
     -X POST "$APP/api/mode" -d '{"mode":"fail"}'
curl -H "x-admin-token: $TOKEN" "$APP/api/config"
curl -H "x-admin-token: $TOKEN" -X DELETE "$APP/api/logs"
```

## Notes

- **Free hosts sleep after ~15 minutes without traffic** and the first request then
  takes 30-60 s, which can make the machine time out. Create a free
  [UptimeRobot](https://uptimerobot.com) HTTP monitor on `https://<app>.onrender.com/health`
  every 5 minutes to keep it awake.
- The free host's disk is temporary: `config.json` and `logs.ndjson` are lost on
  redeploy/restart. The last 500 logs are also kept in memory.
- Admin routes need the token; machine routes are public by design.
