import { defineModule } from '../../../src/index.js';

/** Depends on good_module, so the requires[] rules have something real to act on. */
export const manifest = defineModule({
  key: 'needs_good',
  name: 'Needs Good',
  version: '0.2.0',
  minPlan: 'PRO',
  defaultEnabled: false,
  requires: ['good_module'],
  permissions: ['needs_good:read'],
  dataClasses: [
    { name: 'record', sensitivity: 'restricted', retention: 'P1Y', fieldEncrypted: true },
  ],
  purgePolicy: {
    onDisable: 'retain',
    retentionAfterDisable: 'P30D',
    purgeStrategy: 'anonymize',
    auditPurge: true,
  },
  nav: [{ label: 'Needs', path: '/needs', requiresPermission: 'needs_good:read' }],
  events: { publishes: [], consumes: ['good_module.happened'] },
});
