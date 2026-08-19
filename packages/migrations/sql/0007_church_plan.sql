-- The plan a church is on, so entitlement has something to check against.
--
-- docs/01 §5 separates two questions: entitlement ("may this church's plan have this
-- module?") and enablement ("has an admin turned it on?"). A module runs only when both
-- are true. CORE-022 built enablement; this column is the other half.
--
-- Deliberately a single column on church rather than a subscription table. Billing
-- (CORE-033) owns subscriptions, Stripe, trials and proration, and will drive this column
-- from them — at which point this becomes a denormalised projection of the subscription,
-- which is what the entitlement check wants anyway: one indexed value on a row it is
-- already reading, not a join into a billing aggregate on every request.
ALTER TABLE church ADD COLUMN plan text NOT NULL DEFAULT 'FREE'
  CHECK (plan IN ('FREE', 'BASIC', 'PRO', 'ENTERPRISE'));

COMMENT ON COLUMN church.plan IS
  'Entitlement tier, compared against module_definition.min_plan. Owned by Billing '
  '(CORE-033) once subscriptions exist; until then it is set at provisioning.';
