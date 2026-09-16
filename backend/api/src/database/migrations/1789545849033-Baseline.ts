import { MigrationInterface } from 'typeorm';

/**
 * Establishes the kemfai_control migration baseline (T006). Intentionally empty — the first entity
 * migrations land in T007+.
 */
export class Baseline1789545849033 implements MigrationInterface {
  name = 'Baseline1789545849033';

  public async up(): Promise<void> {}

  public async down(): Promise<void> {}
}
