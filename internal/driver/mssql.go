package driver

import (
	"context"
	"database/sql"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"

	_ "github.com/microsoft/go-mssqldb"
)

func init() { register(mssqlDriver{}) }

type mssqlDriver struct{ stdWriter }

func (mssqlDriver) Kind() Kind { return KindMSSQL }

func (mssqlDriver) Caps() Capabilities {
	return Capabilities{
		DisplayName:          "SQL Server",
		ServerHostsDatabases: true,
		HasSchemas:           true,
		// USE works on an open connection, and three-part names let a single
		// connection read any database on the server.
		DatabasePerConnection: false,
		SupportsFunctions:     true,
		SetToDefault:          true,
		DefaultPort:           1433,
		CommonTypes: []string{
			"bigint IDENTITY(1,1)", "int", "bigint", "bit",
			"nvarchar(255)", "nvarchar(max)", "varchar(255)", "uniqueidentifier",
			"decimal(10,2)", "float",
			"date", "datetime2", "datetimeoffset", "varbinary(max)",
		},
	}
}

func (mssqlDriver) SQLDriverName() string { return "sqlserver" }

func (mssqlDriver) DSN(cfg ConnConfig, database string) (string, error) {
	if database == "" {
		database = cfg.Database
	}
	host := cfg.Host
	if host == "" {
		host = "127.0.0.1"
	}
	port := cfg.Port
	if port == 0 {
		port = 1433
	}

	q := url.Values{}
	if database != "" {
		q.Set("database", database)
	}
	// go-mssqldb defaults to encrypt=true and will refuse a self-signed
	// certificate, which is what a local or containerised SQL Server has.
	// Trusting the cert by default matches what every other GUI does; the
	// user can override via Params.
	q.Set("encrypt", "true")
	q.Set("TrustServerCertificate", "true")
	if cfg.SSLMode != "" {
		q.Set("encrypt", cfg.SSLMode)
	}
	for k, v := range cfg.Params {
		q.Set(k, v)
	}

	u := &url.URL{
		Scheme:   "sqlserver",
		User:     url.UserPassword(cfg.User, cfg.Password),
		Host:     net.JoinHostPort(host, strconv.Itoa(port)),
		RawQuery: q.Encode(),
	}
	return u.String(), nil
}

func (mssqlDriver) QuoteIdent(ident string) string { return quoteWith("[", "]", ident) }

// capText casts to nvarchar(max) first: SUBSTRING is not defined on xml, and
// on the deprecated text/ntext types it returns a differently-typed value. The
// cast makes every capped column arrive as ordinary unicode text.
func (mssqlDriver) capText(expr string, n int) string {
	return fmt.Sprintf("SUBSTRING(CAST(%s AS nvarchar(max)), 1, %d)", expr, n)
}

func (d mssqlDriver) ListDatabases(ctx context.Context, db *sql.DB) ([]Database, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT name FROM sys.databases
		WHERE HAS_DBACCESS(name) = 1
		ORDER BY name`)
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

func (d mssqlDriver) ListObjects(ctx context.Context, db *sql.DB, database string) ([]SchemaObject, error) {
	if database == "" {
		return nil, fmt.Errorf("mssql: a database must be selected")
	}
	// Three-part naming reaches into the target database without a USE, so a
	// single pooled connection can serve the whole server. The database name
	// is quoted, not parameterised, because it is part of the object path
	// rather than a value.
	q := fmt.Sprintf(`
		SELECT s.name, o.name,
		       CASE o.type WHEN 'U' THEN 'table'
		                   WHEN 'V' THEN 'view'
		                   WHEN 'P' THEN 'procedure'
		                   ELSE 'function' END
		FROM %s.sys.objects o
		JOIN %s.sys.schemas s ON s.schema_id = o.schema_id
		WHERE o.type IN ('U','V','P','FN','IF','TF')
		ORDER BY o.type, s.name, o.name`,
		d.QuoteIdent(database), d.QuoteIdent(database))

	rows, err := db.QueryContext(ctx, q)
	if err != nil {
		return nil, err
	}
	recs, err := scanStrings(rows, 3)
	if err != nil {
		return nil, err
	}
	out := make([]SchemaObject, 0, len(recs))
	for _, r := range recs {
		var t ObjectType
		switch r[2] {
		case "table":
			t = ObjectTable
		case "view":
			t = ObjectView
		case "procedure":
			t = ObjectProcedure
		default:
			t = ObjectFunction
		}
		out = append(out, SchemaObject{Schema: r[0], Name: r[1], Type: t})
	}
	return out, nil
}

func (d mssqlDriver) ListColumns(ctx context.Context, db *sql.DB, ref ObjectRef) ([]Column, error) {
	schema := ref.Schema
	if schema == "" {
		schema = "dbo"
	}
	dbq := d.QuoteIdent(ref.Database)

	rows, err := db.QueryContext(ctx, fmt.Sprintf(`
		SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, ORDINAL_POSITION
		FROM %s.INFORMATION_SCHEMA.COLUMNS
		WHERE TABLE_SCHEMA = @p1 AND TABLE_NAME = @p2
		ORDER BY ORDINAL_POSITION`, dbq), schema, ref.Name)
	if err != nil {
		return nil, err
	}

	var out []Column
	if err := func() error {
		defer rows.Close()
		for rows.Next() {
			var (
				name, typ, nullable string
				def                 sql.NullString
				ord                 int
			)
			if err := rows.Scan(&name, &typ, &nullable, &def, &ord); err != nil {
				return err
			}
			c := Column{
				Name:     name,
				DataType: typ,
				Nullable: strings.EqualFold(nullable, "YES"),
				Ordinal:  ord,
			}
			if def.Valid {
				v := def.String
				c.Default = &v
			}
			out = append(out, c)
		}
		return rows.Err()
	}(); err != nil {
		return nil, err
	}

	pk, err := d.primaryKeyColumns(ctx, db, dbq, schema, ref.Name)
	if err != nil {
		return nil, fmt.Errorf("reading primary key: %w", err)
	}
	for i := range out {
		if pk[out[i].Name] {
			out[i].PrimaryKey = true
		}
	}
	return out, nil
}

func (d mssqlDriver) primaryKeyColumns(ctx context.Context, db *sql.DB, dbq, schema, table string) (map[string]bool, error) {
	rows, err := db.QueryContext(ctx, fmt.Sprintf(`
		SELECT ku.COLUMN_NAME
		FROM %s.INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
		JOIN %s.INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku
		  ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME
		 AND tc.CONSTRAINT_SCHEMA = ku.CONSTRAINT_SCHEMA
		WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
		  AND ku.TABLE_SCHEMA = @p1 AND ku.TABLE_NAME = @p2`, dbq, dbq), schema, table)
	if err != nil {
		return nil, err
	}
	recs, err := scanStrings(rows, 1)
	if err != nil {
		return nil, err
	}
	pk := make(map[string]bool, len(recs))
	for _, r := range recs {
		pk[r[0]] = true
	}
	return pk, nil
}

func (d mssqlDriver) target(ref ObjectRef) string {
	schema := ref.Schema
	if schema == "" {
		schema = "dbo"
	}
	return qualify(d, ref.Database, schema, ref.Name)
}

// BuildSelect uses OFFSET/FETCH, which SQL Server only permits alongside an
// ORDER BY. When the user has not chosen a sort we must invent one, or paging
// would return rows in an order the server is free to vary between pages —
// meaning rows could be skipped or repeated as you page through.
func (d mssqlDriver) BuildSelect(ref ObjectRef, opts ReadOptions, cols []Column) (string, error) {
	var b strings.Builder
	b.WriteString("SELECT " + selectList(d, opts, cols) + " FROM " + d.target(ref))
	b.WriteString(whereClause(opts.Filter))

	paging := opts.Limit > 0 || opts.Offset > 0
	order := orderByClause(d, opts.OrderBy)
	if order == "" && paging {
		order = " ORDER BY " + d.stableSortKey(cols)
	}
	b.WriteString(order)

	if paging {
		fmt.Fprintf(&b, " OFFSET %d ROWS", opts.Offset)
		if opts.Limit > 0 {
			fmt.Fprintf(&b, " FETCH NEXT %d ROWS ONLY", opts.Limit)
		}
	}
	return b.String(), nil
}

// stableSortKey picks the primary key, else the first column. (SELECT NULL) is
// the last resort — it satisfies the parser but gives no real ordering, so it
// is only reached when the column list could not be read at all.
func (d mssqlDriver) stableSortKey(cols []Column) string {
	var pk []string
	for _, c := range cols {
		if c.PrimaryKey {
			pk = append(pk, d.QuoteIdent(c.Name))
		}
	}
	if len(pk) > 0 {
		return strings.Join(pk, ", ")
	}
	if len(cols) > 0 {
		return d.QuoteIdent(cols[0].Name)
	}
	return "(SELECT NULL)"
}

func (d mssqlDriver) BuildCount(ref ObjectRef, filter string) string {
	return "SELECT count_big(*) FROM " + d.target(ref) + whereClause(filter)
}

func (d mssqlDriver) BuildTruncate(ref ObjectRef) (string, error) {
	return "TRUNCATE TABLE " + d.target(ref), nil
}

func (d mssqlDriver) BuildDrop(ref ObjectRef, typ ObjectType) (string, error) {
	return buildDrop(d.target(ref), typ)
}

func (d mssqlDriver) BuildChange(ref ObjectRef, ch Change) (Stmt, error) {
	return buildChange(d, d.target(ref), ch)
}

func (mssqlDriver) placeholder(n int) string { return "@p" + strconv.Itoa(n) }

// quoteString marks the literal as Unicode, which is how an nvarchar value is
// typed in T-SQL.
func (mssqlDriver) quoteString(s string) string {
	return "N'" + strings.ReplaceAll(s, "'", "''") + "'"
}

// BuildCreateTable cannot use the three-part name the rest of this driver relies
// on: SQL Server accepts a database qualifier on CREATE TABLE only when it names
// the *current* database, and this connection reaches other databases by
// qualifying rather than by switching. Sending the statement to the target
// database's own sp_executesql runs it in that database's context. A `USE`
// prefix would do the same thing and then leave the pooled connection pointing
// somewhere else for whoever picks it up next.
func (d mssqlDriver) BuildCreateTable(spec CreateTableSpec) (string, error) {
	schema := spec.Ref.Schema
	if schema == "" {
		schema = "dbo"
	}
	stmt, err := buildCreateTable(d, qualify(d, schema, spec.Ref.Name), spec)
	if err != nil {
		return "", err
	}
	if spec.Ref.Database == "" {
		return stmt, nil
	}
	return "EXEC " + qualify(d, spec.Ref.Database, "sys", "sp_executesql") +
		" N'" + strings.ReplaceAll(stmt, "'", "''") + "'", nil
}

// DescribeObject reads the sys.* catalog views rather than INFORMATION_SCHEMA,
// which does not expose identity, computed columns or index metadata. Each view
// is reached through a three-part name so one connection can describe an object
// in any database on the server, and the object itself is identified by
// OBJECT_ID of its qualified name.
//
// Descriptions live in sys.extended_properties under the MS_Description name,
// which is a convention rather than a built-in comment column — an object with
// no such property is simply uncommented, not unsupported.
func (d mssqlDriver) DescribeObject(ctx context.Context, db *sql.DB, ref ObjectRef) (*ObjectDetail, error) {
	det := &ObjectDetail{Ref: ref, Type: ObjectTable}
	dbq := d.QuoteIdent(ref.Database)
	obj := d.target(ref)

	var err error
	if det.Columns, err = d.describeColumns(ctx, db, dbq, obj); err != nil {
		return nil, err
	}
	if det.Indexes, err = d.describeIndexes(ctx, db, dbq, obj); err != nil {
		return nil, err
	}
	if det.ForeignKeys, err = d.describeForeignKeys(ctx, db, dbq, obj); err != nil {
		return nil, err
	}
	if det.Triggers, err = d.describeTriggers(ctx, db, dbq, obj); err != nil {
		return nil, err
	}
	if det.Checks, err = d.describeChecks(ctx, db, dbq, obj); err != nil {
		return nil, err
	}
	det.PrimaryKey = primaryKeyOf(det.Indexes, det.Columns)

	if err := d.describeObjectFacts(ctx, db, dbq, obj, det); err != nil {
		return nil, err
	}
	return det, nil
}

func (d mssqlDriver) describeObjectFacts(ctx context.Context, db *sql.DB, dbq, obj string, det *ObjectDetail) error {
	var objType string
	var comment sql.NullString
	var schemaName sql.NullString
	err := db.QueryRowContext(ctx, fmt.Sprintf(`
		SELECT o.type_desc, s.name,
		       (SELECT CAST(ep.value AS nvarchar(max))
		          FROM %s.sys.extended_properties ep
		         WHERE ep.major_id = o.object_id AND ep.minor_id = 0
		           AND ep.name = 'MS_Description')
		FROM %s.sys.objects o
		JOIN %s.sys.schemas s ON s.schema_id = o.schema_id
		WHERE o.object_id = OBJECT_ID(@p1)`, dbq, dbq, dbq), obj,
	).Scan(&objType, &schemaName, &comment)
	if err == sql.ErrNoRows {
		return nil
	}
	if err != nil {
		return err
	}

	isView := strings.HasPrefix(objType, "VIEW")
	if isView {
		det.Type = ObjectView
		var def sql.NullString
		if err := db.QueryRowContext(ctx, fmt.Sprintf(
			`SELECT %s.sys.sql_modules.definition FROM %s.sys.sql_modules
			 WHERE object_id = OBJECT_ID(@p1)`, dbq, dbq), obj).Scan(&def); err == nil && def.Valid {
			v := def.String
			det.Definition = &v
		}
		det.markUnavailable("rowEstimate", "a view has no stored rows to estimate")
		det.markUnavailable("sizeBytes", "a view has no storage of its own")
	} else {
		// index_id 0 is the heap and 1 the clustered index; a table has one or
		// the other, never both, so summing over those two covers the base rows
		// without double-counting nonclustered copies.
		var rowCount, pages sql.NullInt64
		if err := db.QueryRowContext(ctx, fmt.Sprintf(`
			SELECT SUM(p.row_count), SUM(p.used_page_count)
			FROM %s.sys.dm_db_partition_stats p
			WHERE p.object_id = OBJECT_ID(@p1) AND p.index_id IN (0, 1)`, dbq), obj,
		).Scan(&rowCount, &pages); err != nil {
			det.markUnavailable("rowEstimate", "partition statistics could not be read")
			det.markUnavailable("sizeBytes", "partition statistics could not be read")
		} else {
			if rowCount.Valid {
				det.RowEstimate = &rowCount.Int64
			} else {
				det.markUnavailable("rowEstimate", "no statistics recorded for this table")
			}
			if pages.Valid {
				// Every page is 8 KB.
				b := pages.Int64 * 8192
				det.SizeBytes = &b
			} else {
				det.markUnavailable("sizeBytes", "no page count recorded for this table")
			}
		}
	}

	if comment.Valid {
		v := comment.String
		det.Comment = &v
	}
	if schemaName.Valid && schemaName.String != "" {
		det.DialectDetail = append(det.DialectDetail, KeyValue{Key: "Schema", Value: schemaName.String})
	}
	det.DialectDetail = append(det.DialectDetail, KeyValue{Key: "Object type", Value: objType})
	return nil
}

func (d mssqlDriver) EditFacts(ctx context.Context, db *sql.DB, ref ObjectRef) (EditFacts, error) {
	dbq := d.QuoteIdent(ref.Database)
	obj := d.target(ref)
	f, cols, err := gatherEditFacts(
		func() ([]Column, error) { return d.describeColumns(ctx, db, dbq, obj) },
		func() ([]Index, error) { return d.describeIndexes(ctx, db, dbq, obj) },
		func() (bool, error) {
			var typeDesc string
			err := db.QueryRowContext(ctx, fmt.Sprintf(
				`SELECT type_desc FROM %s.sys.objects WHERE object_id = OBJECT_ID(@p1)`, dbq), obj,
			).Scan(&typeDesc)
			if err == sql.ErrNoRows {
				return false, nil
			}
			return strings.HasPrefix(typeDesc, "VIEW"), err
		})
	if err != nil {
		return f, err
	}
	// SQL Server refuses to write either of these, so a grid that offered the
	// edit would only ever show an error.
	for _, c := range cols {
		switch {
		case c.AutoIncrement:
			f.markReadOnly(c.Name, "identity column")
		case strings.EqualFold(c.DataType, "timestamp"), strings.EqualFold(c.DataType, "rowversion"):
			f.markReadOnly(c.Name, "rowversion column")
		}
	}
	return f, nil
}

func (d mssqlDriver) describeColumns(ctx context.Context, db *sql.DB, dbq, obj string) ([]Column, error) {
	// The type name is assembled here rather than in the UI so it reads the way
	// it was declared: nvarchar(50), decimal(10,2), varchar(max). max_length is
	// in bytes, so an n-type halves it, and -1 means max.
	rows, err := db.QueryContext(ctx, fmt.Sprintf(`
		SELECT c.name, t.name, c.max_length, c.precision, c.scale,
		       c.is_nullable, c.is_identity, c.is_computed, c.column_id,
		       c.collation_name, dc.definition,
		       (SELECT CAST(ep.value AS nvarchar(max))
		          FROM %s.sys.extended_properties ep
		         WHERE ep.major_id = c.object_id AND ep.minor_id = c.column_id
		           AND ep.name = 'MS_Description')
		FROM %s.sys.columns c
		JOIN %s.sys.types t ON t.user_type_id = c.user_type_id
		LEFT JOIN %s.sys.default_constraints dc
		       ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
		WHERE c.object_id = OBJECT_ID(@p1)
		ORDER BY c.column_id`, dbq, dbq, dbq, dbq), obj)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Column
	for rows.Next() {
		var (
			name, typ                    string
			maxLen                       int
			precision, scale             int
			nullable, identity, computed bool
			ordinal                      int
			collation, def, comment      sql.NullString
		)
		if err := rows.Scan(&name, &typ, &maxLen, &precision, &scale,
			&nullable, &identity, &computed, &ordinal,
			&collation, &def, &comment); err != nil {
			return nil, err
		}
		c := Column{
			Name:          name,
			DataType:      mssqlTypeName(typ, maxLen, precision, scale),
			Nullable:      nullable,
			Ordinal:       ordinal,
			AutoIncrement: identity,
			Generated:     computed,
		}
		if def.Valid {
			v := def.String
			c.Default = &v
		}
		if collation.Valid {
			v := collation.String
			c.Collation = &v
		}
		if comment.Valid {
			v := comment.String
			c.Comment = &v
		}
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// mssqlTypeName renders a sys.columns row the way the type was declared.
func mssqlTypeName(base string, maxLen, precision, scale int) string {
	switch strings.ToLower(base) {
	case "varchar", "char", "varbinary", "binary":
		if maxLen == -1 {
			return base + "(max)"
		}
		return fmt.Sprintf("%s(%d)", base, maxLen)
	case "nvarchar", "nchar":
		if maxLen == -1 {
			return base + "(max)"
		}
		// max_length counts bytes and these are two bytes per character.
		return fmt.Sprintf("%s(%d)", base, maxLen/2)
	case "decimal", "numeric":
		return fmt.Sprintf("%s(%d,%d)", base, precision, scale)
	case "datetime2", "datetimeoffset", "time":
		if scale != 7 {
			return fmt.Sprintf("%s(%d)", base, scale)
		}
	}
	return base
}

func (d mssqlDriver) describeIndexes(ctx context.Context, db *sql.DB, dbq, obj string) ([]Index, error) {
	// Included columns are excluded: they are part of the index payload rather
	// than its key, and listing them alongside key columns would misrepresent
	// the ordering that matters.
	rows, err := db.QueryContext(ctx, fmt.Sprintf(`
		SELECT i.name, i.is_unique, i.is_primary_key, i.type_desc,
		       c.name, ic.key_ordinal, i.has_filter
		FROM %s.sys.indexes i
		JOIN %s.sys.index_columns ic
		  ON ic.object_id = i.object_id AND ic.index_id = i.index_id
		JOIN %s.sys.columns c
		  ON c.object_id = ic.object_id AND c.column_id = ic.column_id
		WHERE i.object_id = OBJECT_ID(@p1)
		  AND ic.is_included_column = 0 AND i.name IS NOT NULL
		ORDER BY i.name, ic.key_ordinal`, dbq, dbq, dbq), obj)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	acc := newIndexAccum()
	for rows.Next() {
		var (
			idxName, method, colName string
			uniq, primary, filtered  bool
			ord                      int
		)
		if err := rows.Scan(&idxName, &uniq, &primary, &method, &colName, &ord, &filtered); err != nil {
			return nil, err
		}
		acc.add(idxName, colName, uniq, primary, method)
		if filtered {
			acc.markPartial(idxName)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return acc.result(), nil
}

func (d mssqlDriver) describeForeignKeys(ctx context.Context, db *sql.DB, dbq, obj string) ([]ForeignKey, error) {
	rows, err := db.QueryContext(ctx, fmt.Sprintf(`
		SELECT fk.name, pc.name, rs.name, rt.name, rc.name,
		       fk.update_referential_action_desc,
		       fk.delete_referential_action_desc,
		       fkc.constraint_column_id
		FROM %s.sys.foreign_keys fk
		JOIN %s.sys.foreign_key_columns fkc
		  ON fkc.constraint_object_id = fk.object_id
		JOIN %s.sys.columns pc
		  ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
		JOIN %s.sys.columns rc
		  ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
		JOIN %s.sys.tables rt ON rt.object_id = fk.referenced_object_id
		JOIN %s.sys.schemas rs ON rs.schema_id = rt.schema_id
		WHERE fk.parent_object_id = OBJECT_ID(@p1)
		ORDER BY fk.name, fkc.constraint_column_id`,
		dbq, dbq, dbq, dbq, dbq, dbq), obj)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	acc := newFKAccum()
	for rows.Next() {
		var (
			name, col, refSchema, refTable, refCol string
			upd, del                               string
			ord                                    int
		)
		if err := rows.Scan(&name, &col, &refSchema, &refTable, &refCol, &upd, &del, &ord); err != nil {
			return nil, err
		}
		if refSchema == "dbo" {
			refSchema = ""
		}
		// The _desc columns come back as NO_ACTION / SET_NULL; the underscore
		// is an enum artefact rather than part of the SQL keyword.
		acc.add(name, col, refSchema, refTable, refCol,
			strings.ReplaceAll(upd, "_", " "), strings.ReplaceAll(del, "_", " "))
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return acc.result(), nil
}

func (d mssqlDriver) describeTriggers(ctx context.Context, db *sql.DB, dbq, obj string) ([]Trigger, error) {
	// sys.trigger_events has one row per event, so a trigger on both INSERT and
	// UPDATE appears twice and the events are folded together here.
	rows, err := db.QueryContext(ctx, fmt.Sprintf(`
		SELECT t.name,
		       CASE WHEN t.is_instead_of_trigger = 1 THEN 'INSTEAD OF' ELSE 'AFTER' END,
		       te.type_desc
		FROM %s.sys.triggers t
		LEFT JOIN %s.sys.trigger_events te ON te.object_id = t.object_id
		WHERE t.parent_id = OBJECT_ID(@p1)
		ORDER BY t.name, te.type_desc`, dbq, dbq), obj)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Trigger
	byName := map[string]int{}
	for rows.Next() {
		var name, timing string
		var event sql.NullString
		if err := rows.Scan(&name, &timing, &event); err != nil {
			return nil, err
		}
		if i, seen := byName[name]; seen {
			if event.Valid {
				out[i].Event += " OR " + event.String
			}
			continue
		}
		byName[name] = len(out)
		out = append(out, Trigger{Name: name, Timing: timing, Event: event.String})
	}
	return out, rows.Err()
}

func (d mssqlDriver) describeChecks(ctx context.Context, db *sql.DB, dbq, obj string) ([]CheckConstraint, error) {
	rows, err := db.QueryContext(ctx, fmt.Sprintf(`
		SELECT name, definition
		FROM %s.sys.check_constraints
		WHERE parent_object_id = OBJECT_ID(@p1)
		ORDER BY name`, dbq), obj)
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
