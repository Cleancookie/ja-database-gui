-- Sample database for ja-db: a small, invented online shop.
--
-- Deterministic on purpose: no random(), no current time. Every row comes from
-- recursive CTEs and fixed arithmetic, so building it twice gives the same data.
-- Each table says what it is here to demonstrate.

PRAGMA foreign_keys = ON;

-- categories: a self-referencing foreign key (parent_id) and NULLs (top-level
-- categories have no parent).
CREATE TABLE categories (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL,
  parent_id INTEGER REFERENCES categories (id)
);
INSERT INTO categories (id, name, parent_id) VALUES
  (1, 'Home', NULL),
  (2, 'Garden', NULL),
  (3, 'Office', NULL),
  (4, 'Kitchen', 1),
  (5, 'Lighting', 1),
  (6, 'Tools', 2),
  (7, 'Planters', 2),
  (8, 'Desks', 3),
  (9, 'Stationery', 3);

-- customers: booleans stored as 0/1 (is_active, marketing_opt_in), NULLs
-- (phone), empty strings (company), ISO dates, and a long text column (notes).
CREATE TABLE customers (
  id               INTEGER PRIMARY KEY,
  name             TEXT NOT NULL,
  email            TEXT NOT NULL UNIQUE,
  phone            TEXT,
  company          TEXT NOT NULL DEFAULT '',
  is_active        BOOLEAN NOT NULL DEFAULT 1,
  marketing_opt_in BOOLEAN NOT NULL DEFAULT 0,
  signed_up        DATE NOT NULL,
  notes            TEXT
);
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 120),
first_names(k, v) AS (VALUES (0,'Ada'),(1,'Grace'),(2,'Linus'),(3,'Margaret'),(4,'Alan'),(5,'Edsger'),
  (6,'Barbara'),(7,'Ken'),(8,'Radia'),(9,'Dennis'),(10,'Hedy'),(11,'Tim')),
last_names(k, v) AS (VALUES (0,'Lovelace'),(1,'Hopper'),(2,'Torvalds'),(3,'Hamilton'),(4,'Turing'),
  (5,'Dijkstra'),(6,'Liskov'),(7,'Thompson'),(8,'Perlman'),(9,'Ritchie'),(10,'Lamarr'),(11,'Berners-Lee'),(12,'Knuth'))
INSERT INTO customers (id, name, email, phone, company, is_active, marketing_opt_in, signed_up, notes)
SELECT
  i,
  f.v || ' ' || l.v,
  lower(f.v) || '.' || lower(replace(l.v, '-', '')) || i || '@example.com',
  CASE WHEN i % 4 = 0 THEN NULL ELSE printf('+44 7700 %06d', 900000 + i * 37) END,
  CASE WHEN i % 3 = 0 THEN 'Acme Ltd' WHEN i % 7 = 0 THEN 'Globex' ELSE '' END,
  CASE WHEN i % 9 = 0 THEN 0 ELSE 1 END,
  i % 2,
  date('2023-01-01', '+' || ((i * 13) % 600) || ' days'),
  CASE WHEN i % 10 = 0
    THEN substr(replace(hex(zeroblob(20)), '00', 'Prefers delivery after 6pm; leave with neighbour if out. '), 1, 400)
  END
FROM n
JOIN first_names f ON f.k = i % 12
JOIN last_names l ON l.k = i % 13;

-- products: JSON text (attributes), a long description, and a boolean.
CREATE TABLE products (
  id          INTEGER PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES categories (id),
  sku         TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  in_stock    BOOLEAN NOT NULL DEFAULT 1,
  description TEXT,
  attributes  TEXT
);
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 40),
adj(k, v) AS (VALUES (0,'Oak'),(1,'Steel'),(2,'Ceramic'),(3,'Linen'),(4,'Brass'),(5,'Slate')),
noun(k, v) AS (VALUES (0,'Lamp'),(1,'Planter'),(2,'Desk'),(3,'Trowel'),(4,'Notebook'),(5,'Kettle'),(6,'Shelf'))
INSERT INTO products (id, category_id, sku, name, price_cents, in_stock, description, attributes)
SELECT
  i,
  4 + (i % 6),
  printf('SKU-%04d', i),
  a.v || ' ' || nn.v,
  499 + (i * 797) % 14500,
  CASE WHEN i % 8 = 0 THEN 0 ELSE 1 END,
  CASE WHEN i % 5 <> 0
    THEN substr(replace(hex(zeroblob(15)), '00', 'Made to last, with a finish that ages well. '), 1, 320)
  END,
  json_object('colour', CASE i % 3 WHEN 0 THEN 'natural' WHEN 1 THEN 'black' ELSE 'white' END,
              'weight_g', 150 + i * 23,
              'tags', json_array('home', CASE WHEN i % 2 = 0 THEN 'gift' ELSE 'everyday' END))
FROM n
JOIN adj a ON a.k = i % 6
JOIN noun nn ON nn.k = i % 7;

-- orders: foreign key to customers, NULL shipped_at for unshipped orders,
-- ISO timestamps, and an empty-string note.
CREATE TABLE orders (
  id          INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers (id),
  status      TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'shipped', 'cancelled')),
  ordered_at  DATETIME NOT NULL,
  shipped_at  DATETIME,
  note        TEXT NOT NULL DEFAULT ''
);
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 400)
INSERT INTO orders (id, customer_id, status, ordered_at, shipped_at, note)
SELECT
  i,
  1 + (i * 7) % 120,
  CASE i % 10 WHEN 0 THEN 'cancelled' WHEN 1 THEN 'pending' WHEN 2 THEN 'paid' ELSE 'shipped' END,
  datetime('2024-01-01 09:00:00', '+' || (i * 53) || ' minutes', '+' || ((i * 37) % 300) || ' days'),
  CASE WHEN i % 10 > 2
    THEN datetime('2024-01-01 09:00:00', '+' || (i * 53) || ' minutes', '+' || ((i * 37) % 300 + 2) || ' days')
  END,
  CASE WHEN i % 15 = 0 THEN 'Gift wrap please' ELSE '' END
FROM n;

-- order_items: a composite primary key (order_id, line_no) and two foreign keys.
CREATE TABLE order_items (
  order_id         INTEGER NOT NULL REFERENCES orders (id),
  line_no          INTEGER NOT NULL,
  product_id       INTEGER NOT NULL REFERENCES products (id),
  quantity         INTEGER NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  PRIMARY KEY (order_id, line_no)
);
WITH RECURSIVE o(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM o WHERE i < 400),
l(ln) AS (VALUES (1), (2), (3))
INSERT INTO order_items (order_id, line_no, product_id, quantity, unit_price_cents)
SELECT i, ln, p.id, 1 + (i + ln) % 4, p.price_cents
FROM o
JOIN l ON ln <= 1 + i % 3
JOIN products p ON p.id = 1 + (i * 5 + ln * 11) % 40;

CREATE INDEX idx_orders_customer ON orders (customer_id);
CREATE INDEX idx_order_items_product ON order_items (product_id);

-- order_totals: a view. Views are listed beside tables and browsable, but have
-- no primary key to edit by.
CREATE VIEW order_totals AS
SELECT o.id AS order_id,
       c.name AS customer,
       o.status,
       o.ordered_at,
       COUNT(oi.line_no) AS lines,
       SUM(oi.quantity * oi.unit_price_cents) AS total_cents
FROM orders o
JOIN customers c ON c.id = o.customer_id
LEFT JOIN order_items oi ON oi.order_id = o.id
GROUP BY o.id;

-- events: the big one, 6,000 rows, for infinite scroll and pagination.
-- user_id is NULL for anonymous visits; payload is JSON text.
CREATE TABLE events (
  id          INTEGER PRIMARY KEY,
  occurred_at DATETIME NOT NULL,
  user_id     INTEGER REFERENCES customers (id),
  kind        TEXT NOT NULL,
  path        TEXT NOT NULL,
  payload     TEXT
);
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 6000)
INSERT INTO events (id, occurred_at, user_id, kind, path, payload)
SELECT
  i,
  datetime('2024-03-01 00:00:00', '+' || (i * 41) || ' seconds'),
  CASE WHEN i % 3 = 0 THEN NULL ELSE 1 + (i * 11) % 120 END,
  CASE i % 5 WHEN 0 THEN 'page_view' WHEN 1 THEN 'page_view' WHEN 2 THEN 'click' WHEN 3 THEN 'search' ELSE 'add_to_cart' END,
  CASE i % 4 WHEN 0 THEN '/' WHEN 1 THEN '/products' WHEN 2 THEN '/cart' ELSE printf('/products/%d', 1 + i % 40) END,
  json_object('session', printf('s%05d', i / 6), 'ms', 20 + (i * 17) % 900)
FROM n;
CREATE INDEX idx_events_occurred_at ON events (occurred_at);

-- audit_log: deliberately has NO primary key, to show the read-only behaviour:
-- without a key there is no safe way to say which row an edit means.
CREATE TABLE audit_log (
  at     DATETIME NOT NULL,
  actor  TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT
);
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 40)
INSERT INTO audit_log (at, actor, action, detail)
SELECT
  datetime('2024-06-01 08:00:00', '+' || (i * 90) || ' minutes'),
  CASE i % 3 WHEN 0 THEN 'system' WHEN 1 THEN 'ada' ELSE 'grace' END,
  CASE i % 4 WHEN 0 THEN 'login' WHEN 1 THEN 'refund' WHEN 2 THEN 'price_change' ELSE 'export' END,
  CASE WHEN i % 2 = 0 THEN printf('order %d', i * 3) END
FROM n;
