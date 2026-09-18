import { ExecutionContext, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FeatureFlagGuard } from './feature-flag.guard';
import { EntitlementsService } from '../../modules/entitlements/entitlements.service';

function makeContext(): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({}) }),
    getHandler: () => jest.fn(),
    getClass: () => jest.fn(),
  } as unknown as ExecutionContext;
}

function makeReflector(opts: { isPublic?: boolean; requiredFeatureFlag?: string }) {
  return {
    getAllAndOverride: jest.fn((key: string) => {
      if (key === 'kemfai:isPublicRoute') return opts.isPublic ?? false;
      if (key === 'kemfai:requiredFeatureFlag') return opts.requiredFeatureFlag;
      return undefined;
    }),
  } as unknown as Reflector;
}

function makeEntitlements(isFeatureFlagEnabled: jest.Mock) {
  return { isFeatureFlagEnabled } as unknown as EntitlementsService;
}

describe('FeatureFlagGuard (T100)', () => {
  it('passes @Public() routes without checking any feature flag', async () => {
    const isFeatureFlagEnabled = jest.fn();
    const guard = new FeatureFlagGuard(
      makeReflector({ isPublic: true }),
      makeEntitlements(isFeatureFlagEnabled),
    );

    await expect(guard.canActivate(makeContext())).resolves.toBe(true);
    expect(isFeatureFlagEnabled).not.toHaveBeenCalled();
  });

  it('passes a route with no @RequireFeatureFlag() declared', async () => {
    const isFeatureFlagEnabled = jest.fn();
    const guard = new FeatureFlagGuard(makeReflector({}), makeEntitlements(isFeatureFlagEnabled));

    await expect(guard.canActivate(makeContext())).resolves.toBe(true);
    expect(isFeatureFlagEnabled).not.toHaveBeenCalled();
  });

  it('allows a gated route when EntitlementsService reports the flag enabled', async () => {
    const isFeatureFlagEnabled = jest.fn().mockResolvedValue(true);
    const guard = new FeatureFlagGuard(
      makeReflector({ requiredFeatureFlag: 'module.checklist' }),
      makeEntitlements(isFeatureFlagEnabled),
    );

    await expect(guard.canActivate(makeContext())).resolves.toBe(true);
    expect(isFeatureFlagEnabled).toHaveBeenCalledWith('module.checklist');
  });

  it('denies a gated route with 404 (hidden, not merely forbidden) when the flag is disabled', async () => {
    const isFeatureFlagEnabled = jest.fn().mockResolvedValue(false);
    const guard = new FeatureFlagGuard(
      makeReflector({ requiredFeatureFlag: 'module.checklist' }),
      makeEntitlements(isFeatureFlagEnabled),
    );

    await expect(guard.canActivate(makeContext())).rejects.toThrow(NotFoundException);
  });

  it('denies identically regardless of how the request arrived (no separate UI-only code path exists)', async () => {
    const isFeatureFlagEnabled = jest.fn().mockResolvedValue(false);
    const guard = new FeatureFlagGuard(
      makeReflector({ requiredFeatureFlag: 'module.support_access' }),
      makeEntitlements(isFeatureFlagEnabled),
    );

    await expect(guard.canActivate(makeContext())).rejects.toThrow(NotFoundException);
    await expect(guard.canActivate(makeContext())).rejects.toThrow(NotFoundException);
    expect(isFeatureFlagEnabled).toHaveBeenCalledTimes(2);
  });
});
