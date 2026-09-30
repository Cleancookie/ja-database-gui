package driver

import "strings"

// Helpers shared by the four DescribeObject implementations.
//
// Every dialect reports a multi-column index or foreign key as one row per
// column, ordered by position within the key. Rather than each driver building
// arrays in SQL — which would mean four different array syntaxes and four
// different scan paths — they all stream those rows and accumulate here.

// indexAccum groups index rows arriving in (name, position) order.
type indexAccum struct {
	order  []string
	byName map[string]*Index
}

func newIndexAccum() *indexAccum {
	return &indexAccum{byName: map[string]*Index{}}
}

// add appends one column to the named index, creating it on first sight. The
// flags are taken from the first row for a given name; every dialect repeats
// them identically on each row of the same index.
func (a *indexAccum) add(name, column string, unique, primary bool, method string) {
	ix, ok := a.byName[name]
	if !ok {
		ix = &Index{Name: name, Unique: unique, Primary: primary, Method: method}
		a.byName[name] = ix
		a.order = append(a.order, name)
	}
	if column != "" {
		ix.Columns = append(ix.Columns, column)
	} else {
		// A position with no column name is an expression.
		ix.partial = true
	}
}

// markPartial flags an index whose uniqueness is over a subset of rows.
func (a *indexAccum) markPartial(name string) {
	if ix, ok := a.byName[name]; ok {
		ix.partial = true
	}
}

// result returns the indexes in first-seen order, primary key first. The
// primary is surfaced first because it is what someone opening the view is
// most likely looking for.
func (a *indexAccum) result() []Index {
	out := make([]Index, 0, len(a.order))
	for _, n := range a.order {
		if a.byName[n].Primary {
			out = append(out, *a.byName[n])
		}
	}
	for _, n := range a.order {
		if !a.byName[n].Primary {
			out = append(out, *a.byName[n])
		}
	}
	return out
}

// fkAccum groups foreign-key rows arriving in (name, position) order.
type fkAccum struct {
	order  []string
	byName map[string]*ForeignKey
}

func newFKAccum() *fkAccum {
	return &fkAccum{byName: map[string]*ForeignKey{}}
}

func (a *fkAccum) add(name, column, refSchema, refTable, refColumn, onUpdate, onDelete string) {
	fk, ok := a.byName[name]
	if !ok {
		fk = &ForeignKey{
			Name:             name,
			ReferencedSchema: refSchema,
			ReferencedTable:  refTable,
			OnUpdate:         strings.ToUpper(onUpdate),
			OnDelete:         strings.ToUpper(onDelete),
		}
		a.byName[name] = fk
		a.order = append(a.order, name)
	}
	fk.Columns = append(fk.Columns, column)
	fk.ReferencedColumns = append(fk.ReferencedColumns, refColumn)
}

func (a *fkAccum) result() []ForeignKey {
	out := make([]ForeignKey, 0, len(a.order))
	for _, n := range a.order {
		out = append(out, *a.byName[n])
	}
	return out
}

// primaryKeyOf pulls the primary-key column names out of an already-built
// index list, falling back to the columns flagged PrimaryKey. Two sources
// because SQLite reports a rowid-alias primary key on the column and not in
// pragma_index_list, so neither source alone covers every dialect.
func primaryKeyOf(indexes []Index, cols []Column) []string {
	for _, ix := range indexes {
		if ix.Primary && len(ix.Columns) > 0 {
			return ix.Columns
		}
	}
	var out []string
	for _, c := range cols {
		if c.PrimaryKey {
			out = append(out, c.Name)
		}
	}
	return out
}

// markUnavailable records why a field could not be filled. Kept as a helper so
// a driver does not have to nil-check the map at every call site.
func (d *ObjectDetail) markUnavailable(field, reason string) {
	if d.Unavailable == nil {
		d.Unavailable = map[string]string{}
	}
	d.Unavailable[field] = reason
}

// pgReferentialAction expands the single-character referential actions that
// postgres stores in pg_constraint.confupdtype / confdeltype.
func pgReferentialAction(c string) string {
	switch c {
	case "a":
		return "NO ACTION"
	case "r":
		return "RESTRICT"
	case "c":
		return "CASCADE"
	case "n":
		return "SET NULL"
	case "d":
		return "SET DEFAULT"
	}
	return ""
}
