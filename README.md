# KEMFAI - Finance. Connected.

Cloud accounting and financial-management SaaS for Gulf + Egypt.

Formula: QuickBooks simplicity x Odoo business power x KEMFAI intelligence.

## Documents (source of truth)
- docs/KEMFAI_Blueprint_v1.0.pdf - Product Blueprint (locked baseline)
- docs/KEMFAI_Implementation_Spec_v1.1_FINAL.pdf - Implementation Spec v1.1 FINAL
- docs/KEMFAI_Spec_v1.1_FINAL.txt - plain-text spec for agents
- docs/KEMFAI_Blueprint_v1.0.txt - plain-text blueprint for agents

## Architecture (locked)

    Public Website + KEMFAI App UI    Next.js + React (Carbon-based)
                |
    KEMFAI API / BFF                  controlled boundary
                |
    Odoo Community + kemfai_ modules  Business + accounting engine
                |
    PostgreSQL - DB per tenant        Isolated per customer from launch

## Locked pre-build decisions (Spec Section 29)
| Decision | Rule |
|----------|------|
| Tenant DB | Separate DB per customer from launch |
| Billing V1 | Manual bank transfer + Billing Admin activation |
| Billing Phase 2 | Stripe behind KEMFAI Billing Service |
| Languages | English + Arabic Day 1, full LTR/RTL |
| Country Compliance | Country packs per official regulations |
| Accounting Policies | Explicit Accounting Policy Matrix |

## Multi-agent execution
See AGENTS.md for agent roles, responsibilities and no-blocker rules.

## Repo layout
- frontend/ - Next.js + React app (KEMFAI UI)
- backend/ - Odoo Community modules (kemfai_) + API/BFF
- infra/ - Docker compose, Traefik, environments
- docs/ - locked product baseline and references
- scripts/ - utilities (provisioning, migration, testing)
- tests/ - accounting-invariant, tenant-isolation, E2E suites

## Status
- Gate 0 - foundation setup (in progress)
- P0 launch scope - see Spec Section 23

## License and trademark

KEMFAI source code is licensed under the [GNU General Public License v3.0](LICENSE), except for third-party components that retain their own licenses. Distributed derivative works must comply with the GPL.

The **KEMFAI** name, logos, and brand identity are not licensed under the GPL. Modified distributions must use different branding and must not imply official status or endorsement. See [TRADEMARK_POLICY.md](TRADEMARK_POLICY.md).
