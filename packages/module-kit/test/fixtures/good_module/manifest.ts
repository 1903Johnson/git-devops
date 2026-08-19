import { defineModule } from '../../../src/index.js';

export const manifest = defineModule({
  key: 'good_module',
  name: 'Good Module',
  version: '1.0.0',
  minPlan: 'FREE',
  defaultEnabled: true,
  requires: [],
  permissions: ['good_module:read', 'good_module:manage'],
  dataClasses: [{ name: 'note', sensitivity: 'standard', retention: 'P2Y' }],
  purgePolicy: {
    onDisable: 'retain',
    retentionAfterDisable: 'P90D',
    purgeStrategy: 'hard_delete',
    auditPurge: true,
  },
  nav: [{ label: 'Good', path: '/good', requiresPermission: 'good_module:read' }],
  events: { publishes: ['good_module.happened'], consumes: [] },
});
