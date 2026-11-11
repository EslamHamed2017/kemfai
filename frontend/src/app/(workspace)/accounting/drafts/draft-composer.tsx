"use client";

import { useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

type Account = {
  id: string;
  code: string;
  name: { en: string; ar: string };
  nodeKind: "parent" | "posting";
  active: boolean;
  selectableForDraftLines?: boolean;
};
type LocalizedName = { en: string; ar: string };
type DimensionDefinition = { id: string; key: string; name: LocalizedName; active: boolean };
type DimensionValue = {
  id: string; definitionId: string; code: string; name: LocalizedName; active: boolean;
};
type Journal = {
  id: string; code: string; name: LocalizedName; journalType: string; active: boolean;
  selectableForDrafts?: boolean; version: number;
};
type CurrencyConfiguration = {
  id: string; currencyCode: string; enabled: boolean; isBase: boolean;
  nativeDecimalPlaces: number; nativeMetadataVersion: string; version: number;
};
type DraftLine = {
  id: string;
  account: Account;
  dimensions: Record<string, string>;
  transactionCurrencyCode: string;
  transactionDebit: string;
  transactionCredit: string;
  baseDebit: string;
  baseCredit: string;
  rateReference: string;
  rateEffectiveDate: string;
};
type SavedDraft = { id: string; version: number; ledgerEffect: "none" };
type ValidationIssue = {
  code: string; messageKey: string; lineId?: string | null;
  resourceId?: string | null; field?: string | null;
};
type ValidationResult = {
  draftId: string;
  draftVersion: number;
  status: "valid_for_draft" | "invalid";
  ledgerEffect: "none";
  issues: ValidationIssue[];
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  policyBlockers: ValidationIssue[];
  companyBaseCurrencyCode: string;
  basePrecision: number;
  baseDebitTotal: string;
  baseCreditTotal: string;
  configurationSnapshot: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isAccount(value: unknown): value is Account {
  if (!isRecord(value) || !isRecord(value.name)) return false;
  return typeof value.id === "string" && typeof value.code === "string" &&
    typeof value.name.en === "string" && typeof value.name.ar === "string" &&
    (value.nodeKind === "parent" || value.nodeKind === "posting") &&
    typeof value.active === "boolean";
}

function isPostingEligible(account: Account): boolean {
  return account.active && account.nodeKind === "posting" && account.selectableForDraftLines !== false;
}

function isLocalizedName(value: unknown): value is LocalizedName {
  return isRecord(value) && typeof value.en === "string" && typeof value.ar === "string";
}

function isDimensionDefinition(value: unknown): value is DimensionDefinition {
  return isRecord(value) && typeof value.id === "string" && typeof value.key === "string" &&
    isLocalizedName(value.name) && typeof value.active === "boolean";
}

function isDimensionValue(value: unknown): value is DimensionValue {
  return isRecord(value) && typeof value.id === "string" && typeof value.definitionId === "string" &&
    typeof value.code === "string" && isLocalizedName(value.name) && typeof value.active === "boolean";
}

function isJournal(value: unknown): value is Journal {
  return isRecord(value) && typeof value.id === "string" && typeof value.code === "string" &&
    isLocalizedName(value.name) && typeof value.journalType === "string" &&
    typeof value.active === "boolean" && Number.isSafeInteger(value.version);
}

function isCurrencyConfiguration(value: unknown): value is CurrencyConfiguration {
  return isRecord(value) && typeof value.id === "string" && typeof value.currencyCode === "string" &&
    typeof value.enabled === "boolean" && typeof value.isBase === "boolean" &&
    Number.isSafeInteger(value.nativeDecimalPlaces) &&
    typeof value.nativeMetadataVersion === "string" && Number.isSafeInteger(value.version);
}

function collection<T>(value: unknown, guard: (item: unknown) => item is T): T[] | null {
  return isRecord(value) && Array.isArray(value.items) && value.items.every(guard) ? value.items : null;
}

function accountPage(value: unknown): { items: Account[]; nextCursor: string | null } | null {
  if (!isRecord(value) || !Array.isArray(value.items) || !value.items.every(isAccount)) return null;
  if (!(value.nextCursor === undefined || value.nextCursor === null || typeof value.nextCursor === "string")) return null;
  return { items: value.items, nextCursor: value.nextCursor ?? null };
}

function savedDraft(value: unknown): SavedDraft | null {
  if (!isRecord(value) || !isRecord(value.resource)) return null;
  const resource = value.resource;
  return typeof resource.id === "string" && Number.isSafeInteger(resource.version) &&
    resource.ledgerEffect === "none"
    ? { id: resource.id, version: resource.version as number, ledgerEffect: "none" }
    : null;
}

function isValidationIssue(value: unknown): value is ValidationIssue {
  return isRecord(value) && typeof value.code === "string" && typeof value.messageKey === "string" &&
    (value.lineId === undefined || value.lineId === null || typeof value.lineId === "string") &&
    (value.resourceId === undefined || value.resourceId === null || typeof value.resourceId === "string") &&
    (value.field === undefined || value.field === null || typeof value.field === "string");
}

function validationResult(value: unknown): ValidationResult | null {
  if (!isRecord(value) || !isRecord(value.result)) return null;
  const result = value.result;
  const errors = result.errors ?? [];
  const warnings = result.warnings ?? [];
  const policyBlockers = result.policyBlockers ?? [];
  if (!Array.isArray(errors) || !errors.every(isValidationIssue) ||
      !Array.isArray(warnings) || !warnings.every(isValidationIssue) ||
      !Array.isArray(policyBlockers) || !policyBlockers.every(isValidationIssue)) return null;
  return typeof result.draftId === "string" && Number.isSafeInteger(result.draftVersion) &&
    (result.status === "valid_for_draft" || result.status === "invalid") && result.ledgerEffect === "none"
    ? {
        ...(result as unknown as Omit<ValidationResult, "issues">),
        errors,
        warnings,
        policyBlockers,
        issues: [...errors, ...warnings, ...policyBlockers],
        companyBaseCurrencyCode: typeof result.companyBaseCurrencyCode === "string" ? result.companyBaseCurrencyCode : "",
        basePrecision: Number.isSafeInteger(result.basePrecision) ? result.basePrecision as number : 0,
        baseDebitTotal: typeof result.baseDebitTotal === "string" ? result.baseDebitTotal : "",
        baseCreditTotal: typeof result.baseCreditTotal === "string" ? result.baseCreditTotal : "",
        configurationSnapshot: isRecord(result.configurationSnapshot) ? result.configurationSnapshot : {},
      }
    : null;
}

function operationKey(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function DraftComposer({ companyId }: { companyId?: string } = {}) {
  const t = useTranslations("accountingDraft");
  const locale = useLocale() === "ar" ? "ar" : "en";
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [dimensionDefinitions, setDimensionDefinitions] = useState<DimensionDefinition[]>([]);
  const [dimensionValues, setDimensionValues] = useState<DimensionValue[]>([]);
  const [journals, setJournals] = useState<Journal[]>([]);
  const [currencies, setCurrencies] = useState<CurrencyConfiguration[]>([]);
  const [accountId, setAccountId] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [selectionError, setSelectionError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedDraft | null>(null);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [journalId, setJournalId] = useState("");
  const [accountingDate, setAccountingDate] = useState("");
  const [description, setDescription] = useState("");
  const accountSelectRef = useRef<HTMLSelectElement>(null);
  const lineCurrencyRefs = useRef(new Map<number, HTMLSelectElement>());
  const rateReferenceRefs = useRef(new Map<number, HTMLInputElement>());
  const dimensionSelectRefs = useRef(new Map<string, HTMLSelectElement>());
  const saveKey = useRef<string | null>(null);
  const validateKey = useRef<string | null>(null);
  const headers = useMemo<HeadersInit>(() => ({
    "accept-language": locale,
    ...(companyId ? { "x-kemfai-company-id": companyId } : {}),
  }), [companyId, locale]);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const loaded: Account[] = [];
        const seenCursors = new Set<string>();
        let cursor: string | null = null;
        do {
          const query: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
          const response = await fetch(`/api/accounting/v1/accounts?active=true${query}`, {
            cache: "no-store", headers, signal: controller.signal,
          });
          const body: unknown = await response.json();
          const page = response.ok ? accountPage(body) : null;
          if (!page) throw new Error("draft account load failed");
          loaded.push(...page.items);
          cursor = page.nextCursor;
          if (cursor && seenCursors.has(cursor)) throw new Error("draft account cursor repeated");
          if (cursor) seenCursors.add(cursor);
        } while (cursor);
        async function optionalItems<T>(url: string, guard: (item: unknown) => item is T): Promise<T[]> {
          try {
            const response = await fetch(url, { cache: "no-store", headers, signal: controller.signal });
            if (!response?.ok) return [];
            return collection(await response.json(), guard) ?? [];
          } catch {
            if (controller.signal.aborted) throw new Error("aborted");
            return [];
          }
        }
        const [definitions, values, loadedJournals, loadedCurrencies] = await Promise.all([
          optionalItems("/api/accounting/v1/dimension-definitions", isDimensionDefinition),
          optionalItems("/api/accounting/v1/dimension-values", isDimensionValue),
          optionalItems("/api/accounting/v1/journals?includeInactive=true", isJournal),
          optionalItems("/api/accounting/v1/currencies?includeDisabled=true", isCurrencyConfiguration),
        ]);
        setAccounts(loaded);
        setDimensionDefinitions(definitions.filter(({ active }) => active));
        setDimensionValues(values);
        setJournals(loadedJournals);
        setCurrencies(loadedCurrencies);
        setJournalId(loadedJournals.find(({ active, selectableForDrafts }) => active && selectableForDrafts !== false)?.id ?? "");
        setPhase("ready");
      } catch {
        if (!controller.signal.aborted) setPhase("error");
      }
    })();
    return () => controller.abort();
  }, [headers]);

  function invalidateSavedDraft(): void {
    saveKey.current = null;
    validateKey.current = null;
    setValidation(null);
    setMutationError(null);
  }

  function addLine(): void {
    const account = accounts.find(({ id }) => id === accountId);
    if (!account || !isPostingEligible(account)) {
      setSelectionError(true);
      accountSelectRef.current?.focus();
      return;
    }
    setSelectionError(false);
    invalidateSavedDraft();
    const base = currencies.find(({ isBase }) => isBase);
    setLines((current) => [...current, {
      id: crypto.randomUUID(), account, dimensions: {},
      transactionCurrencyCode: base?.currencyCode ?? "",
      transactionDebit: "0", transactionCredit: "0", baseDebit: "0", baseCredit: "0",
      rateReference: "", rateEffectiveDate: "",
    }]);
  }

  function updateLine(index: number, values: Partial<DraftLine>): void {
    invalidateSavedDraft();
    setLines((current) => current.map((line, lineIndex) => lineIndex === index
      ? { ...line, ...values }
      : line));
  }

  function selectDimension(lineId: string, definitionId: string, valueId: string): void {
    invalidateSavedDraft();
    setLines((current) => current.map((line) => line.id === lineId
      ? { ...line, dimensions: { ...line.dimensions, [definitionId]: valueId } }
      : line));
  }

  async function saveDraft(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy || lines.length === 0) return;
    const base = currencies.find(({ isBase }) => isBase);
    const missingFxIndex = lines.findIndex((line) =>
      !!base && line.transactionCurrencyCode !== base.currencyCode &&
      (!line.rateReference.trim() || !line.rateEffectiveDate));
    if (missingFxIndex >= 0) {
      setMutationError("errors.rateReferenceEffectiveRequired");
      rateReferenceRefs.current.get(missingFxIndex)?.focus();
      return;
    }
    setBusy(true);
    setMutationError(null);
    setValidation(null);
    const existing = saved;
    const key = saveKey.current ?? operationKey(existing ? "draft-update" : "draft-save");
    saveKey.current = key;
    const payload = {
      journalId,
      accountingDate,
      description,
      transactionType: "manual_journal",
      source: null,
      lines: lines.map((line, index) => {
        const currency = currencies.find(({ currencyCode }) => currencyCode === line.transactionCurrencyCode);
        return {
          id: line.id,
          sequence: index + 1,
          accountId: line.account.id,
          transactionCurrencyCode: currency?.currencyCode ?? line.transactionCurrencyCode,
          transactionPrecision: currency?.nativeDecimalPlaces ?? 2,
          transactionCurrencyMetadataVersion: currency?.nativeMetadataVersion ?? "",
          companyBaseCurrencyCode: base?.currencyCode ?? "",
          basePrecision: base?.nativeDecimalPlaces ?? 2,
          baseCurrencyMetadataVersion: base?.nativeMetadataVersion ?? "",
          currencyConfigurationVersion: currency?.version ?? 1,
          transactionDebit: line.transactionDebit,
          transactionCredit: line.transactionCredit,
          baseDebit: line.baseDebit,
          baseCredit: line.baseCredit,
          rateReference: !base || line.transactionCurrencyCode === base.currencyCode ? null : line.rateReference,
          rateEffectiveDate: !base || line.transactionCurrencyCode === base.currencyCode ? null : line.rateEffectiveDate,
          dimensions: Object.entries(line.dimensions)
            .filter(([, valueId]) => valueId !== "")
            .map(([definitionId, valueId]) => ({ definitionId, valueId })),
        };
      }),
    };
    try {
      const response = await fetch(existing
        ? `/api/accounting/v1/drafts/${encodeURIComponent(existing.id)}`
        : "/api/accounting/v1/drafts", {
        method: existing ? "PUT" : "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
          "idempotency-key": key,
          ...(existing ? { "if-match": `"${existing.version}"` } : {}),
        },
        body: JSON.stringify(payload),
      });
      const body: unknown = await response.json();
      if (response.status === 412) {
        const field = isRecord(body) && Array.isArray(body.issues) && isRecord(body.issues[0])
          ? body.issues[0].field : null;
        const match = typeof field === "string" ? /^lines\.(\d+)\./.exec(field) : null;
        const staleIndex = match ? Number(match[1]) : 0;
        setMutationError("errors.configurationStale");
        lineCurrencyRefs.current.get(staleIndex)?.focus();
        return;
      }
      const draft = response.ok ? savedDraft(body) : null;
      if (!draft) throw new Error("draft save failed");
      saveKey.current = null;
      validateKey.current = null;
      setSaved(draft);
    } catch {
      setMutationError("errors.mutation");
    } finally {
      setBusy(false);
    }
  }

  async function validateDraft(): Promise<void> {
    if (!saved || busy) return;
    setBusy(true);
    setMutationError(null);
    const key = validateKey.current ?? operationKey("draft-validate");
    validateKey.current = key;
    try {
      const response = await fetch(`/api/accounting/v1/drafts/${encodeURIComponent(saved.id)}/validate`, {
        method: "POST",
        headers: { ...headers, "idempotency-key": key, "if-match": `"${saved.version}"` },
      });
      const body: unknown = await response.json();
      const result = response.ok ? validationResult(body) : null;
      if (!result) throw new Error("draft validation failed");
      validateKey.current = null;
      setValidation(result);
      setSaved({ ...saved, version: result.draftVersion });
      const firstMissing = result.issues.find(({ code, resourceId }) =>
        code === "DIMENSION_REQUIRED" && resourceId);
      if (firstMissing?.resourceId) dimensionSelectRefs.current.get(firstMissing.resourceId)?.focus();
    } catch {
      setMutationError("errors.mutation");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main
      className="kemfai-accounting-surface"
      dir={locale === "ar" ? "rtl" : "ltr"}
      data-testid="draft-composer"
      style={{ minWidth: 0, maxWidth: "100%", overflowWrap: "anywhere" }}
    >
      <h1>{t("title")}</h1>
      {phase === "loading" && <p role="status">{t("loading")}</p>}
      {phase === "error" && <p role="alert">{t("errors.load")}</p>}
      {phase === "ready" && <form onSubmit={saveDraft} onChange={invalidateSavedDraft}>
        <label>{t("fields.account")}
          <select
            ref={accountSelectRef}
            data-testid="draft-account"
            aria-invalid={selectionError || undefined}
            aria-describedby={selectionError ? "draft-account-error" : undefined}
            value={accountId} onChange={(event) => { setAccountId(event.target.value); setSelectionError(false); }}>
            <option value="">{t("accounts.selectPlaceholder")}</option>
            {accounts.map((account) => <option key={account.id} value={account.id}>
              {account.code} - {account.name[locale]} - {isPostingEligible(account) ? t("accounts.postingEligible") : t("accounts.notPostingEligible")}
            </option>)}
          </select>
        </label>
        <button type="button" data-testid="draft-line-add" onClick={addLine}>{t("actions.addLine")}</button>
        {selectionError && <p id="draft-account-error" role="alert" aria-live="assertive">{t("errors.accountNotPosting")}</p>}
        <label>{t("fields.journalId")}
          <select data-testid="draft-journal" value={journalId} onChange={(event) => setJournalId(event.target.value)}>
            <option value="">{t("journals.selectPlaceholder")}</option>
            {journals.map((journal) => <option
              key={journal.id}
              value={journal.id}
              disabled={!journal.active && journal.id !== journalId}
              data-historical={!journal.active ? "true" : undefined}
            >{journal.code} — {journal.name[locale]}</option>)}
          </select>
        </label>
        <label>{t("fields.accountingDate")}<input type="date" data-testid="draft-accounting-date" value={accountingDate} onChange={(event) => setAccountingDate(event.target.value)} /></label>
        <label>{t("fields.description")}<input value={description} onChange={(event) => setDescription(event.target.value)} /></label>
        {lines.length > 0 && <ul aria-label={t("lines.label")}>
          {lines.map((line, lineIndex) => <li key={line.id} data-testid={`draft-line-${lineIndex}`} data-account-id={line.account.id}>
            <span>{line.account.code} - {line.account.name[locale]}</span>
            {dimensionDefinitions.map((definition) => {
              const issue = validation?.issues.find(({ code, resourceId }) =>
                code === "DIMENSION_REQUIRED" && resourceId === definition.id);
              return <label key={definition.id}>{definition.name[locale]}
                <select
                  ref={(node) => {
                    if (lineIndex === 0 && node) dimensionSelectRefs.current.set(definition.id, node);
                    else if (lineIndex === 0) dimensionSelectRefs.current.delete(definition.id);
                  }}
                  data-testid={lineIndex === 0 ? `draft-dimension-${definition.id}` : `draft-dimension-${definition.id}-${line.id}`}
                  value={line.dimensions[definition.id] ?? ""}
                  aria-invalid={issue ? "true" : undefined}
                  aria-describedby={issue ? "draft-dimension-errors" : undefined}
                  onChange={(event) => selectDimension(line.id, definition.id, event.target.value)}
                >
                  <option value="">{t("dimensions.selectPlaceholder")}</option>
                  {dimensionValues.filter(({ definitionId }) => definitionId === definition.id).map((value) =>
                    <option key={value.id} value={value.id} disabled={!value.active && line.dimensions[definition.id] !== value.id} data-historical={!value.active ? "true" : undefined}>
                      {value.code} — {value.name[locale]}
                    </option>)}
                </select>
              </label>;
            })}
            <label>{t("fields.transactionCurrencyCode")}
              <select
                ref={(node) => { if (node) lineCurrencyRefs.current.set(lineIndex, node); else lineCurrencyRefs.current.delete(lineIndex); }}
                data-testid={`draft-line-${lineIndex}-transaction-currency`}
                value={line.transactionCurrencyCode}
                onChange={(event) => updateLine(lineIndex, { transactionCurrencyCode: event.target.value, rateReference: "", rateEffectiveDate: "" })}
              >
                <option value="">{t("currencies.selectPlaceholder")}</option>
                {currencies.map((currency) => <option
                  key={currency.id}
                  value={currency.currencyCode}
                  disabled={!currency.enabled && line.transactionCurrencyCode !== currency.currencyCode}
                  data-historical={!currency.enabled ? "true" : undefined}
                >{currency.currencyCode}</option>)}
              </select>
            </label>
            <label>{t("fields.transactionDebit")}<input required inputMode="decimal" data-testid={`draft-line-${lineIndex}-transaction-debit`} value={line.transactionDebit} onChange={(event) => updateLine(lineIndex, { transactionDebit: event.target.value })} /></label>
            <label>{t("fields.transactionCredit")}<input required inputMode="decimal" data-testid={`draft-line-${lineIndex}-transaction-credit`} value={line.transactionCredit} onChange={(event) => updateLine(lineIndex, { transactionCredit: event.target.value })} /></label>
            <label>{t("fields.baseDebit")}<input required inputMode="decimal" data-testid={`draft-line-${lineIndex}-base-debit`} value={line.baseDebit} onChange={(event) => updateLine(lineIndex, { baseDebit: event.target.value })} /></label>
            <label>{t("fields.baseCredit")}<input required inputMode="decimal" data-testid={`draft-line-${lineIndex}-base-credit`} value={line.baseCredit} onChange={(event) => updateLine(lineIndex, { baseCredit: event.target.value })} /></label>
            {line.transactionCurrencyCode !== currencies.find(({ isBase }) => isBase)?.currencyCode && <>
              <label>{t("fields.rateReference")}<input ref={(node) => { if (node) rateReferenceRefs.current.set(lineIndex, node); else rateReferenceRefs.current.delete(lineIndex); }} data-testid={`draft-line-${lineIndex}-rate-reference`} value={line.rateReference} onChange={(event) => updateLine(lineIndex, { rateReference: event.target.value })} /></label>
              <label>{t("fields.rateEffectiveDate")}<input type="date" data-testid={`draft-line-${lineIndex}-rate-effective-date`} value={line.rateEffectiveDate} onChange={(event) => updateLine(lineIndex, { rateEffectiveDate: event.target.value })} /></label>
            </>}
          </li>)}
        </ul>}

        <p>{t("nonPostingNotice")}</p>
        <button type="submit" data-testid="draft-save" disabled={busy || lines.length === 0}>{t("actions.save")}</button>
      </form>}
      {saved && <p role="status" data-testid="draft-saved">{t("saved")} — {saved.ledgerEffect}</p>}
      {saved && <button type="button" data-testid="draft-validate" disabled={busy} onClick={() => void validateDraft()}>{t("actions.validate")}</button>}
      {validation?.issues.some(({ code }) => code.startsWith("DIMENSION_")) &&
        <section id="draft-dimension-errors" role="alert" aria-label={t("dimensions.errorsLabel")} aria-live="assertive">
          <p>{t("dimensions.errorsSummary")}</p>
          <ul>{validation.issues.filter(({ code }) => code.startsWith("DIMENSION_")).map((issue, index) => {
            const definition = dimensionDefinitions.find(({ id }) => id === issue.resourceId);
            return <li key={`${issue.code}-${issue.lineId}-${issue.resourceId}-${index}`}>
              {definition?.name[locale] ?? t("dimensions.unknown")} — {t(`errors.${issue.code}`)}
            </li>;
          })}</ul>
        </section>}
      {validation && <section
        data-testid="draft-preview"
        data-ledger-effect={validation.ledgerEffect}
        aria-live="polite"
      >
        <h2>{t("preview.title")}</h2>
        <p><strong>{t("preview.nonPosting")}</strong> {t("nonPostingNotice")}</p>
        <dl>
          <dt>{t("preview.companyBaseCurrency")}</dt><dd>{validation.companyBaseCurrencyCode}</dd>
          <dt>{t("preview.basePrecision")}</dt><dd>{validation.basePrecision}</dd>
          <dt>{t("preview.baseDebitTotal")}</dt><dd>{validation.baseDebitTotal}</dd>
          <dt>{t("preview.baseCreditTotal")}</dt><dd>{validation.baseCreditTotal}</dd>
        </dl>
        <details>
          <summary>{t("preview.configurationSnapshot")}</summary>
          <pre>{JSON.stringify(validation.configurationSnapshot, null, 2)}</pre>
        </details>
        {([
          [t("preview.errors"), validation.errors],
          [t("preview.warnings"), validation.warnings],
          [t("preview.policyBlockers"), validation.policyBlockers],
        ] as const).map(([label, issues]) => issues.length > 0 && <section key={label}>
          <h3>{label}</h3>
          <ul>{issues.map((issue, index) => <li key={`${label}-${issue.code}-${issue.lineId}-${issue.resourceId}-${index}`}>
            <strong>{issue.code}</strong>{issue.field ? ` — ${issue.field}` : ""}
          </li>)}</ul>
        </section>)}
      </section>}
      {validation && <p role="status" data-testid="draft-validation">{validation.status} — {validation.ledgerEffect}</p>}
      {mutationError && <p role="alert">{t(mutationError)}</p>}
    </main>
  );
}
