# Deploying updates to free-stream.win

Production must run **v1.0.6+** for login. Check your site:

- View page source: should show `app.js?v=1.0.6` and `class="login-required"` on `<body>`
- Or open: `https://your-domain/api/auth/status` — should return JSON `{"authenticated":false}`, not `Cannot GET`

If you still see **v1.0.4**, the server has not been redeployed since May 2026.

## Option A — Portainer (build from this repo)

1. Update the stack to use the latest code (Git pull in Portainer, or re-clone the repo on the host).
2. Ensure the stack builds the image (see `docker-compose.portainer.yml` — `build: .` is set).
3. **Rebuild** the container (not just restart): Stack → Editor → Update the stack, or:
   ```bash
   docker compose -f docker-compose.portainer.yml build --no-cache
   docker compose -f docker-compose.portainer.yml up -d
   ```
4. Add login env vars if not already set:
   ```yaml
   - FREESTREAM_USER=admin
   - FREESTREAM_PASSWORD=change-me
   ```
5. Hard-refresh the browser (Cmd+Shift+R).

## Option B — Docker Hub image (CI)

1. In GitHub repo **Settings → Secrets**: add `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN`.
2. Push to `main` — workflow `.github/workflows/docker-publish.yml` builds `jt7777/freestream:latest`.
3. In Portainer: **Pull & redeploy** the container.

## Option C — Run Node directly on the host

```bash
cd /path/to/FreeStreamPort
git pull origin main
cd server && npm install
FREESTREAM_USER=admin FREESTREAM_PASSWORD=your-password node index.js
```

Restart your process manager (pm2/systemd) after pulling.
