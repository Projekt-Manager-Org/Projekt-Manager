/**
 * `offset` — how many rows a list skips. Postgres reads OFFSET as a
 * bigint and fails the query past its range (22003, or 22P02 once the
 * driver sends the number in exponent form), so the value needs a cap;
 * the cap is the largest integer a JS number holds exactly.
 */
export const LIST_OFFSET_SCHEMA = {
  type: 'integer',
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
} as const;
