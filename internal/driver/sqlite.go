package driver

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"strings"

	_ "modernc.org/sqlite" // pure-Go SQLite; no cgo, so cross-compilation works
)

func init() { register(sqliteDriver{}) }

type sqliteDriver struct{}

func (sqliteDriver) Kind() Kind { return KindSQLite }

func (sqliteDriver) Caps() Capabilities {
	return Capabilities{
		DisplayName: "SQLite",
		// A SQLite connection *is* the database — there is no server hosting
		// a list of them, so the UI skips the database level entirely.
		ServerHostsDatabases: false,
		HasSchemas:           false,
		// SQLite has no queryable catalog of user functions.
		SupportsFunctions: false,
		// No TRUNCATE in SQLite; the object menu runs DELETE FROM instead.
		TruncateIsDelete: true,
		CommonTypes: []string{
			"INTEGER", "TEXT", "REAL", "BLOB", "NUMERIC",
			// The declared types below are conventions rather than storage
			// classes — SQLite keeps them verbatim and applies its own affinity
			// rules — but they are what the surrounding tooling expects to read.
			"BOOLEAN", "DATE", "DATETIME",
		},
	}
}

func (sqliteDriver) SQLDriverName() string { return "sqlite" }

func (sqliteDriver) DSN(cfg ConnConfig, _ string) (string, error) {
	if strings.TrimSpace(cfg.File) == "" {
		return "", fmt.Errorf("sqlite: no database file specified")
	}
	// A busy timeout stops routine "database is locked" errors when something
	// else holds a write lock; foreign_keys matches what most apps expect.
	q := url.Values{}
	q.Add("_pragma", "busy_timeout(5000)")
	q.Add("_pragma", "foreign_keys(1)")
	for k, v := range cfg.Params {
		q.Add(k, v)
	}
	return "file:" + cfg.File + "?" + q.Encode(), nil
}

func (sqliteDriver) QuoteIdent(ident string) string { return quoteWith(`"`, `"`, ident) }

// capText uses substr, which counts characters on a TEXT value. SQLite is
// dynamically typed, so a cap only ever reaches columns whose *declared* type
// is text-shaped — see isLongTextType.
func (sqliteDriver) capText(expr string, n int) string {
	return fmt.Sprintf("substr(%s, 1, %d)", expr, n)
}

func (d sqliteDriver) ListDatabases(_ context.Context, _ *sql.DB) ([]Database, error) {
	// "main" is the attached-database name every SQLite file has. Returned so
	// the rest of the app can treat all dialects uniformly.
	return []Database{{Name: "main"}}, nil
}

func (d sqliteDriver) ListObjects(ctx context.Context, db *sql.DB, _ string) ([]SchemaObject, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT name, type
		FROM sqlite_master
		WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'
		ORDER BY type, name`)
	if err != nil {
		return nil, err
	}
	recs, err := scanStrings(rows, 2)
	if err != nil {
		return nil, err
	}
	out := make([]SchemaObject, 0, len(recs))
	for _, r := range recs {
		t := ObjectTable
		if r[1] == "view" {
			t = ObjectView
		}
		out = append(out, SchemaObject{Name: r[0], Type: t})
	}
	return out, nil
}

func (d sqliteDriver) ListColumns(ctx context.Context, db *sql.DB, ref ObjectRef) ([]Column, error) {
	// pragma_table_info is the table-valued form of PRAGMA table_info, which
	// lets the table name be bound rather than interpolated.
	rows, err := db.QueryContext(ctx, `
		SELECT cid, name, type, "notnull", dflt_value, pk
		FROM pragma_table_info(?)
		ORDER BY cid`, ref.Name)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Column
	for rows.Next() {
		var (
			cid, notNull, pk int
			name, typ        string
			def              sql.NullString
		)
		if err := rows.Scan(&cid, &name, &typ, &notNull, &def, &pk); err != nil {
			return nil, err
		}
		c := Column{
			Name:       name,
			DataType:   typ,
			Nullable:   notNull == 0,
			PrimaryKey: pk > 0,
			Ordinal:    cid + 1,
		}
		if def.Valid {
			v := def.String
			c.Default = &v
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (d sqliteDriver) target(ref ObjectRef) string {
	return qualify(d, ref.Name)
}

func (d sqliteDriver) BuildSelect(ref ObjectRef, opts ReadOptions, cols []Column) (string, error) {
	return buildStandardSelect(d, ref, opts, d.target(ref), cols), nil
}

func (d sqliteDriver) BuildCount(ref ObjectRef, filter string) string {
	return "SELECT count(*) FROM " + d.target(ref) + whereClause(filter)
}

// BuildTruncate is a DELETE: SQLite has no TRUNCATE at all. The optimiser turns
// an unqualified DELETE into a truncate internally, so the cost is the same, but
// the semantics are not — triggers fire and it rolls back — which is why Caps
// advertises TruncateIsDelete for the confirmation to say so.
func (d sqliteDriver) BuildTruncate(ref ObjectRef) (string, error) {
	return "DELETE FROM " + d.target(ref), nil
}

func (d sqliteDriver) BuildDrop(ref ObjectRef, typ ObjectType) (string, error) {
	return buildDrop(d.target(ref), typ)
}

func (d sqliteDriver) BuildCreateTable(spec CreateTableSpec) (string, error) {
	return buildCreateTable(d, d.target(spec.Ref), spec)
}

// DescribeObject is the most restricted of the four. SQLite has no
// information_schema and no notion of a comment, keeps no row-count or size
// statistics, and stores check constraints only inside the original CREATE
// text. Everything it does answer, it answers through the pragma_* table-valued
// functions, which take a bound argument where bare PRAGMA would need the name
// interpolated.
func (d sqliteDriver) DescribeObject(ctx context.Context, db *sql.DB, ref ObjectRef) (*ObjectDetail, error) {
	det := &ObjectDetail{Ref: ref, Type: ObjectTable}

	cols, err := d.describeColumns(ctx, db, ref)
	if err != nil {
		return nil, err
	}
	det.Columns = cols

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

	// sqlite_master tells us whether this is a view, and holds the body if so.
	var kind string
	var ddl sql.NullString
	err = db.QueryRowContext(ctx,
		`SELECT type, sql FROM sqlite_master WHERE name = ? AND type IN ('table','view')`,
		ref.Name).Scan(&kind, &ddl)
	switch {
	case err == sql.ErrNoRows:
		// A temp table or one in an attached schema; not worth failing over.
	case err != nil:
		return nil, err
	case kind == "view":
		det.Type = ObjectView
		if ddl.Valid {
			v := ddl.String
			det.Definition = &v
		}
	}

	det.markUnavailable("rowEstimate", "SQLite keeps no row statistics — only an exact COUNT(*) is possible")
	det.markUnavailable("sizeBytes", "requires the dbstat module, which is not usually compiled in")
	det.markUnavailable("comment", "SQLite has no table or column comments")
	det.markUnavailable("checks", "SQLite exposes check constraints only inside the CREATE statement text")
	return det, nil
}

func (d sqliteDriver) EditFacts(ctx context.Context, db *sql.DB, ref ObjectRef) (EditFacts, error) {
	f, _, err := gatherEditFacts(
		func() ([]Column, error) { return d.describeColumns(ctx, db, ref) },
		func() ([]Index, error) { return d.describeIndexes(ctx, db, ref) },
		func() (bool, error) {
			var kind string
			err := db.QueryRowContext(ctx,
				`SELECT type FROM sqlite_master WHERE name = ? AND type IN ('table','view')`,
				ref.Name).Scan(&kind)
			// No row is a temp table or an attached schema: not a view as far as
			// we can tell, and describeColumns decides whether it exists at all.
			if err == sql.ErrNoRows {
				return false, nil
			}
			return kind == "view", err
		})
	return f, err
}

func (d sqliteDriver) describeColumns(ctx context.Context, db *sql.DB, ref ObjectRef) ([]Column, error) {
	// table_xinfo rather than table_info: it adds the hidden column, which is
	// how a generated column is reported (2 = virtual, 3 = stored).
	rows, err := db.QueryContext(ctx, `
		SELECT cid, name, type, "notnull", dflt_value, pk, hidden
		FROM pragma_table_xinfo(?)
		ORDER BY cid`, ref.Name)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Column
	pkCount := 0
	for rows.Next() {
		var (
			cid, notNull, pk, hidden int
			name, typ                string
			def                      sql.NullString
		)
		if err := rows.Scan(&cid, &name, &typ, &notNull, &def, &pk, &hidden); err != nil {
			return nil, err
		}
		if pk > 0 {
			pkCount++
		}
		c := Column{
			Name:       name,
			DataType:   typ,
			Nullable:   notNull == 0,
			PrimaryKey: pk > 0,
			Ordinal:    cid + 1,
			Generated:  hidden == 2 || hidden == 3,
		}
		if def.Valid {
			v := def.String
			c.Default = &v
		}
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// A single INTEGER PRIMARY KEY column is an alias for the rowid and so
	// self-assigns ascending values. That is SQLite's only autoincrement-like
	// behaviour, and it only applies when the key is that one column.
	if pkCount == 1 {
		for i := range out {
			if out[i].PrimaryKey && strings.EqualFold(strings.TrimSpace(out[i].DataType), "INTEGER") {
				out[i].AutoIncrement = true
			}
		}
	}
	return out, nil
}

func (d sqliteDriver) describeIndexes(ctx context.Context, db *sql.DB, ref ObjectRef) ([]Index, error) {
	// origin 'pk' marks the index backing a declared primary key. A rowid-alias
	// key has no index here at all, which is why primaryKeyOf also consults
	// the column flags.
	rows, err := db.QueryContext(ctx, `
		SELECT l.name, l."unique", l.origin, l.partial, i.name, i.seqno
		FROM pragma_index_list(?) l
		JOIN pragma_index_info(l.name) i
		ORDER BY l.seq, i.seqno`, ref.Name)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	acc := newIndexAccum()
	for rows.Next() {
		var (
			idxName, origin      string
			colName              sql.NullString
			uniq, partial, seqno int
		)
		if err := rows.Scan(&idxName, &uniq, &origin, &partial, &colName, &seqno); err != nil {
			return nil, err
		}
		// A NULL column name is an expression index; the index is still worth
		// listing, just without that position.
		acc.add(idxName, colName.String, uniq == 1, origin == "pk", "")
		if partial == 1 {
			acc.markPartial(idxName)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return acc.result(), nil
}

func (d sqliteDriver) describeForeignKeys(ctx context.Context, db *sql.DB, ref ObjectRef) ([]ForeignKey, error) {
	// pragma_foreign_key_list has no constraint name — SQLite does not store
	// one — so the id column stands in as the grouping key.
	rows, err := db.QueryContext(ctx, `
		SELECT id, seq, "table", "from", "to", on_update, on_delete
		FROM pragma_foreign_key_list(?)
		ORDER BY id, seq`, ref.Name)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	acc := newFKAccum()
	for rows.Next() {
		var (
			id, seq                      int
			refTable, onUpdate, onDelete string
			from                         string
			to                           sql.NullString
		)
		if err := rows.Scan(&id, &seq, &refTable, &from, &to, &onUpdate, &onDelete); err != nil {
			return nil, err
		}
		// A NULL "to" means the reference is to the target's primary key
		// implicitly; say so rather than showing an empty column.
		refCol := to.String
		if !to.Valid {
			refCol = "(primary key)"
		}
		acc.add(fmt.Sprintf("fk_%d", id), from, "", refTable, refCol, onUpdate, onDelete)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return acc.result(), nil
}

func (d sqliteDriver) describeTriggers(ctx context.Context, db *sql.DB, ref ObjectRef) ([]Trigger, error) {
	// sqlite_master stores the trigger body but not its timing or event as
	// columns, so both are left empty rather than parsed out of the SQL text.
	rows, err := db.QueryContext(ctx, `
		SELECT name FROM sqlite_master
		WHERE type = 'trigger' AND tbl_name = ?
		ORDER BY name`, ref.Name)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Trigger
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		out = append(out, Trigger{Name: name})
	}
	return out, rows.Err()
}
