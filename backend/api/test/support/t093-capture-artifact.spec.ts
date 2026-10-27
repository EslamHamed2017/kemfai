import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { T093_NEGATIVE_FIXTURES } from './t093-observer';
import { loadAndVerifyT093Captures } from './t093-capture-artifact';

describe('T093 isolated capture aggregation', () => {
  const directory = mkdtempSync(join(tmpdir(), 't093-captures-'));
  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  function artifact(extra: object[] = []): string {
    const captures = Object.keys(T093_NEGATIVE_FIXTURES).map((fixtureId, index) => ({
      suite_key: index % 2 ? 'migration' : 'dedupe',
      capture: {
        event_id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        fixture_id: fixtureId,
        validation_outcome: 'expected-negative',
      },
    }));
    const path = join(directory, `${Math.random()}.jsonl`);
    writeFileSync(path, [...captures, ...extra].map((row) => JSON.stringify(row)).join('\n'));
    return path;
  }

  it('accepts exact wrapper IDs collected from independently named suites', () => {
    expect(loadAndVerifyT093Captures(artifact())).toHaveLength(
      Object.keys(T093_NEGATIVE_FIXTURES).length,
    );
  });

  it('fails when the same persisted write is aggregated twice', () => {
    const duplicate = {
      suite_key: 'other-suite',
      capture: {
        event_id: '10000000-0000-4000-8000-000000000001',
        fixture_id: null,
        validation_outcome: 'linked',
      },
    };
    expect(() => loadAndVerifyT093Captures(artifact([duplicate]))).toThrow(/more than once/);
  });
});
