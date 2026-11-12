-- SPDX-License-Identifier: Apache-2.0
-- Relay cursors, delivery dedup, and retention on the log K2 created.
-- kernel.outbox and kernel.outbox_seq are not recreated. seq stays a
-- nextval allocation. This file does not lock the sequence.
-- Subscriptions, deliveries, and dead letters are kernel-internal: no row
-- security, no tenant policy. The approval artifact for this migration is
-- not in this commit. The maintainer signs it.

ALTER TABLE kernel.outbox
  ADD CONSTRAINT outbox_aggregate_type_shape CHECK (
    char_length(aggregate_type) BETWEEN 1 AND 200
    AND aggregate_type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'
  );

ALTER TABLE kernel.outbox
  ADD CONSTRAINT outbox_type_shape CHECK (
    type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2}$'
  );

-- Retention deletes rows strictly below the slowest cursor. The app role
-- is the relay identity in this process.
GRANT DELETE ON TABLE kernel.outbox TO plerni_app;

CREATE TABLE kernel.subscription (
  id uuid PRIMARY KEY,
  last_seq bigint NOT NULL,
  status text NOT NULL,
  park_reason text,
  fence bigint NOT NULL,
  filter jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT subscription_status CHECK (status IN ('live', 'parked')),
  CONSTRAINT subscription_last_seq_nonnegative CHECK (last_seq >= 0),
  CONSTRAINT subscription_fence_positive CHECK (fence > 0),
  CONSTRAINT subscription_filter_array CHECK (jsonb_typeof(filter) = 'array'),
  CONSTRAINT subscription_park CHECK (
    (status = 'live' AND park_reason IS NULL)
    OR (status = 'parked' AND park_reason = 'UNKNOWN_EVENT_VERSION')
  )
);

CREATE INDEX subscription_live_cursor
  ON kernel.subscription (last_seq, id)
  WHERE status = 'live';

REVOKE ALL ON TABLE kernel.subscription FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE kernel.subscription TO plerni_app;

-- UNIQUE(subscription, seq) is the primary key. A second delivery of the
-- same pair inserts no second effect.
CREATE TABLE kernel.delivery (
  subscription_id uuid NOT NULL REFERENCES kernel.subscription (id),
  seq bigint NOT NULL,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT delivery_subscription_seq PRIMARY KEY (subscription_id, seq),
  CONSTRAINT delivery_seq_positive CHECK (seq > 0),
  CONSTRAINT delivery_key_shape CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{1,200}$')
);

REVOKE ALL ON TABLE kernel.delivery FROM PUBLIC;
GRANT SELECT, INSERT ON TABLE kernel.delivery TO plerni_app;

CREATE TABLE kernel.dead_letter (
  subscription_id uuid NOT NULL REFERENCES kernel.subscription (id),
  seq bigint NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (subscription_id, seq),
  CONSTRAINT dead_letter_seq_positive CHECK (seq > 0),
  CONSTRAINT dead_letter_reason CHECK (reason = 'HANDLER_FAILED')
);

REVOKE ALL ON TABLE kernel.dead_letter FROM PUBLIC;
GRANT SELECT, INSERT ON TABLE kernel.dead_letter TO plerni_app;
