-- SPDX-License-Identifier: Apache-2.0
-- Job handoff marker. The outbox row is the intent. One transaction claims
-- this row, inserts the job, and marks it dispatched. A pending row stays
-- in the log: retention skips it. A dispatched row leaves with its outbox
-- row. The approval artifact for this migration is not in this commit.
-- The maintainer signs it. 0005, 0006, and 0007 belong to other tasks.

CREATE TABLE kernel.job_dispatch (
  seq bigint PRIMARY KEY REFERENCES kernel.outbox (seq) ON DELETE CASCADE,
  status text NOT NULL,
  job_id uuid,
  dispatched_at timestamptz,
  CONSTRAINT job_dispatch_status CHECK (status IN ('pending', 'dispatched')),
  CONSTRAINT job_dispatch_shape CHECK (
    (status = 'pending' AND job_id IS NULL AND dispatched_at IS NULL)
    OR (status = 'dispatched' AND job_id IS NOT NULL AND dispatched_at IS NOT NULL)
  )
);

REVOKE ALL ON TABLE kernel.job_dispatch FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE kernel.job_dispatch TO plerni_app;
