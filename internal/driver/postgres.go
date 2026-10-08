package driver

import (
	"context"
	"database/sql"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"

	_ "github.com/jackc/pgx/v5/stdlib"
)

func init() { register(postgresDriver{}) }

type postgresDriver struct{ stdWriter }

func (postgresDriver) Kind() Kind { return KindPostgres }

func (postgresDriver) Caps() Capabilities {
	return Capabilities{
		IsolationLevels:      []string{"read uncommitted", "read committed", "repeatable read", "serializable"},
		DisplayName:          "PostgreSQL",
		ServerHostsDatabases: true,
		HasSchemas:           true,
		// Postgres cannot switch database on an open connection, so the
		// engine dials again per database. This is the reason its session
		// pool is keyed on (connection, database).
		DatabasePerConnection: true,
		SupportsFunctions:     true,
		SetToDefault:          true,
		DefaultPort:           5432,
		SSLModes:              []string{"disable", "allow", "prefer", "require", "verify-ca", "verify-full"},
		CommonTypes: []string{
			"bigserial", "serial", "integer", "bigint", "boolean",
			"text", "varchar(255)", "jsonb", "uuid",
			"numeric(10,2)", "double precision",
			"date", "timestamptz", "timestamp", "interval", "bytea",
		},
	}
}

func (postgresDriver) SessionIDQuery() string { return "SELECT pg_backend_pid()" }

// pg_cancel_backend cancels the running statement, as a cancel request does,
// and leaves the session alone. A role may always cancel its own sessions.
func (postgresDriver) KillStatement(id int64) string {
	return fmt.Sprintf("SELECT pg_cancel_backend(%d)", id)
}

func (postgresDriver) SQLDriverName() string { return "pgx" }

func (postgresDriver) DSN(cfg ConnConfig, database string) (string, error) {
	if database == "" {
		database = cfg.Database
	}
	if database == "" {
		// Postgres requires a database to connect to at all; this is the
		// conventional bootstrap target for "show me what's on this server".
		database = "postgres"
	}
	host := cfg.Host
	if host == "" {
		host = "127.0.0.1"
	}
	port := cfg.Port
	if port == 0 {
		port = 5432
	}
	if err := checkSSLMode(postgresDriver{}, cfg.SSLMode); err != nil {
		return "", err
	}
	if err := checkParams(cfg.Params, "sslmode"); err != nil {
		return "", err
	}

	q := url.Values{}
	q.Set("sslmode", postgresDriver{}.TLS(cfg).Mode)
	for k, v := range cfg.Params {
		q.Set(k, v)
	}

	u := &url.URL{
		Scheme:   "postgres",
		User:     url.UserPassword(cfg.User, cfg.Password),
		Host:     net.JoinHostPort(host, strconv.Itoa(port)),
		Path:     "/" + database,
		RawQuery: q.Encode(),
	}
	return u.String(), nil
}

// TLS: with no mode chosen, a remote host is verified and a loopback one keeps
// pgx's old "prefer", because a local dev server rarely has TLS at all.
func (postgresDriver) TLS(cfg ConnConfig) TLSInfo {
	info := TLSInfo{Mode: cfg.SSLMode}
	if info.Mode == "" {
		info.Implicit = true
		info.Mode = "verify-full"
		if IsLoopbackHost(cfg.Host) {
			info.Mode = "prefer"
		}
	}
	switch info.Mode {
	case "disable":
		info.Level = TLSPlain
	case "allow", "prefer":
		info.Level = TLSPartial
	case "require":
		info.Level = TLSEncrypted
	default:
		info.Level = TLSVerified
	}
	return finishTLS(info, cfg.Host)
}

func (postgresDriver) QuoteIdent(ident string) string { return quoteWith(`"`, `"`, ident) }

// capText casts before cutting: left() takes text, and json/jsonb/xml are not
// text as far as postgres is concerned. The cast is free on a column that
// already is text.
func (postgresDriver) capText(expr string, n int) string {
	return fmt.Sprintf("left(%s::text, %d)", expr, n)
}

func (d postgresDriver) ListDatabases(ctx context.Context, db *sql.DB) ([]Database, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT datname FROM pg_database
		WHERE datistemplate = false AND has_database_privilege(datname, 'CONNECT')
		ORDER BY datname`)
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

// ListObjects ignores the database argument: the connection is already bound
// to one database, and the engine guarantees it is the right one.
func (d postgresDriver) ListObjects(ctx context.Context, db *sql.DB, _ string) ([]SchemaObject, error) {
	var out []SchemaObject

	// reltuples is the planner's estimate, refreshed by ANALYZE. It is -1 on
	// a table that has never been analysed, which is filtered out below.
	rows, err := db.QueryContext(ctx, `
		SELECT n.nspname, c.relname,
		       CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'view' ELSE 'table' END,
		       c.reltuples::bigint
		FROM pg_class c
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE c.relkind IN ('r','p','v','m','f')
		  AND n.nspname NOT IN ('pg_catalog','information_schema')
		  AND n.nspname NOT LIKE 'pg_toast%'
		  AND n.nspname NOT LIKE 'pg_temp%'
		ORDER BY n.nspname, c.relname`)
	if err != nil {
		return nil, err
	}
	if err := func() error {
		defer rows.Close()
		for rows.Next() {
			var schema, name, kind string
			var est int64
			if err := rows.Scan(&schema, &name, &kind, &est); err != nil {
				return err
			}
			o := SchemaObject{Schema: schema, Name: name, Type: ObjectTable}
			if kind == "view" {
				o.Type = ObjectView
			} else if est >= 0 {
				e := est
				o.RowEstimate = &e
			}
			out = append(out, o)
		}
		return rows.Err()
	}(); err != nil {
		return nil, err
	}

	// prokind was added in PG11 (2018); on older servers this query errors and
	// the routine list is simply omitted rather than failing the whole tree.
	rrows, err := db.QueryContext(ctx, `
		SELECT n.nspname, p.proname,
		       CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END
		FROM pg_proc p
		JOIN pg_namespace n ON n.oid = p.pronamespace
		WHERE n.nspname NOT IN ('pg_catalog','information_schema')
		ORDER BY n.nspname, p.proname`)
	if err != nil {
		return out, nil
	}
	recs, err := scanStrings(rrows, 3)
	if err != nil {
		return out, nil
	}
	for _, r := range recs {
		t := ObjectFunction
		if r[2] == "procedure" {
			t = ObjectProcedure
		}
		out = append(out, SchemaObject{Schema: r[0], Name: r[1], Type: t})
	}
	return out, nil
}

func (d postgresDriver) ListColumns(ctx context.Context, db *sql.DB, ref ObjectRef) ([]Column, error) {
	// Reading pg_attribute directly rather than information_schema gives the
	// fully-qualified type via format_type (numeric(10,2), varchar(50)) rather
	// than the bare "numeric" that information_schema.data_type reports.
	rows, err := db.QueryContext(ctx, `
		SELECT a.attname,
		       format_type(a.atttypid, a.atttypmod),
		       NOT a.attnotnull,
		       pg_get_expr(ad.adbin, ad.adrelid),
		       a.attnum,
		       COALESCE(i.indisprimary, false)
		FROM pg_attribute a
		LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
		LEFT JOIN pg_index i ON i.indrelid = a.attrelid AND i.indisprimary
		                     AND a.attnum = ANY(i.indkey)
		WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
		ORDER BY a.attnum`, d.target(ref))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Column
	for rows.Next() {
		var (
			name, typ string
			nullable  bool
			def       sql.NullString
			ord       int
			pk        bool
		)
		if err := rows.Scan(&name, &typ, &nullable, &def, &ord, &pk); err != nil {
			return nil, err
		}
		c := Column{Name: name, DataType: typ, Nullable: nullable, PrimaryKey: pk, Ordinal: ord}
		if def.Valid {
			v := def.String
			c.Default = &v
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// target omits the database: the connection is already bound to it, and a
// cross-database reference is not possible in postgres anyway.
func (d postgresDriver) target(ref ObjectRef) string {
	if ref.Schema == "" {
		return qualify(d, "public", ref.Name)
	}
	return qualify(d, ref.Schema, ref.Name)
}

func (d postgresDriver) BuildSelect(ref ObjectRef, opts ReadOptions, cols []Column) (string, error) {
	if ref.Name == "" {
		return "", fmt.Errorf("postgres: no table specified")
	}
	return buildStandardSelect(d, ref, opts, d.target(ref), cols), nil
}

func (d postgresDriver) BuildCount(ref ObjectRef, filter string) string {
	return "SELECT count(*) FROM " + d.target(ref) + whereClause(filter)
}

// BuildTruncate deliberately omits CASCADE. Postgres refuses to truncate a table
// another table references, and the right answer to that is to read the error and
// decide — not to have the menu quietly empty tables the user never named.
func (d postgresDriver) BuildTruncate(ref ObjectRef) (string, error) {
	return "TRUNCATE TABLE " + d.target(ref), nil
}

// BuildDrop is RESTRICT by default, for the same reason: a view built on the
// table blocks the drop, which is information rather than an obstacle.
func (d postgresDriver) BuildDrop(ref ObjectRef, typ ObjectType) (string, error) {
	return buildDrop(d.target(ref), typ)
}

func (d postgresDriver) BuildChange(ref ObjectRef, ch Change) (Stmt, error) {
	return buildChange(d, d.target(ref), ch)
}

func (postgresDriver) placeholder(n int) string { return "$" + strconv.Itoa(n) }

func (postgresDriver) boolLiteral(b bool) string {
	if b {
		return "TRUE"
	}
	return "FALSE"
}

func (d postgresDriver) BuildCreateTable(spec CreateTableSpec) (string, error) {
	return buildCreateTable(d, d.target(spec.Ref), spec)
}

// DescribeObject reads pg_catalog rather than information_schema throughout,
// for the same reason ListColumns does: the catalog gives fully-qualified types
// and exposes identity, generated and comment facts that information_schema
// either flattens or omits.
//
// Every relation is addressed by its oid via the ::regclass cast of the
// schema-qualified name, so a table and a view are described by the same code.
func (d postgresDriver) DescribeObject(ctx context.Context, db *sql.DB, ref ObjectRef) (*ObjectDetail, error) {
	det := &ObjectDetail{Ref: ref, Type: ObjectTable}
	target := d.target(ref)

	var err error
	if det.Columns, err = d.describeColumns(ctx, db, target); err != nil {
		return nil, err
	}
	if det.Indexes, err = d.describeIndexes(ctx, db, target); err != nil {
		return nil, err
	}
	if det.ForeignKeys, err = d.describeForeignKeys(ctx, db, target); err != nil {
		return nil, err
	}
	if det.Triggers, err = d.describeTriggers(ctx, db, target); err != nil {
		return nil, err
	}
	if det.Checks, err = d.describeChecks(ctx, db, target); err != nil {
		return nil, err
	}
	det.PrimaryKey = primaryKeyOf(det.Indexes, det.Columns)

	if err := d.describeRelation(ctx, db, target, det); err != nil {
		return nil, err
	}
	return det, nil
}

func (d postgresDriver) describeRelation(ctx context.Context, db *sql.DB, target string, det *ObjectDetail) error {
	var (
		reltuples   float64
		size        sql.NullInt64
		comment     sql.NullString
		relkind     string
		am, ts, own sql.NullString
	)
	err := db.QueryRowContext(ctx, `
		SELECT c.reltuples,
		       pg_total_relation_size(c.oid),
		       obj_description(c.oid, 'pg_class'),
		       c.relkind,
		       am.amname,
		       ts.spcname,
		       pg_get_userbyid(c.relowner)
		FROM pg_class c
		LEFT JOIN pg_am am ON am.oid = c.relam
		LEFT JOIN pg_tablespace ts ON ts.oid = c.reltablespace
		WHERE c.oid = $1::regclass`, target,
	).Scan(&reltuples, &size, &comment, &relkind, &am, &ts, &own)
	if err == sql.ErrNoRows {
		return nil
	}
	if err != nil {
		return err
	}

	isView := relkind == "v" || relkind == "m"
	if isView {
		det.Type = ObjectView
		var def sql.NullString
		if err := db.QueryRowContext(ctx,
			`SELECT pg_get_viewdef($1::regclass, true)`, target).Scan(&def); err == nil && def.Valid {
			v := def.String
			det.Definition = &v
		}
	}

	// reltuples is -1 on a relation that has never been analysed (and 0 on
	// older servers, which is indistinguishable from a genuinely empty table —
	// so only the explicit -1 is reported as missing).
	switch {
	case relkind == "v":
		det.markUnavailable("rowEstimate", "a view has no stored rows to estimate")
	case reltuples < 0:
		det.markUnavailable("rowEstimate", "this table has not been analysed yet — run ANALYZE")
	default:
		n := int64(reltuples)
		det.RowEstimate = &n
	}

	if relkind == "v" {
		det.markUnavailable("sizeBytes", "a view has no storage of its own")
	} else if size.Valid {
		det.SizeBytes = &size.Int64
	} else {
		det.markUnavailable("sizeBytes", "no size reported for this relation")
	}

	if comment.Valid {
		v := comment.String
		det.Comment = &v
	}
	if own.Valid && own.String != "" {
		det.DialectDetail = append(det.DialectDetail, KeyValue{Key: "Owner", Value: own.String})
	}
	if am.Valid && am.String != "" {
		det.DialectDetail = append(det.DialectDetail, KeyValue{Key: "Access method", Value: am.String})
	}
	if ts.Valid && ts.String != "" {
		det.DialectDetail = append(det.DialectDetail, KeyValue{Key: "Tablespace", Value: ts.String})
	}
	return nil
}

func (d postgresDriver) EditFacts(ctx context.Context, db *sql.DB, ref ObjectRef) (EditFacts, error) {
	target := d.target(ref)
	f, _, err := gatherEditFacts(
		func() ([]Column, error) { return d.describeColumns(ctx, db, target) },
		func() ([]Index, error) { return d.describeIndexes(ctx, db, target) },
		func() (bool, error) {
			var relkind string
			err := db.QueryRowContext(ctx,
				`SELECT relkind FROM pg_class WHERE oid = $1::regclass`, target).Scan(&relkind)
			// v is a view, m a materialised view: neither takes INSERT or UPDATE.
			return relkind == "v" || relkind == "m", err
		})
	return f, err
}

func (d postgresDriver) describeColumns(ctx context.Context, db *sql.DB, target string) ([]Column, error) {
	// attidentity and attgenerated are single characters, empty when the column
	// is neither. A serial column is not an identity column but behaves like
	// one, so a nextval default counts as auto-increment too.
	rows, err := db.QueryContext(ctx, `
		SELECT a.attname,
		       format_type(a.atttypid, a.atttypmod),
		       NOT a.attnotnull,
		       pg_get_expr(ad.adbin, ad.adrelid),
		       a.attnum,
		       COALESCE(i.indisprimary, false),
		       a.attidentity <> '',
		       a.attgenerated <> '',
		       col_description(a.attrelid, a.attnum),
		       co.collname
		FROM pg_attribute a
		LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
		LEFT JOIN pg_index i ON i.indrelid = a.attrelid AND i.indisprimary
		                     AND a.attnum = ANY(i.indkey)
		LEFT JOIN pg_collation co ON co.oid = a.attcollation
		WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
		ORDER BY a.attnum`, target)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Column
	for rows.Next() {
		var (
			name, typ            string
			nullable             bool
			def, comment, coll   sql.NullString
			ord                  int
			pk, identity, genCol bool
		)
		if err := rows.Scan(&name, &typ, &nullable, &def, &ord, &pk,
			&identity, &genCol, &comment, &coll); err != nil {
			return nil, err
		}
		c := Column{
			Name: name, DataType: typ, Nullable: nullable,
			PrimaryKey: pk, Ordinal: ord, Generated: genCol,
			AutoIncrement: identity || (def.Valid && strings.HasPrefix(def.String, "nextval(")),
		}
		if def.Valid {
			v := def.String
			c.Default = &v
		}
		if comment.Valid {
			v := comment.String
			c.Comment = &v
		}
		// Every column has an implicit collation; "default" carries no
		// information and is dropped rather than shown on every row.
		if coll.Valid && coll.String != "" && coll.String != "default" {
			v := coll.String
			c.Collation = &v
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (d postgresDriver) describeIndexes(ctx context.Context, db *sql.DB, target string) ([]Index, error) {
	// indkey is an int2vector, cast to a real array so unnest WITH ORDINALITY
	// can pair each entry with its position. A zero entry is an expression
	// rather than a column, so the join to pg_attribute is left outer and that
	// position simply contributes no name.
	rows, err := db.QueryContext(ctx, `
		SELECT ic.relname, ix.indisunique, ix.indisprimary, am.amname, a.attname, k.ord,
		       ix.indpred IS NOT NULL
		FROM pg_index ix
		JOIN pg_class ic ON ic.oid = ix.indexrelid
		LEFT JOIN pg_am am ON am.oid = ic.relam
		JOIN LATERAL unnest(ix.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord) ON true
		LEFT JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = k.attnum
		WHERE ix.indrelid = $1::regclass
		ORDER BY ic.relname, k.ord`, target)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	acc := newIndexAccum()
	for rows.Next() {
		var (
			idxName         string
			uniq, primary   bool
			filtered        bool
			method, colName sql.NullString
			ord             int
		)
		if err := rows.Scan(&idxName, &uniq, &primary, &method, &colName, &ord, &filtered); err != nil {
			return nil, err
		}
		acc.add(idxName, colName.String, uniq, primary, method.String)
		if filtered {
			acc.markPartial(idxName)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return acc.result(), nil
}

func (d postgresDriver) describeForeignKeys(ctx context.Context, db *sql.DB, target string) ([]ForeignKey, error) {
	// conkey and confkey are equal-length arrays of local and referenced
	// attribute numbers; unnesting them together keeps the pairs aligned.
	rows, err := db.QueryContext(ctx, `
		SELECT con.conname, a.attname, ns.nspname, ref.relname, fa.attname,
		       con.confupdtype, con.confdeltype, k.ord
		FROM pg_constraint con
		JOIN pg_class ref ON ref.oid = con.confrelid
		JOIN pg_namespace ns ON ns.oid = ref.relnamespace
		JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(att, fatt, ord) ON true
		JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.att
		JOIN pg_attribute fa ON fa.attrelid = con.confrelid AND fa.attnum = k.fatt
		WHERE con.conrelid = $1::regclass AND con.contype = 'f'
		ORDER BY con.conname, k.ord`, target)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	acc := newFKAccum()
	for rows.Next() {
		var (
			name, col, schema, refTable, refCol string
			upd, del                            string
			ord                                 int
		)
		if err := rows.Scan(&name, &col, &schema, &refTable, &refCol, &upd, &del, &ord); err != nil {
			return nil, err
		}
		if schema == "public" {
			schema = ""
		}
		acc.add(name, col, schema, refTable, refCol,
			pgReferentialAction(upd), pgReferentialAction(del))
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return acc.result(), nil
}

func (d postgresDriver) describeTriggers(ctx context.Context, db *sql.DB, target string) ([]Trigger, error) {
	// tgtype is a bitmask: 1 row-level, 2 BEFORE, 4 INSERT, 8 DELETE,
	// 16 UPDATE, 64 INSTEAD OF. Constraint triggers backing foreign keys are
	// internal and excluded — they are already shown as foreign keys.
	rows, err := db.QueryContext(ctx, `
		SELECT tgname,
		       CASE WHEN (tgtype & 64) <> 0 THEN 'INSTEAD OF'
		            WHEN (tgtype & 2) <> 0 THEN 'BEFORE'
		            ELSE 'AFTER' END,
		       trim(concat_ws(' OR ',
		            CASE WHEN (tgtype & 4)  <> 0 THEN 'INSERT' END,
		            CASE WHEN (tgtype & 8)  <> 0 THEN 'DELETE' END,
		            CASE WHEN (tgtype & 16) <> 0 THEN 'UPDATE' END,
		            CASE WHEN (tgtype & 32) <> 0 THEN 'TRUNCATE' END))
		FROM pg_trigger
		WHERE tgrelid = $1::regclass AND NOT tgisinternal
		ORDER BY tgname`, target)
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

func (d postgresDriver) describeChecks(ctx context.Context, db *sql.DB, target string) ([]CheckConstraint, error) {
	// pg_get_constraintdef returns "CHECK ((x > 0))"; the UI shows it verbatim
	// rather than trying to strip the wrapper back off.
	rows, err := db.QueryContext(ctx, `
		SELECT conname, pg_get_constraintdef(oid)
		FROM pg_constraint
		WHERE conrelid = $1::regclass AND contype = 'c'
		ORDER BY conname`, target)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []CheckConstraint
	for rows.Next() {
		var name, def string
		if err := rows.Scan(&name, &def); err != nil {
			return nil, err
		}
		out = append(out, CheckConstraint{Name: name, Expression: def})
	}
	return out, rows.Err()
}

// jsonColumn works in jsonb: a json or text column is cast in and back out.
func (postgresDriver) jsonColumn(col, dataType string) (string, func(string) string) {
	switch strings.ToLower(dataType) {
	case "jsonb":
		return col, func(s string) string { return s }
	case "json":
		return col + "::jsonb", func(s string) string { return "(" + s + ")::json" }
	}
	return col + "::jsonb", func(s string) string { return "(" + s + ")::text" }
}

// jsonEdit uses jsonb's path functions, whose path is a text[] of keys and
// indexes: a step means a key or an index by what it meets, so no quoting.
// jsonb_set is STRICT, so a rename of a missing key moves a JSON null rather
// than nulling the whole column.
func (postgresDriver) jsonEdit(x func() string, e JSONEdit, val func(any) string) (string, error) {
	switch e.Op {
	case JSONSet:
		doc := x()
		path := pgPath(e.Path, val)
		return "jsonb_set(" + doc + ", " + path + ", " + val(e.Value) + "::jsonb, true)", nil
	case JSONRemove:
		doc := x()
		return "(" + doc + " #- " + pgPath(e.Path, val) + ")", nil
	case JSONAppend:
		doc := x()
		path := pgPath(append(append([]PathStep(nil), e.Path...), PathStep{Index: -1, IsIndex: true}), val)
		return "jsonb_insert(" + doc + ", " + path + ", " + val(e.Value) + "::jsonb, true)", nil
	case JSONRename:
		removed := "(" + x() + " #- " + pgPath(e.Path, val) + ")"
		to := pgPath(renamedPath(e), val)
		from := "COALESCE(" + x() + " #> " + pgPath(e.Path, val) + ", 'null')"
		return "jsonb_set(" + removed + ", " + to + ", " + from + ", true)", nil
	}
	return "", fmt.Errorf("unknown JSON edit %q", e.Op)
}

func pgPath(path []PathStep, val func(any) string) string {
	steps := make([]string, len(path))
	for i, s := range path {
		if s.IsIndex {
			steps[i] = val(strconv.Itoa(s.Index))
		} else {
			steps[i] = val(s.Key)
		}
	}
	return "ARRAY[" + strings.Join(steps, ", ") + "]::text[]"
}
