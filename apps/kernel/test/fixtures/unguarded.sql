-- SPDX-License-Identifier: Apache-2.0
-- Negative fixture: no row security. A context-less read returns every tenant.
CREATE TABLE kernel.fixture_unguarded (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  marker text NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.fixture_unguarded TO plerni_app;
