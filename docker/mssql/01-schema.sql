-- Fixture schema for ja-db, SQL Server.
--
-- Mirrors docker/mysql/01-schema.sql. SQL Server matters most here because it
-- is the dialect where pagination needs an invented ORDER BY, so the tables
-- below deliberately include a composite key and a table with no key at all.

IF DB_ID('shop') IS NULL CREATE DATABASE shop;
GO

USE shop;
GO

CREATE TABLE customers (
  id          int IDENTITY(1,1) PRIMARY KEY,
  name        nvarchar(120) NOT NULL,
  email       nvarchar(200) NULL,
  -- Past 2^53: must survive the trip to the webview as exact digits.
  big_id      bigint NOT NULL,
  balance     decimal(18, 4) NOT NULL,
  is_active   bit NOT NULL DEFAULT 1,
  -- Deliberately mixes NULL and '' so the grid must distinguish them.
  notes       nvarchar(max) NULL,
  payload     varbinary(max) NULL,
  created_at  datetime2 NOT NULL
);
GO

CREATE INDEX idx_customers_email ON customers (email);
GO

WITH seq AS (
  SELECT 1 AS n UNION ALL SELECT n + 1 FROM seq WHERE n < 1200
)
INSERT INTO customers (name, email, big_id, balance, is_active, notes, payload, created_at)
SELECT
  CONCAT('Customer ', n),
  CASE WHEN n % 7 = 0 THEN NULL ELSE CONCAT('user', n, '@example.com') END,
  1780241234567890000 + n,
  ROUND(n * 13.37, 4),
  n % 2,
  CASE WHEN n % 11 = 0 THEN '' WHEN n % 5 = 0 THEN NULL ELSE CONCAT('Note for ', n) END,
  CASE WHEN n % 13 = 0 THEN 0xDEADBEEFCAFE ELSE NULL END,
  DATEADD(hour, n, CAST('2026-01-01 09:00:00' AS datetime2))
FROM seq
OPTION (MAXRECURSION 0);
GO

-- Composite primary key: the sort ja-db must fall back to when paginating
-- without an explicit ORDER BY.
CREATE TABLE order_lines (
  order_id   int NOT NULL,
  line_no    int NOT NULL,
  sku        varchar(40) NOT NULL,
  qty        int NOT NULL,
  unit_price decimal(12, 2) NOT NULL,
  CONSTRAINT pk_order_lines PRIMARY KEY (order_id, line_no)
);
GO

WITH seq AS (
  SELECT 1 AS n UNION ALL SELECT n + 1 FROM seq WHERE n < 3000
)
INSERT INTO order_lines (order_id, line_no, sku, qty, unit_price)
SELECT (n / 3) + 1, (n % 3) + 1,
       CONCAT('SKU-', RIGHT('00000' + CAST(n % 500 AS varchar(5)), 5)),
       (n % 9) + 1,
       ROUND(((n % 400) + 1) * 1.99, 2)
FROM seq
OPTION (MAXRECURSION 0);
GO

-- No primary key at all — this is the case that forces ja-db to fall back to
-- the first column to keep OFFSET/FETCH paging stable.
CREATE TABLE events (
  occurred_at datetime2 NOT NULL,
  kind        varchar(40) NOT NULL,
  payload     nvarchar(max) NULL
);
GO

WITH seq AS (
  SELECT 1 AS n UNION ALL SELECT n + 1 FROM seq WHERE n < 800
)
INSERT INTO events (occurred_at, kind, payload)
SELECT DATEADD(minute, n, CAST('2026-03-01 00:00:00' AS datetime2)),
       CHOOSE((n % 4) + 1, 'login', 'logout', 'purchase', 'refund'),
       CONCAT('{"n":', n, ',"even":', CASE WHEN n % 2 = 0 THEN 'true' ELSE 'false' END, '}')
FROM seq
OPTION (MAXRECURSION 0);
GO

-- Identifiers that must be quoted: a space, and a reserved word as a column.
CREATE TABLE [weird table] (
  [id]     int PRIMARY KEY,
  [select] nvarchar(50) NOT NULL,
  [order]  int NOT NULL
);
GO

INSERT INTO [weird table] ([id], [select], [order]) VALUES
  (1, 'quoting works', 10),
  (2, 'reserved words too', 20);
GO

CREATE VIEW active_customers AS
  SELECT id, name, email, balance FROM customers WHERE is_active = 1;
GO

CREATE FUNCTION customer_balance(@id int) RETURNS decimal(18, 4)
AS
BEGIN
  DECLARE @v decimal(18, 4);
  SELECT @v = balance FROM customers WHERE id = @id;
  RETURN @v;
END;
GO

CREATE PROCEDURE top_customers @limit int
AS
BEGIN
  SELECT TOP (@limit) id, name, balance FROM customers ORDER BY balance DESC;
END;
GO

-- A non-dbo schema, so the tree has more than one schema to render.
CREATE SCHEMA reporting;
GO

CREATE TABLE reporting.daily_totals (
  day   date PRIMARY KEY,
  total decimal(18, 2) NOT NULL
);
GO

WITH seq AS (
  SELECT 0 AS n UNION ALL SELECT n + 1 FROM seq WHERE n < 364
)
INSERT INTO reporting.daily_totals (day, total)
SELECT DATEADD(day, n, CAST('2026-01-01' AS date)), ROUND(n * 91.5, 2)
FROM seq
OPTION (MAXRECURSION 0);
GO

-- A second database, so switching databases in the UI has somewhere to go.
IF DB_ID('warehouse') IS NULL CREATE DATABASE warehouse;
GO

USE warehouse;
GO

CREATE TABLE stock (
  sku      varchar(40) PRIMARY KEY,
  on_hand  int NOT NULL,
  location varchar(20) NOT NULL
);
GO

WITH seq AS (
  SELECT 1 AS n UNION ALL SELECT n + 1 FROM seq WHERE n < 500
)
INSERT INTO stock (sku, on_hand, location)
SELECT CONCAT('SKU-', RIGHT('00000' + CAST(n AS varchar(5)), 5)),
       (n * 7) % 250,
       CONCAT('BAY-', (n % 12) + 1)
FROM seq
OPTION (MAXRECURSION 0);
GO
