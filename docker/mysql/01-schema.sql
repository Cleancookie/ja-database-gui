-- Fixture schema for ja-db, MySQL / MariaDB.
--
-- Shaped to exercise the cases this app is most likely to get wrong. See
-- docker/README.md for what each table is for.

SET SESSION cte_max_recursion_depth = 100000;

CREATE DATABASE IF NOT EXISTS shop;
CREATE DATABASE IF NOT EXISTS warehouse;
USE shop;

-- Every interesting column type in one table.
CREATE TABLE customers (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(120) NOT NULL,
  email       VARCHAR(200) NULL,
  -- Past 2^53: must survive the trip to the webview as exact digits.
  big_id      BIGINT NOT NULL,
  balance     DECIMAL(18, 4) NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  -- Deliberately mixes NULL and '' so the grid must distinguish them.
  notes       TEXT NULL,
  payload     BLOB NULL,
  created_at  DATETIME NOT NULL,
  KEY idx_customers_email (email)
) ENGINE = InnoDB;

INSERT INTO customers (name, email, big_id, balance, is_active, notes, payload, created_at)
WITH RECURSIVE seq (n) AS (
  SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 1200
)
SELECT
  CONCAT('Customer ', n),
  CASE WHEN n % 7 = 0 THEN NULL ELSE CONCAT('user', n, '@example.com') END,
  1780241234567890000 + n,
  ROUND(n * 13.37, 4),
  n % 2,
  CASE WHEN n % 11 = 0 THEN '' WHEN n % 5 = 0 THEN NULL ELSE CONCAT('Note for ', n) END,
  CASE WHEN n % 13 = 0 THEN UNHEX('DEADBEEFCAFE') ELSE NULL END,
  DATE_ADD('2026-01-01 09:00:00', INTERVAL n HOUR)
FROM seq;

-- Composite primary key: the sort ja-db must fall back to when paginating
-- without an explicit ORDER BY.
CREATE TABLE order_lines (
  order_id    INT NOT NULL,
  line_no     INT NOT NULL,
  sku         VARCHAR(40) NOT NULL,
  qty         INT NOT NULL,
  unit_price  DECIMAL(12, 2) NOT NULL,
  PRIMARY KEY (order_id, line_no)
) ENGINE = InnoDB;

INSERT INTO order_lines (order_id, line_no, sku, qty, unit_price)
WITH RECURSIVE seq (n) AS (
  SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 3000
)
SELECT
  (n DIV 3) + 1, (n % 3) + 1,
  CONCAT('SKU-', LPAD(n % 500, 5, '0')),
  (n % 9) + 1,
  ROUND(((n % 400) + 1) * 1.99, 2)
FROM seq;

-- No primary key at all — pagination must still be stable.
CREATE TABLE events (
  occurred_at DATETIME NOT NULL,
  kind        VARCHAR(40) NOT NULL,
  payload     JSON NULL
) ENGINE = InnoDB;

INSERT INTO events (occurred_at, kind, payload)
WITH RECURSIVE seq (n) AS (
  SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 800
)
SELECT
  DATE_ADD('2026-03-01 00:00:00', INTERVAL n MINUTE),
  ELT((n % 4) + 1, 'login', 'logout', 'purchase', 'refund'),
  JSON_OBJECT('n', n, 'even', n % 2 = 0)
FROM seq;

-- Identifiers that must be quoted: a space, and a reserved word as a column.
CREATE TABLE `weird table` (
  `id`     INT PRIMARY KEY,
  `select` VARCHAR(50) NOT NULL,
  `order`  INT NOT NULL
) ENGINE = InnoDB;

INSERT INTO `weird table` (`id`, `select`, `order`) VALUES
  (1, 'quoting works', 10),
  (2, 'reserved words too', 20);

CREATE VIEW active_customers AS
  SELECT id, name, email, balance FROM customers WHERE is_active = 1;

DELIMITER //

CREATE FUNCTION customer_balance(p_id INT) RETURNS DECIMAL(18, 4) READS SQL DATA
BEGIN
  DECLARE v DECIMAL(18, 4);
  SELECT balance INTO v FROM customers WHERE id = p_id;
  RETURN v;
END //

CREATE PROCEDURE top_customers(IN p_limit INT)
BEGIN
  SELECT id, name, balance FROM customers ORDER BY balance DESC LIMIT p_limit;
END //

DELIMITER ;

-- InnoDB's row estimate is derived from sampled index statistics, and
-- immediately after a bulk load it can be off by two orders of magnitude
-- (a freshly loaded 1200-row table reports ~9). ja-db shows these as
-- estimates, but a fixture that looks broken is a bad fixture.
ANALYZE TABLE customers, order_lines, events, `weird table`;

-- A second database, so switching databases in the UI has somewhere to go.
USE warehouse;

CREATE TABLE stock (
  sku      VARCHAR(40) PRIMARY KEY,
  on_hand  INT NOT NULL,
  location VARCHAR(20) NOT NULL
) ENGINE = InnoDB;

INSERT INTO stock (sku, on_hand, location)
WITH RECURSIVE seq (n) AS (
  SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 500
)
SELECT CONCAT('SKU-', LPAD(n, 5, '0')), (n * 7) % 250, CONCAT('BAY-', (n % 12) + 1)
FROM seq;

ANALYZE TABLE stock;
