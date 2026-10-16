# EducateNepal setup (free, ~15 minutes, no coding)

1. **GitHub**: create a repo, upload everything in this folder (keep the structure).
2. **Cloudflare dashboard -> Storage & Databases -> D1**: create a database named `educatenepal`.
   Open it -> Console -> paste the contents of `schema.sql` -> Execute.
   Copy the database ID into `wrangler.toml` (replace PASTE-YOUR-D1-DATABASE-ID-HERE), commit.
3. **R2**: create a bucket named `educatenepal-files` (leave it private).
4. **Workers & Pages -> Create -> Pages -> Connect to Git**: pick the repo.
   Framework: None. Build command: empty. Output directory: `public`.
5. After the first deploy: **Settings -> Variables and Secrets** -> add secret `SETUP_KEY` (any long random text). Redeploy.
6. Open `https://YOUR-SITE.pages.dev/admin.html`, enter your email, password and the setup key. This works once; after that it is a normal login.

Public site: `/`   Teacher panel: `/admin.html`

Limits: JPG/PNG/WebP/PDF, 25 MB each. Not built yet: managing accounts from the panel (planned next).
