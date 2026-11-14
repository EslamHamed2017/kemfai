# Slice 1 security hardening (T096)

## Public account rate limits

The API applies fixed, per-client-IP windows before account service code runs:

| Endpoint | Limit | Window | Rejection |
|---|---:|---:|---|
| `POST /accounts/signup` | 5 attempts | 60 seconds | `429`, `Retry-After`, localized body |
| `POST /accounts/verify-email` | 10 attempts | 60 seconds | `429`, `Retry-After`, localized body |

`Accept-Language` selects Arabic (`ar`) or English (`en`, default) for the generic response.
The Compose deployment sets `KEMFAI_TRUST_PROXY_HOPS=1`, so Express trusts exactly the Traefik hop
and derives the client address from the forwarded chain; direct deployments leave this unset and use
the socket peer. Invalid hop counts fail startup. `proxy-addr` is pinned to patched release 2.0.8
to prevent IPv4-mapped IPv6 trust-subnet spoofing. The two routes use separate buckets. The in-process map is capped at 10,000 buckets; excess
new client keys share a fail-closed overflow bucket instead of creating unbounded state.
The Slice 1 deployment is one API process. A future multi-replica deployment must replace the
store with a shared atomic limiter before scaling out; multiplying the per-process allowance is
not an approved production topology.

## MinIO presigned URLs

All presigned upload and download URLs expire after at most **300 seconds (5 minutes)**. Callers
may request a shorter positive integer expiry only. Zero, fractions, negative values, and values
above 300 are rejected before the MinIO SDK is called. Tenant buckets remain private and browser
uploads are currently server-mediated.

## Keycloak user-provisioning service account

Production must configure `KEYCLOAK_USERS_CLIENT_ID=kemfai-users` and a deployment-owned
`KEYCLOAK_USERS_CLIENT_SECRET`. The confidential client has standard flow and direct grants
disabled, `fullScopeAllowed=false`, and exactly these `realm-management` client roles:

- `manage-users` — create/update/delete users, required actions, credentials, and role mappings.
- `view-realm` — read the `WorkspaceOwner` realm-role representation before mapping it.

`realm-admin` and broad full-scope access are forbidden. A partial client ID/secret fails closed.
Bootstrap-admin password grant is allowed only when
`KEYCLOAK_ALLOW_BOOTSTRAP_ADMIN_FALLBACK=true` **and** `NODE_ENV` is not `production`; production
ignores that opt-in. The API container does not receive bootstrap-admin credentials.

The realm import reads the client secret from `${KEYCLOAK_USERS_CLIENT_SECRET}`. Never commit a
real secret. Docker Compose requires the secret explicitly and refuses to render the stack when it is empty or
missing.
