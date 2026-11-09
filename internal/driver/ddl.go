package driver

import (
	"fmt"
	"strings"
)

// The three statements the object menu can run. They live here rather than in
// the SQL editor because the menu has to word them per dialect — SQLite has no
// TRUNCATE, DROP names the object type, and each dialect quotes differently —
// and because going through Driver is what puts them in the activity log.
//
// Only tables and views can be dropped. Functions and procedures need their
// argument types to be named in the DROP for at least one dialect, which the
// object tree does not carry, so they are refused rather than half-supported.

// NewColumn is one column in a CREATE TABLE.
//
// Type and Default are raw SQL fragments, not values: a type is `numeric(10,2)`
// or `bigint AUTO_INCREMENT`, a default is `now()` or `0`. Neither can be
// parameterised — DDL takes no placeholders — so both are interpolated after the
// checks in validateFragment, on the same terms as the row filter. See
// docs/adr/0002-raw-sql-filter.md.
type NewColumn struct {
	Name       string `json:"name"`
	Type       string `json:"type"`
	Nullable   bool   `json:"nullable"`
	PrimaryKey bool   `json:"primaryKey"`
	Default    string `json:"default"`
}

// CreateTableSpec is a whole CREATE TABLE. Ref.Name is the new table; Ref.Schema
// is empty on the dialects that have no schemas.
type CreateTableSpec struct {
	Ref     ObjectRef   `json:"ref"`
	Columns []NewColumn `json:"columns"`
}

// buildCreateTable renders the portable form, which is all four dialects: a
// column list, then a table-level PRIMARY KEY so a composite key needs no
// special case.
//
// target arrives already quoted by the dialect's own target().
func buildCreateTable(d Driver, target string, spec CreateTableSpec) (string, error) {
	if strings.TrimSpace(spec.Ref.Name) == "" {
		return "", fmt.Errorf("the table needs a name")
	}
	if len(spec.Columns) == 0 {
		return "", fmt.Errorf("the table needs at least one column")
	}

	var pk []string
	defs := make([]string, 0, len(spec.Columns)+1)
	seen := make(map[string]bool, len(spec.Columns))

	for i, c := range spec.Columns {
		name := strings.TrimSpace(c.Name)
		if name == "" {
			return "", fmt.Errorf("column %d has no name", i+1)
		}
		if seen[name] {
			return "", fmt.Errorf("duplicate column %q", name)
		}
		seen[name] = true

		typ := strings.TrimSpace(c.Type)
		if err := validateFragment("type", name, typ); err != nil {
			return "", err
		}

		def := d.QuoteIdent(name) + " " + typ
		// A primary key column is NOT NULL whatever the checkbox said — every
		// dialect enforces that anyway, and emitting "NULL" alongside it is an
		// error on some of them rather than a no-op.
		if c.Nullable && !c.PrimaryKey {
			def += " NULL"
		} else {
			def += " NOT NULL"
		}
		if dflt := strings.TrimSpace(c.Default); dflt != "" {
			if err := validateFragment("default", name, dflt); err != nil {
				return "", err
			}
			def += " DEFAULT " + dflt
		}
		defs = append(defs, def)

		if c.PrimaryKey {
			pk = append(pk, d.QuoteIdent(name))
		}
	}

	if len(pk) > 0 {
		defs = append(defs, "PRIMARY KEY ("+strings.Join(pk, ", ")+")")
	}

	return "CREATE TABLE " + target + " (\n  " + strings.Join(defs, ",\n  ") + "\n)", nil
}

// validateFragment is the one guard on the two raw fragments in a column
// definition. It cannot make them safe — a type is arbitrary SQL by design —
// but it stops the two shapes that turn one statement into several, so a typo
// in the type box cannot append a second statement to the CREATE.
func validateFragment(what, column, frag string) error {
	if frag == "" {
		return fmt.Errorf("column %q has no %s", column, what)
	}
	if strings.Contains(frag, ";") {
		return fmt.Errorf("the %s for %q must not contain a semicolon", what, column)
	}
	if strings.Contains(frag, "--") || strings.Contains(frag, "/*") {
		return fmt.Errorf("the %s for %q must not contain a comment", what, column)
	}
	return nil
}

// ValidateExpr guards a SQL expression set as a cell's value, on the same
// terms as a column definition's fragments.
func ValidateExpr(column, expr string) error {
	return validateFragment("SQL expression", column, expr)
}

// buildDrop renders DROP for the object types the tree can point at.
func buildDrop(target string, typ ObjectType) (string, error) {
	switch typ {
	case ObjectTable:
		return "DROP TABLE " + target, nil
	case ObjectView:
		return "DROP VIEW " + target, nil
	default:
		return "", fmt.Errorf("cannot drop a %s from here — use the SQL editor", typ)
	}
}
