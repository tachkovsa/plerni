-- SPDX-License-Identifier: Apache-2.0
-- Notification plumbing (plan K12). Preferences and deliveries are
-- tenant-domain rows. The delivery row is the in-app channel: it stores the
-- text the caller already rendered. The kernel does not render that text.
-- The approval for this migration is unsigned. The maintainer signs it.

CREATE TABLE IF NOT EXISTS kernel.notification_preference (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  recipient_id uuid NOT NULL,
  channel text NOT NULL,
  enabled boolean NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT notification_preference_channel CHECK (channel = 'in_app'),
  CONSTRAINT notification_preference_once UNIQUE (tenant_id, recipient_id, channel)
);

ALTER TABLE kernel.notification_preference ENABLE ROW LEVEL SECURITY;
ALTER TABLE kernel.notification_preference FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON kernel.notification_preference;
CREATE POLICY tenant_isolation ON kernel.notification_preference
  USING (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid);

REVOKE ALL ON TABLE kernel.notification_preference FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE kernel.notification_preference TO plerni_app;

CREATE TABLE IF NOT EXISTS kernel.notification_delivery (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  idempotency_key text NOT NULL,
  recipient_id uuid NOT NULL,
  channel text NOT NULL,
  body text NOT NULL,
  outcome text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT notification_delivery_channel CHECK (channel = 'in_app'),
  CONSTRAINT notification_delivery_outcome CHECK (outcome IN ('delivered', 'suppressed')),
  CONSTRAINT notification_delivery_key_shape CHECK (
    idempotency_key ~ '^[A-Za-z0-9._:-]{1,200}$'
  ),
  CONSTRAINT notification_delivery_body_len CHECK (char_length(body) BETWEEN 1 AND 4000),
  CONSTRAINT notification_delivery_once UNIQUE (tenant_id, idempotency_key)
);

ALTER TABLE kernel.notification_delivery ENABLE ROW LEVEL SECURITY;
ALTER TABLE kernel.notification_delivery FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON kernel.notification_delivery;
CREATE POLICY tenant_isolation ON kernel.notification_delivery
  USING (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid);

REVOKE ALL ON TABLE kernel.notification_delivery FROM PUBLIC;
GRANT SELECT, INSERT ON TABLE kernel.notification_delivery TO plerni_app;
