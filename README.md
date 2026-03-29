# Investment API

This service can run locally as an Express server, and on Vercel as a serverless function.

## Local development

```bash
node index.js
```

## Vercel deployment

Deploy the repo as-is and set these environment variables in Vercel:

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `CONFIG_STORE_KEY` optional, defaults to `investment-dashboard:config`

When the Upstash variables are present, `sources`, `signalRules`, `thresholds`, and `settings` are stored remotely and survive Vercel redeploys.
Threshold current values are refreshed from a live market quote source on request, with a short in-memory TTL to keep the dashboard responsive.

## Endpoints

- `GET /news`
- `GET /signals`
- `GET /sources`
- `GET /settings`
- `GET /thresholds`
- `GET /admin/sources`
- `POST /admin/sources`
- `DELETE /admin/sources`
- `GET /admin/rules`
- `POST /admin/rules`
- `DELETE /admin/rules`
- `GET /admin/thresholds`
- `POST /admin/thresholds`
- `DELETE /admin/thresholds`
- `GET /admin/settings`
- `POST /admin/settings`
- `POST /admin/refresh`
