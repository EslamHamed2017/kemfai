/**
 * Strips the stable `KEMFAI_<CODE>:` prefix the `kemfai_company_setup` Odoo addon puts on
 * every typed validation message (see company.py), leaving the human-readable remainder
 * for an HTTP error body. Shared by every BFF service that translates one of this addon's
 * `ValidationError`s (T054's company-setup.service.ts, T055's company-settings.service.ts).
 */
export function stripKemfaiPrefix(message: string): string {
  const match = message.match(/KEMFAI_[A-Z_]+:\s*(.*)$/);
  return match ? match[1] : message;
}
