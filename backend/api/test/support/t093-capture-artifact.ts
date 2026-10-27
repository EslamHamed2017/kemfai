import { readFileSync } from 'fs';
import { T093_NEGATIVE_FIXTURES } from './t093-observer';

export interface T093Capture {
  event_id: string;
  fixture_id: string | null;
  validation_outcome: string;
}

export function loadAndVerifyT093Captures(path: string): T093Capture[] {
  const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
  const rows = lines.map((line, index) => {
    const artifact = JSON.parse(line);
    if (typeof artifact.suite_key !== 'string' || !artifact.capture) {
      throw new Error(`invalid T093 capture artifact line ${index + 1}`);
    }
    return artifact.capture as T093Capture;
  });
  if (!rows.length) throw new Error('T093 capture artifact is empty');
  if (new Set(rows.map((row) => row.event_id)).size !== rows.length) {
    throw new Error('a persisted audit write was aggregated more than once');
  }
  if (rows.some((row) => !['linked', 'expected-negative'].includes(row.validation_outcome))) {
    throw new Error('a persisted audit write has no terminal linkage result');
  }
  for (const fixtureId of Object.keys(T093_NEGATIVE_FIXTURES)) {
    const matches = rows.filter((row) => row.fixture_id === fixtureId);
    if (matches.length !== 1 || matches[0].validation_outcome !== 'expected-negative') {
      throw new Error(`negative fixture ${fixtureId} was not aggregated exactly once`);
    }
  }
  return rows;
}
