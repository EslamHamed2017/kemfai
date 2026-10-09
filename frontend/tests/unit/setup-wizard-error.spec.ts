import { classifySetupWizardError } from '../../src/app/(onboarding)/setup-wizard/setup-wizard-error';

describe('classifySetupWizardError', () => {
  it('maps 401/404 to session/feature kinds regardless of message', () => {
    expect(classifySetupWizardError(401, 'Authentication required')).toEqual({ kind: 'sessionExpired' });
    expect(classifySetupWizardError(404, 'This feature is not available')).toEqual({ kind: 'featureUnavailable' });
  });

  it('distinguishes trial-window 403 from role 403 by message', () => {
    expect(classifySetupWizardError(403, 'Trial window has ended; activate a subscription to continue')).toEqual({
      kind: 'trialExpired',
    });
    expect(classifySetupWizardError(403, 'Caller does not hold a role required for this endpoint')).toEqual({
      kind: 'forbiddenRole',
    });
  });

  it('treats every 409 as a configuration gap', () => {
    expect(
      classifySetupWizardError(409, "No VAT/tax validation rule is configured for this country"),
    ).toEqual({ kind: 'configGap' });
  });

  it('classifies 422 field failures by the field named in the message', () => {
    expect(classifySetupWizardError(422, 'country is required.')).toEqual({ kind: 'field', field: 'country' });
    expect(classifySetupWizardError(422, 'legal_name is required.')).toEqual({ kind: 'field', field: 'legal_name' });
    expect(classifySetupWizardError(422, 'trade_name is required.')).toEqual({ kind: 'field', field: 'trade_name' });
    expect(classifySetupWizardError(422, 'base_currency is required.')).toEqual({
      kind: 'field',
      field: 'base_currency',
    });
    expect(classifySetupWizardError(422, 'unknown currency code "ZZZ".')).toEqual({
      kind: 'field',
      field: 'base_currency',
    });
    expect(classifySetupWizardError(422, 'fiscal_year_start_month must be 1-12.')).toEqual({
      kind: 'field',
      field: 'fiscal_year_start_month',
    });
    expect(classifySetupWizardError(422, 'fiscal_year_start_day must be an integer 1-31.')).toEqual({
      kind: 'field',
      field: 'fiscal_year_start_day',
    });
    expect(
      classifySetupWizardError(422, "vat_tax_registration does not match the expected format for country 'Egypt'."),
    ).toEqual({ kind: 'field', field: 'vat_tax_registration' });
    expect(classifySetupWizardError(422, 'industry is required.')).toEqual({ kind: 'field', field: 'industry' });
    expect(classifySetupWizardError(422, 'accounting_setup_template is invalid.')).toEqual({
      kind: 'field',
      field: 'accounting_setup_template',
    });
  });

  it('classifies the setup/complete "required steps" 422 distinctly from a field failure', () => {
    expect(
      classifySetupWizardError(422, 'required step(s) not yet submitted: industry, accounting_setup'),
    ).toEqual({ kind: 'incompleteSteps' });
  });

  it('falls back to unexpected for an unrecognized 422 and any other status', () => {
    expect(classifySetupWizardError(422, 'something odd')).toEqual({ kind: 'unexpected' });
    expect(classifySetupWizardError(500, 'Company setup is temporarily unavailable')).toEqual({ kind: 'unexpected' });
  });

  it('handles a class-validator array message the same as a string', () => {
    expect(classifySetupWizardError(422, ['country is required.'])).toEqual({ kind: 'field', field: 'country' });
  });
});
