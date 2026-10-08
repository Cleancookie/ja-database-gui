package driver

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// JSON path edits: an update that changes part of a JSON value in place, so a
// one-key edit to a 1 MB document sends the key, not the document.
//
// Edits nest: each wraps the expression before it, f(f(col, p1, v1), p2, v2).
// Paths and values are always bound, never spliced — keys are data-authored.
// A rename reads the value before it twice (once to remove the key, once to
// extract its value), so that expression is rendered, and its values bound,
// twice. Each rename in one cell doubles what precedes it; fine for the handful
// a person makes.

// JSONOp is one kind of path edit.
type JSONOp string

const (
	JSONSet    JSONOp = "set"    // replace, or create an object key
	JSONRemove JSONOp = "remove" // delete an object key or array element
	JSONRename JSONOp = "rename" // move an object key's value to a sibling key
	JSONAppend JSONOp = "append" // add to the end of an array
)

// PathStep is one step from the root: an object key, or an array index.
type PathStep struct {
	Key     string
	Index   int
	IsIndex bool
}

// JSONEdit is one edit. Value is JSON text (set, append); NewKey is the sibling
// a rename moves to. The API checks the shape; a dialect refuses what it cannot
// express.
type JSONEdit struct {
	Op     JSONOp
	Path   []PathStep
	Value  string
	NewKey string
}

// jsonEditor is how a dialect expresses one edit. x renders the value before the
// edit and may be called more than once; each call binds its values again. Like
// textCapper it is not part of Driver.
type jsonEditor interface {
	jsonEdit(x func() string, e JSONEdit, val func(any) string) (string, error)
}

// jsonCaster is for a dialect whose JSON functions want one type in and the
// column's own type out (postgres: jsonb).
type jsonCaster interface {
	jsonColumn(col, dataType string) (in string, out func(string) string)
}

// jsonEditExpr renders the whole nest of edits for one assignment.
func jsonEditExpr(d writerDriver, a Assignment, val func(any) string) (string, error) {
	je, ok := d.(jsonEditor)
	if !ok {
		return "", fmt.Errorf("column %q: %s cannot edit JSON by path", a.Column, d.Caps().DisplayName)
	}
	in, out := d.QuoteIdent(a.Column), func(s string) string { return s }
	if c, ok := d.(jsonCaster); ok {
		in, out = c.jsonColumn(in, a.DataType)
	}
	var err error
	x := func() string { return in }
	for _, e := range a.Edits {
		prev := x
		x = func() string {
			s, eErr := je.jsonEdit(prev, e, val)
			if eErr != nil && err == nil {
				err = fmt.Errorf("column %q: %w", a.Column, eErr)
			}
			return s
		}
	}
	s := out(x())
	return s, err
}

// renamedPath is the rename's destination: the same parent, the new key.
func renamedPath(e JSONEdit) []PathStep {
	p := append([]PathStep(nil), e.Path[:len(e.Path)-1]...)
	return append(p, PathStep{Key: e.NewKey})
}

// jsonPath renders a "$.key[3]" path; quoteKey renders one object key.
func jsonPath(path []PathStep, quoteKey func(string) (string, error)) (string, error) {
	var b strings.Builder
	b.WriteString("$")
	for _, s := range path {
		if s.IsIndex {
			b.WriteString("[" + strconv.Itoa(s.Index) + "]")
			continue
		}
		k, err := quoteKey(s.Key)
		if err != nil {
			return "", err
		}
		b.WriteString("." + k)
	}
	return b.String(), nil
}

// jsonQuoteKey is a key as a JSON string, which is how MySQL and SQL Server
// quote a path key.
func jsonQuoteKey(k string) (string, error) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(k); err != nil {
		return "", err
	}
	return strings.TrimSuffix(b.String(), "\n"), nil
}

// HoldsJSON says whether a column can hold JSON to edit by path: a JSON type, or
// text, which people use for JSON too. SQLite's untyped column counts as text.
func HoldsJSON(c Column) bool {
	t := strings.ToUpper(c.DataType)
	if t == "" {
		return true
	}
	for _, s := range []string{"JSON", "TEXT", "CHAR", "CLOB"} {
		if strings.Contains(t, s) {
			return true
		}
	}
	return false
}
