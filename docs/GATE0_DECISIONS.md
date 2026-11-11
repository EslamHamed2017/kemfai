# Gate 0 - Decisions Tracker

Decisions that must be frozen before production architecture is final (Spec section 27).

## Locked (from Spec section 29)
| # | Decision | Status | Rule |
|---|----------|--------|------|
| 1 | Tenant DB | LOCKED | Separate DB per customer from launch |
| 2 | Billing V1 | LOCKED | Manual bank transfer + Billing Admin activation |
| 3 | Billing Phase 2 | LOCKED | Stripe behind KEMFAI Billing Service |
| 4 | Languages | LOCKED | English + Arabic Day 1, full LTR/RTL |
| 5 | Country Compliance | LOCKED PRINCIPLE | Country packs per official regs, versioned |
| 6 | Accounting Policies | LOCKED — v1.0 APPROVED 2026-11-07 | Explicit versioned Accounting Policy Matrix; production activation remains subject to implementation, test, independent-review and acceptance gates |

## Still OPEN (owner to decide)
| # | Decision | Options | Recommended default | Owner decision |
|---|----------|---------|---------------------|----------------|
| A | Auth provider | Keycloak (self-host) / Auth0 / Supabase Auth / Clerk | Keycloak self-hosted | LOCKED 2026-09-13 |
| B | File storage | Local disk / MinIO (self-host S3) / AWS S3 / Bunny | MinIO self-hosted (S3-compatible) | LOCKED 2026-09-13 |
| C | API/BFF stack | Node/TS (NestJS) / Python (FastAPI) | NestJS (matches Next.js TS, OpenAPI-first) | LOCKED 2026-09-13 |
| D | Ask KEMFAI AI provider | OmniRoute (Claude/GLM) / direct API | OmniRoute (multi-model failover) | LOCKED 2026-09-13 |
| E | Odoo version | 17 / 18 / 19 Community | 18 Community (stable, LTS-ish) | Using 18 for dev |

## Notes
- Auth and storage decisions block Slice 1 (SaaS shell). Everything else can start.
- API/BFF stack blocks Slice 1 backend contract.
- Recommend owner confirms A, B, C so Slice 1 can proceed at full speed.
