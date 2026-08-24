-- Fixture schema for ja-db, PostgreSQL.
--
-- Mirrors docker/mysql/01-schema.sql. Postgres additionally gets a second
-- schema, since it is one of the two dialects where objects nest inside one.

\connect shop

CREATE TABLE customers (
  id          serial PRIMARY KEY,
  name        varchar(120) NOT NULL,
  email       varchar(200) NULL,
  -- Past 2^53: must survive the trip to the webview as exact digits.
  big_id      bigint NOT NULL,
  balance     numeric(18, 4) NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  -- Deliberately mixes NULL and '' so the grid must distinguish them.
  notes       text NULL,
  payload     bytea NULL,
  created_at  timestamptz NOT NULL
);

CREATE INDEX idx_customers_email ON customers (email);

INSERT INTO customers (name, email, big_id, balance, is_active, notes, payload, created_at)
SELECT
  'Customer ' || n,
  CASE WHEN n % 7 = 0 THEN NULL ELSE 'user' || n || '@example.com' END,
  1780241234567890000 + n,
  round((n * 13.37)::numeric, 4),
  n % 2 = 1,
  CASE WHEN n % 11 = 0 THEN '' WHEN n % 5 = 0 THEN NULL ELSE 'Note for ' || n END,
  CASE WHEN n % 13 = 0 THEN '\xdeadbeefcafe'::bytea ELSE NULL END,
  timestamptz '2026-01-01 09:00:00+00' + (n || ' hours')::interval
FROM generate_series(1, 1200) AS n;

-- Composite primary key: the sort ja-db must fall back to when paginating
-- without an explicit ORDER BY.
CREATE TABLE order_lines (
  order_id   int NOT NULL,
  line_no    int NOT NULL,
  sku        varchar(40) NOT NULL,
  qty        int NOT NULL,
  unit_price numeric(12, 2) NOT NULL,
  PRIMARY KEY (order_id, line_no)
);

INSERT INTO order_lines (order_id, line_no, sku, qty, unit_price)
SELECT (n / 3) + 1, (n % 3) + 1,
       'SKU-' || lpad((n % 500)::text, 5, '0'),
       (n % 9) + 1,
       round((((n % 400) + 1) * 1.99)::numeric, 2)
FROM generate_series(1, 3000) AS n;

-- No primary key at all — pagination must still be stable.
CREATE TABLE events (
  occurred_at timestamptz NOT NULL,
  kind        varchar(40) NOT NULL,
  payload     jsonb NULL
);

INSERT INTO events (occurred_at, kind, payload)
SELECT timestamptz '2026-03-01 00:00:00+00' + (n || ' minutes')::interval,
       (ARRAY['login', 'logout', 'purchase', 'refund'])[(n % 4) + 1],
       jsonb_build_object('n', n, 'even', n % 2 = 0)
FROM generate_series(1, 800) AS n;

-- Identifiers that must be quoted: a space, a reserved word, and the
-- mixed case that postgres folds unless quoted.
CREATE TABLE "weird table" (
  "id"       int PRIMARY KEY,
  "select"   varchar(50) NOT NULL,
  "MixedCase" int NOT NULL
);

INSERT INTO "weird table" ("id", "select", "MixedCase") VALUES
  (1, 'quoting works', 10),
  (2, 'reserved words too', 20);

CREATE VIEW active_customers AS
  SELECT id, name, email, balance FROM customers WHERE is_active;

CREATE FUNCTION customer_balance(p_id int) RETURNS numeric AS $$
  SELECT balance FROM customers WHERE id = p_id;
$$ LANGUAGE sql STABLE;

CREATE PROCEDURE touch_customer(p_id int) AS $$
BEGIN
  UPDATE customers SET notes = coalesce(notes, '') || '.' WHERE id = p_id;
END;
$$ LANGUAGE plpgsql;

-- A non-public schema, so the tree has more than one schema to render.
CREATE SCHEMA reporting;

CREATE TABLE reporting.daily_totals (
  day   date PRIMARY KEY,
  total numeric(18, 2) NOT NULL
);

INSERT INTO reporting.daily_totals (day, total)
SELECT date '2026-01-01' + n, round((n * 91.5)::numeric, 2)
FROM generate_series(0, 364) AS n;

-- reltuples is -1 until a table has been analysed, which ja-db treats as
-- "unknown" and hides. Analysing makes the estimates in the tree real.
ANALYZE;

-- A second database, so switching databases in the UI has somewhere to go.
-- Postgres cannot switch database on an open connection, which is exactly the
-- behaviour this exercises.
CREATE DATABASE warehouse;

\connect warehouse

CREATE TABLE stock (
  sku      varchar(40) PRIMARY KEY,
  on_hand  int NOT NULL,
  location varchar(20) NOT NULL
);

INSERT INTO stock (sku, on_hand, location)
SELECT 'SKU-' || lpad(n::text, 5, '0'), (n * 7) % 250, 'BAY-' || ((n % 12) + 1)
FROM generate_series(1, 500) AS n;

ANALYZE;
