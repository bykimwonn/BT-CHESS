# Hosting cost guidance

Prices below are indicative public list prices observed on **26 October 2026**, in USD, excluding tax, VAT, domain registration, email delivery, legal/compliance work, payment-provider fees, age-verification/KYC charges and operator staff time. Verify current prices on each provider's pricing page before committing.

This application needs one always-on Node process, PostgreSQL with backups, HTTPS, SMTP, and persistent secrets. Free tiers that sleep, expire databases or lack backups are unsuitable for financial records.

## Indicative monthly cost

| Option | Small production configuration | Approximate monthly cost | Notes |
| --- | --- | --- | --- |
| Local / CI | Existing machine + PGlite | $0 | Not a public production deployment. |
| Railway | Hobby plan + metered app/Postgres resources | From **$5** | Hobby is $5/month and includes $5 of usage; CPU, RAM, storage and egress beyond credits are metered. [Railway pricing](https://railway.com/pricing), [plan details](https://docs.railway.com/pricing/plans). |
| Render | Starter web service + Basic-256mb PostgreSQL | About **$13–$18** | $7 starter web + $6 basic Postgres + storage/egress; Hobby workspace $0. Pro workspace adds $25 if needed. Free Postgres expires and is not suitable. [Render pricing overview](https://livemy.app/blog/render-pricing), [workload comparison](https://www.prisma.io/blog/app-hosting-platforms-with-managed-postgres-2026). |
| Neon + any Node host | Neon Free/Launch + one small host | $0–$20+ | Neon Free includes 100 CU-hours and 1 GB storage/project; Launch is about $0.106/CU-hour and $0.35/GB-month, with a typical spend around $15/month. [Neon pricing](https://neon.com/pricing), [plan limits](https://neon.com/docs/introduction/plans). |
| Fly.io | 512 MB Machine + self-managed Postgres volume | About **$6–$12** | 512 MB Machine $3.69/month, volume $0.15/GB-month; egress varies by region. [Fly pricing](https://fly.io/pricing/), [resource pricing](https://docs.fly.io/about/pricing). |
| Fly.io Managed Postgres | 512 MB Machine + Basic managed Postgres | About **$44** | Fly's own example: $3.69 machine + $38 Basic Postgres + storage + egress. [Fly resource pricing](https://docs.fly.io/about/pricing). |
| Self-managed VPS | 1–2 vCPU VPS + PostgreSQL + backups | About **$5–$30** | Cheapest raw compute, but you own patching, backups, high availability and incident response. |

## Recommended baseline

For a serious free-chess or internal-test deployment: managed PostgreSQL with automated backups plus one 512 MB–1 GB Node instance. Budget **$15–$45/month** on a PaaS before traffic, egress, observability and email costs. For authorised real-money operation, budget separately for:

- legal opinion and licence application/renewal;
- payment-provider setup, transaction fees, chargebacks and settlement delays;
- 18+ identity verification, AML/KYC and sanctions screening;
- tax/withholding advice and reporting;
- independent security/penetration testing;
- enhanced monitoring, WAF, DDoS protection and support;
- redundant database/backups and possibly multi-region capacity.

These compliance and payment costs are unknown without an operator's jurisdiction and provider contracts; this repository deliberately does not invent them.

## Cost controls

- Keep `OPERATING_MODE=free` until activation; no paid provider calls are needed.
- Set `ENGINE_MAX_CONCURRENT` and `/analysis` rate limits to cap CPU usage.
- Use a single API instance for the included in-process timers; if scaling horizontally, move maintenance jobs to one worker.
- Use managed PostgreSQL backups rather than PGlite on ephemeral disks.
- Monitor egress; Stockfish WASM is ~1.8 MB once and is cacheable.
