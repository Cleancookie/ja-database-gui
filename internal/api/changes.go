package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/Cleancookie/ja-db/internal/activity"
	"github.com/Cleancookie/ja-db/internal/driver"
	"github.com/Cleancookie/ja-db/internal/engine"
	"github.com/Cleancookie/ja-db/internal/query"
)

// Row edits from the grid, as a change set that is previewed and then applied.
//
// PreviewChanges and ApplyChanges both go through planChanges, so what the
// preview shows is what apply runs — not two implementations that agree today.
// Nothing here trusts the grid: the key must be the table's own, every column
// must exist and be writable, and values are coerced and bound, never spliced in.

// CellValue is what one cell is to become. "empty string", "NULL" and "whatever
// the column defaults to" are three different intents that a bare string cannot
// tell apart; "json" changes part of the JSON already there.
type CellValue struct {
	// Kind is "value", "null", "default" or "json".
	Kind string `json:"kind"`
	// Value is the text to store, for kind "value". It is coerced by the
	// column's type, so "42" is written as a number to an integer column.
	Value string `json:"value,omitempty"`
	// Edits, for kind "json", are applied in order to the column's current value.
	// Update only, on a json or text column.
	Edits []JSONEdit `json:"edits,omitempty"`
}

// JSONEdit changes one place in a JSON value.
type JSONEdit struct {
	// Op is "set", "remove", "rename" or "append".
	Op string `json:"op"`
	// Path runs from the root: a string is an object key, a number an array
	// index. Only append may have an empty path, for an array at the root.
	Path []any `json:"path"`
	// Value is JSON text, for set and append.
	Value string `json:"value,omitempty"`
	// NewKey is where a rename moves the key at Path, in the same object.
	NewKey string `json:"newKey,omitempty"`
}

// RowChange is one row's edit.
type RowChange struct {
	// Ref is the table this change is for. A change set may span several tables,
	// but all in one database of the request's connection.
	Ref driver.ObjectRef `json:"ref"`
	// Op is "update", "insert" or "delete".
	Op string `json:"op"`
	// Key holds the ORIGINAL values of the table's key columns, as ReadRows sent
	// them, and must name exactly ReadRowsResult.EditKey. Update and delete only.
	Key map[string]any `json:"key,omitempty"`
	// Set maps column to new value: for an update, the changed columns only; for
	// an insert, the columns being given a value.
	Set map[string]CellValue `json:"set,omitempty"`
}

// ChangesRequest lists the edits, each addressing its own table. Changes are
// applied in order, in one transaction, so they all share one connection and one
// database.
type ChangesRequest struct {
	ConnectionID string      `json:"connectionId"`
	Changes      []RowChange `json:"changes"`
}

// StatementCell says what one column of a statement is set to, so the UI can
// show "data: 48,211 chars" without reading the SQL.
type StatementCell struct {
	Column string `json:"column"`
	// Kind is "value", "null", "default" or "json".
	Kind string `json:"kind"`
	// Chars is the length in characters of the new text, for kind "value", or
	// of all the edits' values together, for kind "json".
	Chars int `json:"chars"`
	// Edits is how many JSON edits, for kind "json".
	Edits int `json:"edits,omitempty"`
}

// Statement is one change as SQL. SQL is what runs, with parameter markers.
// Display is the same statement with the values written in, for a person to
// read; it is never executed. Short is Display with every string literal over
// driver.ShortLiteralChars cut and ending "…(+N more chars)".
type Statement struct {
	SQL     string `json:"sql"`
	Display string `json:"display"`
	Short   string `json:"short"`
	// Table is the qualified name of the table the statement touches.
	Table string `json:"table"`
	// Cells lists the set columns in column order. Empty for a delete.
	Cells []StatementCell `json:"cells"`
}

// ChangesPreview has one Statement per change, in order.
type ChangesPreview struct {
	Statements []Statement `json:"statements"`
}

// ChangeConflict says which change stopped the apply, and why.
type ChangeConflict struct {
	// Index is into ChangesRequest.Changes, from 0.
	Index int `json:"index"`
	// Table is the qualified name of the table that change was for.
	Table   string `json:"table"`
	Message string `json:"message"`
}

// ApplyResult is all or nothing: either every change was applied and Conflict is
// nil, or none was — the transaction was rolled back — and Applied is 0.
type ApplyResult struct {
	Applied  int             `json:"applied"`
	Conflict *ChangeConflict `json:"conflict,omitempty"`
}

// PreviewChanges renders the statements ApplyChanges would run. It runs none of
// them: the only queries it issues are the catalogue reads that validation needs.
func (s *Service) PreviewChanges(ctx context.Context, req ChangesRequest) (ChangesPreview, error) {
	plan, err := s.planChanges(ctx, req)
	if err != nil {
		return ChangesPreview{}, err
	}
	out := ChangesPreview{Statements: make([]Statement, 0, len(plan.stmts))}
	for _, st := range plan.stmts {
		out.Statements = append(out.Statements, st.info)
	}
	return out, nil
}

// errConflict carries a ChangeConflict out of the transaction. It is an error so
// the runner records the whole write as failed in the activity log.
type errConflict struct{ ChangeConflict }

func (e *errConflict) Error() string {
	return fmt.Sprintf("change %d: %s", e.Index+1, e.Message)
}

// ApplyChanges runs the change set in one transaction. Every update and delete
// must touch exactly one row, and so must every insert; anything else — an error
// from the database, no row matching because it changed or went away since it was
// loaded, several matching because the key is not unique — rolls the lot back and
// reports which change it was. A conflict is a result, not an error: the caller
// has something to show.
func (s *Service) ApplyChanges(ctx context.Context, req ChangesRequest) (ApplyResult, error) {
	plan, err := s.planChanges(ctx, req)
	if err != nil {
		return ApplyResult{}, err
	}
	stmts := plan.stmts

	// The log gets the parameterised text, which is what was sent, under a
	// comment saying how wide the transaction is. The values are in Args and
	// deliberately not logged.
	logged := make([]string, len(stmts))
	for i, st := range stmts {
		logged[i] = st.built.SQL
	}

	err = s.runner.Do(ctx, query.Op{
		ConnectionID: req.ConnectionID,
		Database:     plan.database,
		Kind:         activity.KindWrite,
		SQL:          plan.label() + "\n" + strings.Join(logged, ";\n"),
	}, func(qctx context.Context) error {
		tx, err := plan.sess.DB.BeginTx(qctx, nil)
		if err != nil {
			return err
		}
		// A no-op once committed, and the rollback on every other way out.
		defer tx.Rollback()

		for i, st := range stmts {
			res, err := tx.ExecContext(qctx, st.built.SQL, st.built.Args...)
			if err != nil {
				if qctx.Err() != nil {
					return qctx.Err() // cancelled from the tray, not a conflict
				}
				return &errConflict{ChangeConflict{Index: i, Table: st.info.Table, Message: err.Error()}}
			}
			n, err := res.RowsAffected()
			if err != nil {
				return &errConflict{ChangeConflict{Index: i, Table: st.info.Table, Message: "could not confirm how many rows changed: " + err.Error()}}
			}
			if n != 1 {
				return &errConflict{ChangeConflict{Index: i, Table: st.info.Table, Message: rowCountMessage(req.Changes[i].Op, n)}}
			}
		}
		return tx.Commit()
	})

	var conflict *errConflict
	switch {
	case errors.As(err, &conflict):
		return ApplyResult{Conflict: &conflict.ChangeConflict}, nil
	case err != nil:
		return ApplyResult{}, err
	}
	return ApplyResult{Applied: len(stmts)}, nil
}

func rowCountMessage(op string, n int64) string {
	switch {
	case op == string(driver.ChangeInsert):
		return fmt.Sprintf("the insert added %d rows, not 1; nothing was saved", n)
	case n == 0:
		return "no row matched: it was changed or deleted since it was loaded; nothing was saved"
	default:
		return fmt.Sprintf("%d rows matched: the key does not identify a single row; nothing was saved", n)
	}
}

// plannedStmt is a built statement with what the UI is told about it.
type plannedStmt struct {
	built driver.Stmt // what runs
	info  Statement   // what the UI is told
}

// changePlan is a validated change set, ready to preview or run.
type changePlan struct {
	sess     *engine.Session
	database string
	tables   int
	stmts    []plannedStmt
}

// label is the leading line of the activity entry.
func (p changePlan) label() string {
	return fmt.Sprintf("-- %s across %s", plural(len(p.stmts), "change"), plural(p.tables, "table"))
}

func plural(n int, noun string) string {
	if n == 1 {
		return "1 " + noun
	}
	return fmt.Sprintf("%d %ss", n, noun)
}

// tableFacts is what validating a change needs to know about one table.
type tableFacts struct {
	cols  []driver.Column
	facts driver.EditFacts
}

// planChanges validates a change set against each table's live editing facts and
// builds one statement per change. It is the only place statements are made.
//
// The connection is the request's and the database is the first change's: a
// transaction cannot span databases, so a change naming another is refused.
func (s *Service) planChanges(ctx context.Context, req ChangesRequest) (changePlan, error) {
	if len(req.Changes) == 0 {
		return changePlan{}, fmt.Errorf("no changes to apply")
	}
	database := req.Changes[0].Ref.Database
	sess, err := s.session(ctx, req.ConnectionID, database)
	if err != nil {
		return changePlan{}, err
	}

	byTable := map[driver.ObjectRef]tableFacts{}
	plan := changePlan{sess: sess, database: database, stmts: make([]plannedStmt, 0, len(req.Changes))}
	for i, rc := range req.Changes {
		if rc.Ref.Name == "" {
			return changePlan{}, fmt.Errorf("change %d: no table given", i+1)
		}
		if rc.Ref.Database != database {
			return changePlan{}, fmt.Errorf("change %d: %s is in database %q but the change set is on %q; one change set stays in one database",
				i+1, qualify(rc.Ref), rc.Ref.Database, database)
		}
		tf, ok := byTable[rc.Ref]
		if !ok {
			cols, err := s.ListColumns(ctx, req.ConnectionID, rc.Ref)
			if err != nil {
				return changePlan{}, fmt.Errorf("change %d: reading columns of %s: %w", i+1, qualify(rc.Ref), err)
			}
			tf = tableFacts{cols: cols, facts: s.editFacts(ctx, sess, req.ConnectionID, rc.Ref, cols)}
			byTable[rc.Ref] = tf
		}
		if tf.facts.ReadOnlyReason != "" {
			return changePlan{}, fmt.Errorf("change %d: %s cannot be edited: %s", i+1, qualify(rc.Ref), tf.facts.ReadOnlyReason)
		}

		ch, err := toDriverChange(tf.cols, tf.facts, rc)
		if err != nil {
			return changePlan{}, fmt.Errorf("change %d: %w", i+1, err)
		}
		st, err := sess.Driver.BuildChange(rc.Ref, ch)
		if err != nil {
			return changePlan{}, fmt.Errorf("change %d: %w", i+1, err)
		}
		plan.stmts = append(plan.stmts, plannedStmt{built: st, info: Statement{
			SQL: st.SQL, Display: st.Display, Short: st.Short,
			Table: qualify(rc.Ref), Cells: statementCells(ch, rc),
		}})
	}
	plan.tables = len(byTable)
	return plan, nil
}

// statementCells describes the set columns in the order the statement has them.
func statementCells(ch driver.Change, rc RowChange) []StatementCell {
	cells := make([]StatementCell, 0, len(ch.Set))
	for _, a := range ch.Set {
		cv := rc.Set[a.Column]
		cell := StatementCell{Column: a.Column, Kind: cv.Kind}
		switch cv.Kind {
		case "value":
			cell.Chars = utf8.RuneCountInString(cv.Value)
		case "json":
			cell.Edits = len(cv.Edits)
			for _, e := range cv.Edits {
				cell.Chars += utf8.RuneCountInString(e.Value)
			}
		}
		cells = append(cells, cell)
	}
	return cells
}

// toDriverChange checks one RowChange against the table and coerces its values.
// Keys come out in EditKey order and assignments in column order, so the same
// request always renders the same statement.
func toDriverChange(cols []driver.Column, facts driver.EditFacts, rc RowChange) (driver.Change, error) {
	ch := driver.Change{Op: driver.ChangeOp(rc.Op)}
	byName := make(map[string]driver.Column, len(cols))
	for _, c := range cols {
		byName[c.Name] = c
	}

	switch ch.Op {
	case driver.ChangeUpdate, driver.ChangeDelete:
		key, err := coerceKey(byName, facts.EditKey, rc.Key)
		if err != nil {
			return ch, err
		}
		ch.Key = key
	case driver.ChangeInsert:
		if len(rc.Key) > 0 {
			return ch, fmt.Errorf("an insert takes no key")
		}
	default:
		return ch, fmt.Errorf("unknown op %q", rc.Op)
	}

	switch {
	case ch.Op == driver.ChangeDelete && len(rc.Set) > 0:
		return ch, fmt.Errorf("a delete takes no values")
	case ch.Op == driver.ChangeUpdate && len(rc.Set) == 0:
		return ch, fmt.Errorf("an update must change at least one column")
	}

	var unknown []string
	for name := range rc.Set {
		if _, ok := byName[name]; !ok {
			unknown = append(unknown, name)
		}
	}
	if len(unknown) > 0 {
		sort.Strings(unknown)
		return ch, fmt.Errorf("no column %q", unknown[0])
	}
	for _, c := range cols {
		cv, ok := rc.Set[c.Name]
		if !ok {
			continue
		}
		if why, ro := facts.ReadOnlyColumns[c.Name]; ro {
			return ch, fmt.Errorf("column %q is read-only: %s", c.Name, why)
		}
		if cv.Kind == "json" && ch.Op != driver.ChangeUpdate {
			return ch, fmt.Errorf("column %q: JSON edits change an existing value, so only an update can make them", c.Name)
		}
		a, err := toAssignment(c, cv)
		if err != nil {
			return ch, err
		}
		ch.Set = append(ch.Set, a)
	}
	return ch, nil
}

// coerceKey demands exactly the table's key — no more, no fewer — because a WHERE
// on some other set of columns is a WHERE that may match many rows.
func coerceKey(byName map[string]driver.Column, editKey []string, key map[string]any) ([]driver.KeyCond, error) {
	isKey := make(map[string]bool, len(editKey))
	for _, name := range editKey {
		isKey[name] = true
	}
	var extra []string
	for name := range key {
		if !isKey[name] {
			extra = append(extra, name)
		}
	}
	if len(extra) > 0 {
		sort.Strings(extra)
		return nil, fmt.Errorf("%q is not part of the key (%s)", extra[0], strings.Join(editKey, ", "))
	}

	out := make([]driver.KeyCond, 0, len(editKey))
	for _, name := range editKey {
		raw, ok := key[name]
		if !ok {
			return nil, fmt.Errorf("the key is missing %q (the key is %s)", name, strings.Join(editKey, ", "))
		}
		v, err := driver.CoerceKey(byName[name], raw)
		if err != nil {
			return nil, err
		}
		out = append(out, driver.KeyCond{Column: name, Value: v})
	}
	return out, nil
}

func toAssignment(c driver.Column, cv CellValue) (driver.Assignment, error) {
	switch cv.Kind {
	case "value":
		v, err := driver.CoerceValue(c, cv.Value)
		return driver.Assignment{Column: c.Name, Value: v}, err
	case "null":
		return driver.Assignment{Column: c.Name}, nil
	case "default":
		return driver.Assignment{Column: c.Name, Default: true}, nil
	case "json":
		edits, err := toJSONEdits(c, cv.Edits)
		return driver.Assignment{Column: c.Name, DataType: c.DataType, Edits: edits}, err
	}
	return driver.Assignment{}, fmt.Errorf("column %q: unknown value kind %q (want value, null, default or json)", c.Name, cv.Kind)
}

// toJSONEdits checks the edits' shape; what a dialect cannot express it refuses
// when building.
func toJSONEdits(c driver.Column, in []JSONEdit) ([]driver.JSONEdit, error) {
	if !driver.HoldsJSON(c) {
		return nil, fmt.Errorf("column %q is %s, which cannot hold JSON to edit by path", c.Name, c.DataType)
	}
	if len(in) == 0 {
		return nil, fmt.Errorf("column %q: no JSON edits given", c.Name)
	}
	out := make([]driver.JSONEdit, 0, len(in))
	for i, e := range in {
		de, err := toJSONEdit(e)
		if err != nil {
			return nil, fmt.Errorf("column %q, JSON edit %d: %w", c.Name, i+1, err)
		}
		out = append(out, de)
	}
	return out, nil
}

func toJSONEdit(e JSONEdit) (driver.JSONEdit, error) {
	de := driver.JSONEdit{Op: driver.JSONOp(e.Op), Value: e.Value, NewKey: e.NewKey}
	for _, raw := range e.Path {
		step, err := toPathStep(raw)
		if err != nil {
			return de, err
		}
		de.Path = append(de.Path, step)
	}
	switch de.Op {
	case driver.JSONSet, driver.JSONAppend:
		if !json.Valid([]byte(e.Value)) {
			return de, fmt.Errorf("%s: the value is not valid JSON", e.Op)
		}
	case driver.JSONRemove:
	case driver.JSONRename:
		if len(de.Path) > 0 && de.Path[len(de.Path)-1].IsIndex {
			return de, fmt.Errorf("rename: the path must end at an object key, not an array index")
		}
		if e.NewKey == "" {
			return de, fmt.Errorf("rename: no new key given")
		}
		if len(de.Path) > 0 && e.NewKey == de.Path[len(de.Path)-1].Key {
			return de, fmt.Errorf("rename: the new key is the key it already has")
		}
	default:
		return de, fmt.Errorf("unknown op %q (want set, remove, rename or append)", e.Op)
	}
	if len(de.Path) == 0 && de.Op != driver.JSONAppend {
		return de, fmt.Errorf("%s: the path is empty; to replace the whole value, send kind \"value\"", e.Op)
	}
	return de, nil
}

// toPathStep reads one step as JSON decoded it: a key is a string, an index a
// whole non-negative number (float64).
func toPathStep(raw any) (driver.PathStep, error) {
	switch v := raw.(type) {
	case string:
		return driver.PathStep{Key: v}, nil
	case float64:
		if v >= 0 && v == math.Trunc(v) && v <= math.MaxInt32 {
			return driver.PathStep{Index: int(v), IsIndex: true}, nil
		}
	case int:
		if v >= 0 {
			return driver.PathStep{Index: v, IsIndex: true}, nil
		}
	}
	return driver.PathStep{}, fmt.Errorf("path step %v is neither an object key nor an array index", raw)
}
