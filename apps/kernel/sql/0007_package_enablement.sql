-- SPDX-License-Identifier: Apache-2.0
-- Package registry and per-tenant enablement (plan §3.2, §4.4, K18).
-- Watermarks, the installation cursor, and quota warnings are kernel-internal:
-- no row security, no tenant policy. A tenant enablement row does not grant
-- privileges and does not write kernel.plugin_grant.
-- The approval artifact for this migration is not in this commit.
-- The maintainer signs it against these bytes.

ALTER TABLE kernel.subscription
  ADD COLUMN exported_at timestamptz,
  ADD COLUMN released_at timestamptz,
  ADD CONSTRAINT subscription_release CHECK (
    released_at IS NULL OR exported_at IS NOT NULL
  );

ALTER TABLE kernel.dead_letter DROP CONSTRAINT dead_letter_reason;
ALTER TABLE kernel.dead_letter
  ADD CONSTRAINT dead_letter_reason CHECK (reason IN ('HANDLER_FAILED', 'FORCE_ADVANCE'));

CREATE TABLE kernel.package (
  id text PRIMARY KEY,
  version text NOT NULL,
  digest text NOT NULL,
  status text NOT NULL,
  subscription_id uuid NOT NULL UNIQUE REFERENCES kernel.subscription (id),
  requires jsonb NOT NULL,
  optional_requires jsonb NOT NULL,
  exported_at timestamptz,
  installed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT package_id CHECK (id ~ '^[a-z][a-z0-9_]{0,40}$'),
  CONSTRAINT package_version CHECK (version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  CONSTRAINT package_digest CHECK (digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT package_status CHECK (status = 'active'),
  CONSTRAINT package_requires_array CHECK (jsonb_typeof(requires) = 'array'),
  CONSTRAINT package_optional_array CHECK (jsonb_typeof(optional_requires) = 'array')
);

REVOKE ALL ON TABLE kernel.package FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE kernel.package TO plerni_app;

-- One watermark per tenant. released_at drops it out of the retention minimum.
-- That column is set only after the package export is recorded.
CREATE TABLE kernel.package_enablement (
  package_id text NOT NULL REFERENCES kernel.package (id),
  tenant_id uuid NOT NULL REFERENCES kernel.tenants (id),
  enabled boolean NOT NULL,
  watermark_seq bigint NOT NULL,
  held_since timestamptz NOT NULL DEFAULT clock_timestamp(),
  released_at timestamptz,
  PRIMARY KEY (package_id, tenant_id),
  CONSTRAINT enablement_watermark_nonnegative CHECK (watermark_seq >= 0),
  CONSTRAINT enablement_release CHECK (released_at IS NULL OR enabled = false)
);

REVOKE ALL ON TABLE kernel.package_enablement FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE kernel.package_enablement TO plerni_app;

-- One warning per hold and reason. Quota expiry inserts a row and deletes nothing.
CREATE TABLE kernel.quota_warning (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id text,
  tenant_id uuid,
  subscription_id uuid,
  reason text NOT NULL,
  warned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT quota_warning_reason CHECK (reason IN ('age', 'bytes')),
  CONSTRAINT quota_warning_subject CHECK (
    (package_id IS NOT NULL AND tenant_id IS NOT NULL AND subscription_id IS NULL)
    OR (package_id IS NULL AND tenant_id IS NULL AND subscription_id IS NOT NULL)
  ),
  CONSTRAINT quota_warning_package_fk FOREIGN KEY (package_id) REFERENCES kernel.package (id),
  CONSTRAINT quota_warning_tenant_fk FOREIGN KEY (tenant_id) REFERENCES kernel.tenants (id),
  CONSTRAINT quota_warning_subscription_fk FOREIGN KEY (subscription_id) REFERENCES kernel.subscription (id),
  CONSTRAINT quota_warning_once UNIQUE NULLS NOT DISTINCT (package_id, tenant_id, subscription_id, reason)
);

REVOKE ALL ON TABLE kernel.quota_warning FROM PUBLIC;
GRANT SELECT, INSERT ON TABLE kernel.quota_warning TO plerni_app;
