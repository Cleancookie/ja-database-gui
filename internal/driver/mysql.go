package driver

import (
	"context"
	"database/sql"
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"
)

func init() { register(mysqlDriver{}) }

// mysqlDriver serves both MySQL and MariaDB. The information_schema queries
// used here are common to both.
type mysqlDriver struct{ qmarkWriter }

func (mysqlDriver) Kind() Kind { return KindMySQL }

func (mysqlDriver) Caps() Capabilities {
	return Capabilities{
		DisplayName:          "MySQL / MariaDB",
		ServerHostsDatabases: true,
		// MySQL uses "schema" and "database" interchangeably — there is no
		// nesting, so the tree has no schema level.
		HasSchemas:            false,
		DatabasePerConnection: false,
		SupportsFunctions:     true,
		SetToDefault:          true,
		DefaultPort:           3306,
		SSLModes:              []string{"false", "preferred", "skip-verify", "true"},
		CommonTypes: []string{
			"bigint AUTO_INCREMENT", "int", "bigint", "tinyint(1)",
			"varchar(255)", "text", "longtext", "json",
			"decimal(10,2)", "double", "date", "datetime", "timestamp",
			"char(36)", "blob",
		},
	}
}

func (mysqlDriver) SessionIDQuery() string { return "SELECT CONNECTION_ID()" }

// KILL QUERY stops the statement and leaves the connection open; a plain KILL
// would drop it. Neither can be parameterised, so the id is formatted as an int.
func (mysqlDriver) KillStatement(id int64) string { return fmt.Sprintf("KILL QUERY %d", id) }

func (mysqlDriver) SQLDriverName() string { return "mysql" }

func (mysqlDriver) DSN(cfg ConnConfig, database string) (string, error) {
	if database == "" {
		database = cfg.Database
	}
	host := cfg.Host
	if host == "" {
		host = "127.0.0.1"
	}
	port := cfg.Port
	if port == 0 {
		port = 3306
	}

	if err := checkSSLMode(mysqlDriver{}, cfg.SSLMode); err != nil {
		return "", err
	}
	if err := checkParams(cfg.Params, "tls"); err != nil {
		return "", err
	}

	// FormatDSN escapes the database name and every parameter, so a name such as
	// "a?multiStatements=true" stays a name. The password is written raw, which
	// is what the driver's parser expects: it splits on the last '@' before the
	// address, and escaping would corrupt a password containing '%'.
	c := mysql.NewConfig()
	c.User = cfg.User
	c.Passwd = cfg.Password
	c.Net = "tcp"
	c.Addr = net.JoinHostPort(host, strconv.Itoa(port))
	c.DBName = database
	// parseTime makes DATE/DATETIME arrive as time.Time rather than []byte,
	// so scan.go can format them consistently across dialects.
	c.ParseTime = true
	c.Loc = time.UTC
	c.TLSConfig = mysqlDriver{}.TLS(cfg).Mode
	c.Params = cfg.Params
	return c.FormatDSN(), nil
}

// TLS: with no mode chosen, a remote host is verified ("true") and a loopback
// one uses "preferred" — TLS when the server offers it, unverified, and never
// worse than the plaintext it replaces.
func (mysqlDriver) TLS(cfg ConnConfig) TLSInfo {
	info := TLSInfo{Mode: cfg.SSLMode}
	if info.Mode == "" {
		info.Implicit = true
		info.Mode = "true"
		if IsLoopbackHost(cfg.Host) {
			info.Mode = "preferred"
		}
	}
	switch info.Mode {
	case "false":
		info.Level = TLSPlain
	case "preferred":
		info.Level = TLSPartial
	case "skip-verify":
		info.Level = TLSEncrypted
	default:
		info.Level = TLSVerified
	}
	return finishTLS(info, cfg.Host)
}

func (mysqlDriver) QuoteIdent(ident string) string { return quoteWith("`", "`", ident) }

// capText uses LEFT, which counts characters rather than bytes and coerces a
// JSON column to text on the way — the two things the cap needs.
func (mysqlDriver) capText(expr string, n int) string {
	return fmt.Sprintf("LEFT(%s, %d)", expr, n)
}

func (d mysqlDriver) ListDatabases(ctx context.Context, db *sql.DB) ([]Database, error) {
	rows, err := db.QueryContext(ctx,
		`SELECT schema_name FROM information_schema.schemata ORDER BY schema_name`)
	if err != nil {
		return nil, err
	}
	recs, err := scanStrings(rows, 1)
	if err != nil {
		return nil, err
	}
	out := make([]Database, 0, len(recs))
	for _, r := range recs {
		out = append(out, Database{Name: r[0]})
	}
	return out, nil
}

func (d mysqlDriver) ListObjects(ctx context.Context, db *sql.DB, database string) ([]SchemaObject, error) {
	var out []SchemaObject

	// table_rows is the storage engine's estimate — exact for MyISAM, a rough
	// guess for InnoDB. Surfaced as an estimate, never as a count.
	tables, err := d.listTables(ctx, db, database)
	if err != nil {
		return nil, err
	}
	out = append(out, tables...)

	rrows, err := db.QueryContext(ctx, `
		SELECT routine_name, routine_type
		FROM information_schema.routines
		WHERE routine_schema = ?
		ORDER BY routine_type, routine_name`, database)
	if err != nil {
		return nil, err
	}
	recs, err := scanStrings(rrows, 2)
	if err != nil {
		return nil, err
	}
	for _, r := range recs {
		t := ObjectFunction
		if strings.EqualFold(r[1], "PROCEDURE") {
			t = ObjectProcedure
		}
		out = append(out, SchemaObject{Name: r[0], Type: t})
	}
	return out, nil
}

// listTables reads tables and views, carrying the storage engine's row
// estimate where one is available. table_rows is exact for MyISAM and only a
// guess for InnoDB, so it is surfaced as an estimate and never as a count.
func (d mysqlDriver) listTables(ctx context.Context, db *sql.DB, database string) ([]SchemaObject, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT table_name, table_type, IFNULL(table_rows, -1)
		FROM information_schema.tables
		WHERE table_schema = ?
		ORDER BY table_type, table_name`, database)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []SchemaObject
	for rows.Next() {
		var name, typ string
		var est int64
		if err := rows.Scan(&name, &typ, &est); err != nil {
			return nil, err
		}
		o := SchemaObject{Name: name, Type: ObjectTable}
		if strings.EqualFold(typ, "VIEW") {
			o.Type = ObjectView
		} else if est >= 0 {
			e := est
			o.RowEstimate = &e
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

func (d mysqlDriver) ListColumns(ctx context.Context, db *sql.DB, ref ObjectRef) ([]Column, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT column_name, column_type, is_nullable, column_default,
		       ordinal_position, column_key
		FROM information_schema.columns
		WHERE table_schema = ? AND table_name = ?
		ORDER BY ordinal_position`, ref.Database, ref.Name)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Column
	for rows.Next() {
		var (
			name, typ, nullable, key string
			def                      sql.NullString
			ord                      int
		)
		if err := rows.Scan(&name, &typ, &nullable, &def, &ord, &key); err != nil {
			return nil, err
		}
		c := Column{
			Name:       name,
			DataType:   typ,
			Nullable:   strings.EqualFold(nullable, "YES"),
			PrimaryKey: key == "PRI",
			Ordinal:    ord,
		}
		if def.Valid {
			v := def.String
			c.Default = &v
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// target qualifies with the database, since MySQL can read across databases
// on a single connection and the UI's "current database" is only a default.
func (d mysqlDriver) target(ref ObjectRef) string {
	return qualify(d, ref.Database, ref.Name)
}

func (d mysqlDriver) BuildSelect(ref ObjectRef, opts ReadOptions, cols []Column) (string, error) {
	return buildStandardSelect(d, ref, opts, d.target(ref), cols), nil
}

func (d mysqlDriver) BuildCount(ref ObjectRef, filter string) string {
	return "SELECT count(*) FROM " + d.target(ref) + whereClause(filter)
}

func (d mysqlDriver) BuildTruncate(ref ObjectRef) (string, error) {
	return "TRUNCATE TABLE " + d.target(ref), nil
}

func (d mysqlDriver) BuildDrop(ref ObjectRef, typ ObjectType) (string, error) {
	return buildDrop(d.target(ref), typ)
}

func (d mysqlDriver) BuildChange(ref ObjectRef, ch Change) (Stmt, error) {
	return buildChange(d, d.target(ref), ch)
}

// quoteString doubles backslashes as well as quotes: MySQL treats a backslash in
// a string as an escape unless NO_BACKSLASH_ESCAPES is set.
func (mysqlDriver) quoteString(s string) string {
	return "'" + strings.NewReplacer(`\`, `\\`, "'", "''").Replace(s) + "'"
}

func (mysqlDriver) emptyInsert() string { return " () VALUES ()" }

func (d mysqlDriver) BuildCreateTable(spec CreateTableSpec) (string, error) {
	return buildCreateTable(d, d.target(spec.Ref), spec)
}

// DescribeObject answers every field: MySQL's information_schema carries row
// and size statistics, comments at both table and column level, and — from
// 8.0.16 and MariaDB 10.2 — check constraints. The one version-dependent part
// is that last table, whose absence is reported as unavailable rather than as
// an error.
func (d mysqlDriver) DescribeObject(ctx context.Context, db *sql.DB, ref ObjectRef) (*ObjectDetail, error) {
	det := &ObjectDetail{Ref: ref, Type: ObjectTable}

	var err error
	if det.Columns, err = d.describeColumns(ctx, db, ref); err != nil {
		return nil, err
	}
	if det.Indexes, err = d.describeIndexes(ctx, db, ref); err != nil {
		return nil, err
	}
	if det.ForeignKeys, err = d.describeForeignKeys(ctx, db, ref); err != nil {
		return nil, err
	}
	if det.Triggers, err = d.describeTriggers(ctx, db, ref); err != nil {
		return nil, err
	}
	det.PrimaryKey = primaryKeyOf(det.Indexes, det.Columns)

	if err := d.describeTable(ctx, db, ref, det); err != nil {
		return nil, err
	}
	d.describeChecks(ctx, db, ref, det)
	return det, nil
}

// describeTable fills the table-level facts and the dialect-specific block.
func (d mysqlDriver) describeTable(ctx context.Context, db *sql.DB, ref ObjectRef, det *ObjectDetail) error {
	var (
		rowsEst, dataLen, idxLen sql.NullInt64
		comment, engine, coll    sql.NullString
		tableType                string
	)
	err := db.QueryRowContext(ctx, `
		SELECT table_rows, data_length, index_length, table_comment,
		       engine, table_collation, table_type
		FROM information_schema.tables
		WHERE table_schema = ? AND table_name = ?`,
		ref.Database, ref.Name,
	).Scan(&rowsEst, &dataLen, &idxLen, &comment, &engine, &coll, &tableType)
	if err == sql.ErrNoRows {
		return nil
	}
	if err != nil {
		return err
	}

	if tableType == "VIEW" {
		det.Type = ObjectView
		// A view has no storage, so the statistics below are meaningless for
		// one rather than merely unknown.
		det.markUnavailable("rowEstimate", "a view has no stored rows to estimate")
		det.markUnavailable("sizeBytes", "a view has no storage of its own")
		var def sql.NullString
		if err := db.QueryRowContext(ctx,
			`SELECT view_definition FROM information_schema.views
			 WHERE table_schema = ? AND table_name = ?`,
			ref.Database, ref.Name).Scan(&def); err == nil && def.Valid {
			v := def.String
			det.Definition = &v
		}
	} else {
		if rowsEst.Valid {
			det.RowEstimate = &rowsEst.Int64
		} else {
			det.markUnavailable("rowEstimate", "no statistics recorded for this table")
		}
		if dataLen.Valid || idxLen.Valid {
			total := dataLen.Int64 + idxLen.Int64
			det.SizeBytes = &total
		} else {
			det.markUnavailable("sizeBytes", "no size reported for this storage engine")
		}
	}

	// An empty table_comment is the norm, and is distinct from an engine that
	// cannot store one — so it stays a present-but-empty value, not a gap.
	if comment.Valid {
		v := comment.String
		det.Comment = &v
	}
	if engine.Valid && engine.String != "" {
		det.DialectDetail = append(det.DialectDetail, KeyValue{Key: "Engine", Value: engine.String})
	}
	if coll.Valid && coll.String != "" {
		det.DialectDetail = append(det.DialectDetail, KeyValue{Key: "Collation", Value: coll.String})
	}
	return nil
}

// describeChecks is best-effort: information_schema.check_constraints does not
// exist before MySQL 8.0.16 or MariaDB 10.2, and a missing table there is a
// version fact rather than a failure.
func (d mysqlDriver) describeChecks(ctx context.Context, db *sql.DB, ref ObjectRef, det *ObjectDetail) {
	rows, err := db.QueryContext(ctx, `
		SELECT cc.constraint_name, cc.check_clause
		FROM information_schema.check_constraints cc
		JOIN information_schema.table_constraints tc
		  ON tc.constraint_schema = cc.constraint_schema
		 AND tc.constraint_name = cc.constraint_name
		WHERE tc.table_schema = ? AND tc.table_name = ?
		ORDER BY cc.constraint_name`, ref.Database, ref.Name)
	if err != nil {
		det.markUnavailable("checks", "requires MySQL 8.0.16 or MariaDB 10.2 or newer")
		return
	}
	defer rows.Close()

	for rows.Next() {
		var name, clause string
		if err := rows.Scan(&name, &clause); err != nil {
			det.markUnavailable("checks", "could not be read")
			return
		}
		det.Checks = append(det.Checks, CheckConstraint{Name: name, Expression: clause})
	}
	if rows.Err() != nil {
		det.markUnavailable("checks", "could not be read")
	}
}

func (d mysqlDriver) EditFacts(ctx context.Context, db *sql.DB, ref ObjectRef) (EditFacts, error) {
	f, _, err := gatherEditFacts(
		func() ([]Column, error) { return d.describeColumns(ctx, db, ref) },
		func() ([]Index, error) { return d.describeIndexes(ctx, db, ref) },
		func() (bool, error) {
			var tableType string
			err := db.QueryRowContext(ctx, `
				SELECT table_type FROM information_schema.tables
				WHERE table_schema = ? AND table_name = ?`, ref.Database, ref.Name).Scan(&tableType)
			if err == sql.ErrNoRows {
				return false, nil
			}
			return strings.EqualFold(tableType, "VIEW"), err
		})
	return f, err
}

func (d mysqlDriver) describeColumns(ctx context.Context, db *sql.DB, ref ObjectRef) ([]Column, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT column_name, column_type, is_nullable, column_default,
		       ordinal_position, column_key, extra, column_comment, collation_name
		FROM information_schema.columns
		WHERE table_schema = ? AND table_name = ?
		ORDER BY ordinal_position`, ref.Database, ref.Name)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Column
	for rows.Next() {
		var (
			name, typ, nullable, key string
			def, comment, coll       sql.NullString
			extra                    string
			ord                      int
		)
		if err := rows.Scan(&name, &typ, &nullable, &def, &ord, &key, &extra, &comment, &coll); err != nil {
			return nil, err
		}
		c := Column{
			Name:       name,
			DataType:   typ,
			Nullable:   strings.EqualFold(nullable, "YES"),
			PrimaryKey: key == "PRI",
			Ordinal:    ord,
			// extra carries several space-separated words; auto_increment and
			// the GENERATED markers are matched rather than compared.
			AutoIncrement: strings.Contains(strings.ToLower(extra), "auto_increment"),
			Generated:     strings.Contains(strings.ToUpper(extra), "GENERATED"),
		}
		if def.Valid {
			v := def.String
			c.Default = &v
		}
		if comment.Valid && comment.String != "" {
			v := comment.String
			c.Comment = &v
		}
		if coll.Valid {
			v := coll.String
			c.Collation = &v
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (d mysqlDriver) describeIndexes(ctx context.Context, db *sql.DB, ref ObjectRef) ([]Index, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT index_name, non_unique, column_name, index_type, seq_in_index
		FROM information_schema.statistics
		WHERE table_schema = ? AND table_name = ?
		ORDER BY index_name, seq_in_index`, ref.Database, ref.Name)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	acc := newIndexAccum()
	for rows.Next() {
		var (
			idxName, idxType string
			colName          sql.NullString
			nonUnique, seq   int
		)
		if err := rows.Scan(&idxName, &nonUnique, &colName, &idxType, &seq); err != nil {
			return nil, err
		}
		acc.add(idxName, colName.String, nonUnique == 0, idxName == "PRIMARY", idxType)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return acc.result(), nil
}

func (d mysqlDriver) describeForeignKeys(ctx context.Context, db *sql.DB, ref ObjectRef) ([]ForeignKey, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT k.constraint_name, k.column_name,
		       k.referenced_table_schema, k.referenced_table_name, k.referenced_column_name,
		       r.update_rule, r.delete_rule
		FROM information_schema.key_column_usage k
		JOIN information_schema.referential_constraints r
		  ON r.constraint_schema = k.constraint_schema
		 AND r.constraint_name = k.constraint_name
		WHERE k.table_schema = ? AND k.table_name = ?
		  AND k.referenced_table_name IS NOT NULL
		ORDER BY k.constraint_name, k.ordinal_position`, ref.Database, ref.Name)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	acc := newFKAccum()
	for rows.Next() {
		var (
			name, col, refTable, refCol string
			refSchema                   sql.NullString
			onUpdate, onDelete          string
		)
		if err := rows.Scan(&name, &col, &refSchema, &refTable, &refCol, &onUpdate, &onDelete); err != nil {
			return nil, err
		}
		// MySQL has no schema level, so a referenced schema equal to the
		// current database adds nothing and is dropped.
		rs := refSchema.String
		if rs == ref.Database {
			rs = ""
		}
		acc.add(name, col, rs, refTable, refCol, onUpdate, onDelete)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return acc.result(), nil
}

func (d mysqlDriver) describeTriggers(ctx context.Context, db *sql.DB, ref ObjectRef) ([]Trigger, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT trigger_name, action_timing, event_manipulation
		FROM information_schema.triggers
		WHERE event_object_schema = ? AND event_object_table = ?
		ORDER BY trigger_name`, ref.Database, ref.Name)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Trigger
	for rows.Next() {
		var name, timing, event string
		if err := rows.Scan(&name, &timing, &event); err != nil {
			return nil, err
		}
		out = append(out, Trigger{Name: name, Timing: timing, Event: event})
	}
	return out, rows.Err()
}
