-- SPDX-License-Identifier: MIT
-- Copyright (C) 2026 Jen Soltys. See LICENSE.
-- Click ids the Worker has already counted. A batch can be stored while its answer is
-- lost, and the extension then sends it again; a click whose id is here isn't counted
-- twice. Rows older than 90 days are cleared as new clicks arrive.
CREATE TABLE click_ops (
  op_id TEXT PRIMARY KEY,
  seen_at TEXT NOT NULL
);

CREATE INDEX idx_click_ops_seen ON click_ops(seen_at);
