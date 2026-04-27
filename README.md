# finixhub-jobs

Scheduled data pipeline jobs for [finixhub.co](https://finixhub.co).

**This repo contains scripts and GitHub Actions workflows only — no application code, no user data, no secrets committed.**

## Why public?

GitHub gives unlimited free Actions minutes to public repositories. All 7 scheduled cron jobs live here. The main `finixhub` app repo stays private.

## Jobs

| Workflow | Schedule | What it does |
|---|---|---|
| `news-scraper.yml` | every 30 min | Scrapes 5 crypto RSS feeds → Supabase |
| `daily-data-pipeline.yml` | 00:30 UTC | OHLCV sync, metrics, indicators, AI insights |
| `calculate-indicators.yml` | 00:45 UTC | Recalculates technical indicators for all assets |
| `price-movement-summary.yml` | 08:00 + 16:00 UTC | AI-generated price summaries |
| `update-live-demo.yml` | 00:00 UTC | Refreshes live demo plan data |
| `db-backup.yml` | 03:00 UTC | pg_dump → private backup repo |
| `backfill.yml` | manual only | Historical OHLCV backfill |

## Adding a new job

1. Write the script in `scripts/`
2. Copy `.github/workflows/_template.yml` to a new file
3. Set `timeout-minutes`, `concurrency.group`, and `permissions: contents: read`
4. Add required secrets to this repo's Settings → Secrets and variables → Actions
5. Test with `workflow_dispatch` before enabling the scheduled trigger
6. **Never** add `pull_request:` triggers — forks would get workflow runs

## Local development

```bash
cp .env.example .env
# Fill in SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and any AI keys
npm install
npm run scraper        # Test news scraper
npm run calc-indicators
```

## Security

- No hardcoded secrets — all credentials via `process.env.*`
- Secrets live in GitHub Actions Secrets only
- Workflow permissions: `contents: read` (minimum)
- See `documentation/security/secret-rotation-runbook.md` in the main repo for rotation procedures
