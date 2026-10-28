import fs from 'node:fs';
import path from 'node:path';
import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';

const FIXTURE_LABEL =
  'kemfai.phase12.operation=t109-parent-gates-continuation-20261025T153344Z';

function attachmentText(attachment: TestResult['attachments'][number]): string | null {
  if (attachment.body) return attachment.body.toString('utf8');
  if (attachment.path) {
    try {
      return fs.readFileSync(attachment.path, 'utf8');
    } catch {
      return null;
    }
  }
  return null;
}

function parseAttachment(attachment: TestResult['attachments'][number]): unknown {
  const raw = attachmentText(attachment);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export default class T109EvidenceReporter implements Reporter {
  private readonly tests: Array<Record<string, unknown>> = [];
  private readonly observations: Array<Record<string, unknown>> = [];
  private readonly controls: Array<Record<string, unknown>> = [];

  onTestEnd(test: TestCase, result: TestResult): void {
    const observedForTest: Array<Record<string, unknown>> = [];
    const controlsForTest: Array<Record<string, unknown>> = [];
    for (const attachment of result.attachments) {
      const parsed = parseAttachment(attachment);
      if (attachment.name === 't109-http-observations' && Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item === 'object' && !Array.isArray(item)) {
            const observation = item as Record<string, unknown>;
            observedForTest.push(observation);
            this.observations.push(observation);
          }
        }
      }
      if (
        attachment.name === 't109-control-result' &&
        parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed)
      ) {
        const control = parsed as Record<string, unknown>;
        controlsForTest.push(control);
        this.controls.push(control);
      }
    }
    this.tests.push({
      title: test.titlePath().join(' > '),
      expectedStatus: test.expectedStatus,
      status: result.status,
      retry: result.retry,
      errors: result.errors.map((error) => error.message),
      durationMs: result.duration,
      observations: observedForTest,
      controls: controlsForTest,
    });
  }

  async onEnd(result: FullResult): Promise<void> {
    const evidenceDir = process.env.T109_EVIDENCE_DIR;
    if (!evidenceDir || !path.isAbsolute(evidenceDir)) {
      throw new Error('T109_EVIDENCE_DIR must be an absolute path');
    }
    const skipped = this.tests.filter((item) => item.status === 'skipped').length;
    const unexpected = this.tests.filter(
      (item) => !['passed', 'skipped'].includes(String(item.status)),
    ).length;
    const flaky = this.tests.filter((item) => Number(item.retry) > 0).length;
    const errors = this.tests.reduce(
      (total, item) => total + (Array.isArray(item.errors) ? item.errors.length : 0),
      0,
    );
    const surfaceCoverage = [...new Set(this.observations.map((item) => item.surface))].sort();
    const endpointCoverage = [
      ...new Set(this.observations.map((item) => `${item.branch}:${item.endpoint}`)),
    ].sort();
    const summary = {
      fixtureLabel: FIXTURE_LABEL,
      spec: 'frontend/tests/e2e/full-surface-odoo-exposure-sweep.spec.ts',
      status: result.status,
      counts: {
        total: this.tests.length,
        passed: this.tests.filter((item) => item.status === 'passed').length,
        skipped,
        flaky,
        unexpected,
        errors,
        observations: this.observations.length,
        controls: this.controls.length,
      },
      requiredZeroCounts: { skipped, flaky, unexpected, errors },
      observedCoverage: { surfaces: surfaceCoverage, endpoints: endpointCoverage },
      controls: this.controls,
      observations: this.observations,
      tests: this.tests,
    };
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(
      path.join(evidenceDir, 'browser-summary.json'),
      `${JSON.stringify(summary, null, 2)}\n`,
      { mode: 0o600 },
    );
  }
}
