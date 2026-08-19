export const manifest = {
  key: 'jsmod',
  name: 'JS Module',
  version: '1.0.0',
  minPlan: 'FREE',
  defaultEnabled: false,
  requires: [],
  permissions: ['jsmod:read'],
  dataClasses: [{ name: 'thing', sensitivity: 'standard', retention: 'P1Y' }],
  purgePolicy: {
    onDisable: 'retain',
    retentionAfterDisable: 'P90D',
    purgeStrategy: 'hard_delete',
    auditPurge: true,
  },
  nav: [],
  events: { publishes: [], consumes: [] },
};
