Set `SUPPORT_EMAIL` to a monitored support mailbox in the Next.js server environment before deployment. Without it the UI reports missing configuration rather than inventing a recipient. Playwright uses `support@example.test` as a test-only fixture.

The Billing Admin surface uses a separate internal OIDC client and session namespace. Configure
`INTERNAL_KEYCLOAK_ISSUER`, `INTERNAL_KEYCLOAK_BACKCHANNEL_URL`,
`INTERNAL_KEYCLOAK_JWKS_URI` (optional when the standard certs path is used),
`INTERNAL_KEYCLOAK_CLIENT_ID`, and `INTERNAL_KEYCLOAK_REDIRECT_URI`. The redirect URI must be
the app's `/internal-auth/callback`; the internal client must issue the API audience expected by
the Billing Admin API. Customer OIDC variables and cookies remain unchanged.

Set `NEXT_PUBLIC_PAYMENT_PROOF_ORIGINS` to a comma-separated allowlist of exact HTTP(S) origins
used for presigned proof downloads (for example, `https://evidence.example.com`). The review UI
fails closed and does not render a proof link when its origin is absent from this list.
