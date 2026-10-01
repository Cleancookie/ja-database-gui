package driver

import (
	"fmt"
	"strings"
)

// Keyset paging.
//
// LIMIT/OFFSET counts rows from the top on every request, so a row inserted
// above the window shifts everything down by one and the next page repeats a
// row the last one ended on; a delete skips one. With a table that grows while
// it is being read, newest first, that is the ordinary case. Keyset paging asks
// instead for the rows *after* the last one seen, which inserts and deletes
// elsewhere cannot move.
//
// It needs an order that is total — no two rows tie — which means the sort has
// to end in a unique key, and a comparison that is exact, which rules out
// nullable sort columns (NULL compares as unknown), floats (the cursor travels
// as text and would lose digits), and columns whose value the grid does not
// hold in full (binary previews). Capped text is allowed — a long TEXT column
// is a natural thing to sort by — but a position whose value was cut is not
// used; the caller checks that per row (see api.cursorAfter). Where any of this
// fails the caller falls back to offset paging; nothing here is required for
// correctness.

// Cursor is the position of one row in a given order: the values of its sort
// columns, in sort order. It travels to the UI and back unchanged.
type Cursor struct {
	Columns []string `json:"columns"`
	Values  []any    `json:"values"`
}

// StableOrder appends to order whichever key columns it lacks, ascending, so
// rows that tie on the chosen sort come back in the same order every time. That
// alone makes offset paging repeat-free when nothing is being written.
//
// keyset reports whether the resulting order also supports keyset paging. key
// is the columns that identify a row (EditFacts.EditKey); with none there is no
// tiebreaker to add and the order is returned as it came.
func StableOrder(order []Sort, cols []Column, key []string) (full []Sort, keyset bool) {
	full = append([]Sort(nil), order...)
	if len(key) == 0 {
		return full, false
	}
	have := make(map[string]bool, len(full))
	for _, s := range full {
		have[s.Column] = true
	}
	for _, k := range key {
		if !have[k] {
			full = append(full, Sort{Column: k})
			have[k] = true
		}
	}

	byName := make(map[string]Column, len(cols))
	for _, c := range cols {
		byName[c.Name] = c
	}
	// A key column is never NULL, whatever the catalogue says: SQLite reports an
	// INTEGER PRIMARY KEY as nullable, and EditKey is by definition NOT NULL.
	isKey := make(map[string]bool, len(key))
	for _, k := range key {
		isKey[k] = true
	}
	for _, s := range full {
		c, ok := byName[s.Column]
		if !ok || !comparableExactly(c, isKey[s.Column]) {
			return full, false
		}
	}
	return full, true
}

// comparableExactly says whether a value read from the grid can stand in for
// the stored one in an inequality.
func comparableExactly(c Column, key bool) bool {
	if c.Nullable && !key {
		return false
	}
	base, _, _ := splitTypeArg(c.DataType)
	if isBinaryType(base) {
		return false
	}
	return classify(c.DataType) != classFloat
}

// BuildRead builds the browse query as a statement. Without a cursor or a key
// it is just BuildSelect. With either, the extra condition is added to the
// filter and its values are bound rather than written into the text; Display is
// the same statement with the values filled in, for the activity log.
func BuildRead(d Driver, ref ObjectRef, opts ReadOptions, cols []Column) (Stmt, error) {
	if len(opts.After) == 0 && len(opts.Key) == 0 {
		sql, err := d.BuildSelect(ref, opts, cols)
		return Stmt{SQL: sql, Display: sql, Short: sql}, err
	}
	w, ok := d.(writerDriver)
	if !ok {
		return Stmt{}, fmt.Errorf("%s cannot read by position or key", d.Caps().DisplayName)
	}
	if len(opts.After) > 0 && len(opts.After) != len(opts.OrderBy) {
		return Stmt{}, fmt.Errorf("a position needs one value per sort column")
	}

	// One template, rendered once with placeholders for the statement that runs
	// and once with literals for the one that is shown — the same arrangement as
	// row writes (write.go).
	extra := func(val func(any) string) string {
		var conds []string
		for _, k := range opts.Key {
			conds = append(conds, d.QuoteIdent(k.Column)+" = "+val(k.Value))
		}
		if len(opts.After) > 0 {
			conds = append(conds, keysetCondition(d, opts.OrderBy, opts.After, val))
		}
		return strings.Join(conds, " AND ")
	}
	var args []any
	bound := extra(func(v any) string {
		args = append(args, v)
		return w.placeholder(len(args))
	})
	shown := extra(func(v any) string { return literal(w, v, ShortLiteralChars) })

	build := func(cond string) (string, error) {
		o := opts
		o.After, o.Key = nil, nil
		if len(opts.Key) > 0 {
			o.Filter = cond
		} else {
			o.Filter = joinFilter(opts.Filter, cond)
		}
		return d.BuildSelect(ref, o, cols)
	}
	sql, err := build(bound)
	if err != nil {
		return Stmt{}, err
	}
	display, err := build(shown)
	if err != nil {
		return Stmt{}, err
	}
	return Stmt{SQL: sql, Args: args, Display: display, Short: display}, nil
}

// joinFilter puts the user's raw filter and a generated condition under one
// WHERE. The filter is parenthesised: it is free text and may hold an OR.
func joinFilter(filter, cond string) string {
	f := strings.TrimPrefix(whereClause(filter), " WHERE ")
	if f == "" {
		return cond
	}
	return "(" + f + ") AND " + cond
}

// keysetCondition is "the row comes after `after` in this order":
//
//	(a > ?) OR (a = ? AND b < ?) OR (a = ? AND b = ? AND id > ?)
//
// A tuple comparison would be shorter, but it cannot mix directions, and SQL
// Server has none. Each term is the ordinary lexicographic step, with the
// operator following the direction of the column it breaks on.
func keysetCondition(d Driver, sorts []Sort, after []any, val func(any) string) string {
	terms := make([]string, 0, len(sorts))
	for i := range sorts {
		parts := make([]string, 0, i+1)
		for j := 0; j < i; j++ {
			parts = append(parts, d.QuoteIdent(sorts[j].Column)+" = "+val(after[j]))
		}
		op := " > "
		if sorts[i].Desc {
			op = " < "
		}
		parts = append(parts, d.QuoteIdent(sorts[i].Column)+op+val(after[i]))
		terms = append(terms, "("+strings.Join(parts, " AND ")+")")
	}
	return "(" + strings.Join(terms, " OR ") + ")"
}
