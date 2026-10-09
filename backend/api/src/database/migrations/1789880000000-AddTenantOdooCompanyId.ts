import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * T056 round-5 binding resolution (item 1) — `resolveByTenantId`'s `authenticate()` +
 * `res.company` `search` RPC was previously the ONLY way to learn a tenant's Odoo
 * company id, which forced `CompanySetupService` to touch Odoo before it could even
 * compute the expected `X-KEMFAI-Setup-Scope` to validate the caller's header against.
 * This column lets `TenantProvisionProcessor.verifyCompany` capture the company id ONCE,
 * at provisioning time (it already authenticates + searches `res.company` there to
 * verify cardinality), so `CompanyOdooContextService.resolveCompanyTarget` can resolve it
 * from the control-plane database alone — zero Odoo RPCs — before any scope/principal
 * precondition is checked.
 */
export class AddTenantOdooCompanyId1789880000000 implements MigrationInterface {
  name = 'AddTenantOdooCompanyId1789880000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "tenant" ADD COLUMN "odoo_company_id" integer NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "tenant" DROP COLUMN "odoo_company_id"`);
  }
}
