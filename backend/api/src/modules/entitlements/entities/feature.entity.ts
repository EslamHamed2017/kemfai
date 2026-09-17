import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

export enum FeatureKind {
  MODULE = 'module',
  LIMIT = 'limit',
}

/**
 * A gate-able module or usage limit (data-model.md "Feature"). `key` (e.g. `module.accounting`)
 * is the stable identifier PlanFeatureEntitlement and FeatureFlag join against.
 */
@Entity({ name: 'feature' })
export class Feature {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'key', type: 'text', unique: true })
  key: string;

  @Column({ name: 'display_name', type: 'text' })
  displayName: string;

  @Column({ name: 'kind', type: 'enum', enum: FeatureKind, enumName: 'feature_kind_enum' })
  kind: FeatureKind;
}
