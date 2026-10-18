import { OpenApiContractValidator } from '../support/openapi-contract-validator';

describe('Support access OpenAPI contract (T084)', () => {
  const validator = new OpenApiContractValidator();
  const grant = {
    id: '10000000-0000-4000-8000-000000000001',
    granteeRole: 'Support',
    grantedBy: '10000000-0000-4000-8000-000000000002',
    grantedAt: '2026-10-18T19:00:00.000Z',
    expiresAt: '2026-10-19T19:00:00.000Z',
    revokedAt: null,
    expiredAt: null,
    status: 'active',
    permittedActions: ['workspace.summary.read'],
    usage: [],
  };

  it('validates GET 200 as complete grant and usage history', () => {
    validator.assertResponse('/support-access/grants', 'get', 200, [grant]);
  });

  it('validates POST request and schema-bearing 201 response', () => {
    validator.validateRequestBody('/support-access/grants', 'post', {
      granteeRole: 'Support',
      expiresAt: grant.expiresAt,
    });
    validator.assertResponse('/support-access/grants', 'post', 201, grant);
  });

  it('validates revoke 200 with the same history schema', () => {
    validator.assertResponse('/support-access/grants/{grantId}/revoke', 'post', 200, {
      ...grant,
      revokedAt: '2026-10-18T20:00:00.000Z',
      status: 'revoked',
    });
  });

  it('rejects incomplete history and undocumented role capability', () => {
    expect(() =>
      validator.assertResponse('/support-access/grants', 'get', 200, [{ id: grant.id }]),
    ).toThrow();
    expect(() =>
      validator.validateRequestBody('/support-access/grants', 'post', {
        granteeRole: 'SuperAdmin',
        expiresAt: grant.expiresAt,
      }),
    ).toThrow();
  });
});
