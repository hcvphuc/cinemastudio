---
description: Deploy Cinema Studio to Vercel production
---

# Deploy to Vercel

## Prerequisites
- Vercel CLI installed globally (`npm install -g vercel`)
- Vercel Token: `$VERCEL_TOKEN`
- Production URL: `https://cinemastudio.vercel.app`
- Project name on Vercel: `ionic-asteroid`

## Steps

// turbo-all

1. Build production bundle
```
npm run build
```

2. Deploy to Vercel production
```
vercel deploy --prod --yes --token=$VERCEL_TOKEN
```

3. Alias to cinemastudio.vercel.app (use the deployment URL from step 2)
```
vercel alias set <DEPLOYMENT_URL> cinemastudio.vercel.app --token=$VERCEL_TOKEN
```

4. Verify deployment is live by opening `https://cinemastudio.vercel.app`

## Environment Variables (already configured on Vercel)
- `VITE_SUPABASE_URL` = `https://tskccpvdcoacsskxrise.supabase.co`
- `VITE_SUPABASE_ANON_KEY` = (JWT token, already set)

## Notes
- `.vercelignore` excludes `node_modules`, `*.zip`, `*.log`, `.env.local`
- If env vars need updating: `vercel env add <KEY> production --token=...`
- Old alias `ionic-asteroid.vercel.app` has been removed
