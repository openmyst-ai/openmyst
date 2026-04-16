# Bug-report relay worker

Tiny Cloudflare Worker that accepts a POST from the Open Myst app and creates
a GitHub issue via the REST API. Lets end-users file bugs without a GitHub
account of their own — the app ships with just the worker URL.

## Deploy

1. `npm install` in this directory.
2. Create a fine-grained PAT (GitHub → Settings → Developer settings →
   Personal access tokens → Fine-grained) with **Issues: write** on the
   target repo. You can use a dedicated bot account so issues are authored
   under that name; it owns the PAT.
3. `npx wrangler secret put GITHUB_TOKEN` and paste the PAT when prompted.
4. Optional but recommended: `npx wrangler secret put SHARED_SECRET` and set
   any value. The app will include it as `clientToken`; the worker rejects
   requests that don't match. Obscures — doesn't fully prevent — spam.
5. Edit `wrangler.toml` if the repo moves.
6. `npm run deploy`.

The deployed URL shows up in the wrangler output, e.g.
`https://openmyst-bug-report.<your-subdomain>.workers.dev`. Paste it into
[`src/main/features/bugReport/index.ts`](../../src/main/features/bugReport/index.ts)
as `WORKER_URL`. If you set a `SHARED_SECRET`, also paste it as `SHARED_SECRET`
there.

## Security notes

- The PAT lives only in the worker's secret store; it never ships in the app.
- Rate limiting is per-IP, in-memory, ~5/hour. Reset on cold start. Upgrade
  to KV or a Durable Object if volume ever warrants it.
- `SHARED_SECRET` in the app binary is *obfuscation*, not authentication.
  Anyone who unpacks the app can read it. Treat spam as a when-not-if and
  keep the label + triage workflow ready.
