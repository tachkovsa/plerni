-- 003_fencing_authority.sql — the fencing authority for Spike B (plan §2/§4 B2).
-- One row per execution; conditional transitions make exactly one outcome win.
-- Kernel-internal machinery class (spec §5): no tenant RLS; reached only via service roles.

CREATE TABLE IF NOT EXISTS fencing_authority (
  id uuid PRIMARY KEY,
  plugin_id text NOT NULL,
  token text NOT NULL,
  status text NOT NULL CHECK (status IN ('QUEUED', 'ACTIVE', 'COMMITTED', 'CANCELLED', 'ABANDONED')),
  heartbeat_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- QUEUED at submission (sweeper never touches QUEUED); dispatch stamps heartbeat_at.
-- Terminal states (COMMITTED/CANCELLED/ABANDONED) are retained for retries/reconciliation.

GRANT SELECT, INSERT, UPDATE ON fencing_authority TO plerni_app;
-- No DELETE: outcomes are retained, never erased by the spike roles.
