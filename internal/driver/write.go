package driver

import (
	"fmt"
	"strconv"
	"strings"
)

// Row writes. A dialect supplies its placeholders and its string literal; the
// statements themselves are assembled once, here.
//
// Two renderings come out of the same assembly. SQL is parameterised and is what
// runs — a value is never concatenated into it. Display has the literals inlined
// so a person can read what will happen, and is never executed. They share one
// template function, so the preview cannot describe a statement that differs from
// the one that runs.

// ChangeOp is the kind of row change.
type ChangeOp string

const (
	ChangeUpdate ChangeOp = "update"
	ChangeInsert ChangeOp = "insert"
	ChangeDelete ChangeOp = "delete"
)

// Assignment sets one column. Value is what is bound; nil binds NULL. Default
// wins over Value and writes the DEFAULT keyword instead of a parameter.
type Assignment struct {
	Column  string
	Value   any
	Default bool
}

// KeyCond is one column of the WHERE that addresses a row: Column = Value.
type KeyCond struct {
	Column string
	Value  any
}

// Change is one statement's worth of row edit, already coerced and ordered.
type Change struct {
	Op  ChangeOp
	Key []KeyCond    // update, delete
	Set []Assignment // update, insert
}

// Stmt is a built statement. Run SQL with Args. Display is for people only.
type Stmt struct {
	SQL     string
	Args    []any
	Display string
}

// rowWriter is the per-dialect part of a write. Unexported, like textCapper: the
// Driver interface stays introspection-shaped plus the few Build* entry points.
type rowWriter interface {
	// placeholder is the n'th (1-based) parameter marker.
	placeholder(n int) string
	// quoteString renders a string literal, for the Display text only.
	quoteString(s string) string
	boolLiteral(b bool) string
	// emptyInsert follows the table name when an insert names no columns.
	emptyInsert() string
}

// writerDriver is what buildChange needs from a dialect.
type writerDriver interface {
	Driver
	rowWriter
}

// stdWriter is the default for the parts most dialects agree on. A dialect
// embeds it and overrides only what differs.
type stdWriter struct{}

func (stdWriter) quoteString(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }
func (stdWriter) emptyInsert() string         { return " DEFAULT VALUES" }
func (stdWriter) boolLiteral(b bool) string {
	if b {
		return "1"
	}
	return "0"
}

// qmarkWriter is `?` placeholders, which MySQL and SQLite share.
type qmarkWriter struct{ stdWriter }

func (qmarkWriter) placeholder(int) string { return "?" }

// buildChange assembles one INSERT, UPDATE or DELETE against target, which
// arrives already quoted by the dialect's own target().
func buildChange(d writerDriver, target string, ch Change) (Stmt, error) {
	var args []any
	bound, err := renderChange(d, target, ch, func(v any) string {
		args = append(args, v)
		return d.placeholder(len(args))
	})
	if err != nil {
		return Stmt{}, err
	}
	display, _ := renderChange(d, target, ch, func(v any) string { return literal(d, v) })
	return Stmt{SQL: bound, Args: args, Display: display}, nil
}

// renderChange is the one template. val renders each value position: as a
// placeholder when building the statement that runs, as a literal for display.
func renderChange(d writerDriver, target string, ch Change, val func(any) string) (string, error) {
	switch ch.Op {
	case ChangeUpdate:
		if len(ch.Set) == 0 {
			return "", fmt.Errorf("an update must change at least one column")
		}
		sets := make([]string, 0, len(ch.Set))
		for _, a := range ch.Set {
			if a.Default && !d.Caps().SetToDefault {
				return "", fmt.Errorf("column %q: %s has no DEFAULT to set a column back to", a.Column, d.Caps().DisplayName)
			}
			sets = append(sets, d.QuoteIdent(a.Column)+" = "+assignedValue(a, val))
		}
		where, err := whereKey(d, ch.Key, val)
		if err != nil {
			return "", err
		}
		return "UPDATE " + target + " SET " + strings.Join(sets, ", ") + where, nil

	case ChangeDelete:
		where, err := whereKey(d, ch.Key, val)
		if err != nil {
			return "", err
		}
		return "DELETE FROM " + target + where, nil

	case ChangeInsert:
		var cols, vals []string
		for _, a := range ch.Set {
			// Where there is no DEFAULT keyword, leaving the column out of an
			// insert says the same thing.
			if a.Default && !d.Caps().SetToDefault {
				continue
			}
			cols = append(cols, d.QuoteIdent(a.Column))
			vals = append(vals, assignedValue(a, val))
		}
		if len(cols) == 0 {
			return "INSERT INTO " + target + d.emptyInsert(), nil
		}
		return "INSERT INTO " + target + " (" + strings.Join(cols, ", ") + ") VALUES (" + strings.Join(vals, ", ") + ")", nil
	}
	return "", fmt.Errorf("unknown change %q", ch.Op)
}

func assignedValue(a Assignment, val func(any) string) string {
	if a.Default {
		return "DEFAULT"
	}
	return val(a.Value)
}

// whereKey renders the key. A key is never empty and never NULL: a WHERE that
// matched nothing, or everything, is exactly the statement to refuse to build.
func whereKey(d Driver, key []KeyCond, val func(any) string) (string, error) {
	if len(key) == 0 {
		return "", fmt.Errorf("a change to an existing row needs its key")
	}
	conds := make([]string, 0, len(key))
	for _, k := range key {
		if k.Value == nil {
			return "", fmt.Errorf("key column %q is NULL, which matches no row", k.Column)
		}
		conds = append(conds, d.QuoteIdent(k.Column)+" = "+val(k.Value))
	}
	return " WHERE " + strings.Join(conds, " AND "), nil
}

// literal renders a bound value the way it would be typed, for Display.
func literal(w rowWriter, v any) string {
	switch x := v.(type) {
	case nil:
		return "NULL"
	case bool:
		return w.boolLiteral(x)
	case int64:
		return strconv.FormatInt(x, 10)
	case float64:
		return strconv.FormatFloat(x, 'g', -1, 64)
	case string:
		return w.quoteString(x)
	}
	return w.quoteString(fmt.Sprint(v))
}
