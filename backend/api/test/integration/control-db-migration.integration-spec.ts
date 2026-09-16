import controlDataSource from '../../src/database/data-source';

/**
 * T006 acceptance test. Requires a reachable Postgres configured via CONTROL_DB_* env vars
 * (see backend/api/src/database/data-source.ts), matching how every other integration/contract
 * suite in this project runs against live infra rather than mocks (plan.md Test Strategy).
 */
describe('kemfai_control DataSource (T006)', () => {
  afterAll(async () => {
    if (controlDataSource.isInitialized) {
      await controlDataSource.destroy();
    }
  });

  it('connects to kemfai_control and applies the empty baseline migration', async () => {
    await controlDataSource.initialize();

    const executed = await controlDataSource.runMigrations();
    expect(executed.some((m) => m.name.startsWith('Baseline'))).toBe(true);

    const migrationRows = await controlDataSource.query(
      'SELECT name FROM migrations WHERE name LIKE $1',
      ['Baseline%'],
    );
    expect(migrationRows.length).toBe(1);

    const [{ current_database: currentDatabase }] = await controlDataSource.query(
      'SELECT current_database()',
    );
    expect(currentDatabase).toBe(controlDataSource.options.database);
  });

  it('is structurally fixed to the control-plane database, not parameterizable per tenant', () => {
    // No tenant id (or any other argument) can ever be passed to select a different database at
    // call time — `database` is baked into the DataSourceOptions at module load from CONTROL_DB_*
    // env vars only, and controlDataSource is a singleton instance, not a factory function.
    expect(typeof controlDataSource).toBe('object');
    expect(controlDataSource.options.database).toBe(
      process.env.CONTROL_DB_NAME ?? 'kemfai_control',
    );
    expect(controlDataSource.options.database).not.toMatch(/^kemfai_tenant_/);
  });
});
