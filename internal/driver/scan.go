package driver

import (
	"context"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Cleancookie/ja-db/internal/activity"
)

// HardRowCap bounds any single result set, including when the user has turned
// pagination off. Without it, "no LIMIT" on a large table would try to
// materialise the whole thing in memory and take the app down.
const HardRowCap = 100_000

// maxSafeInteger is JavaScript's Number.MAX_SAFE_INTEGER. Integers beyond it
// cannot survive a JSON round-trip into the webview intact, so they are sent
// as strings instead — silently corrupting a bigint primary key would be a
// serious bug in a tool people use to look up records by id.
const maxSafeInteger = int64(1)<<53 - 1

// binaryPreviewBytes caps how much of a blob is hex-encoded for display.
const binaryPreviewBytes = 32

// MaxCellBytes bounds a single full-value fetch. The point of that call is to
// hand over the whole cell, but "whole" has to stop somewhere short of a
// gigabyte or fetching one row takes the app down.
const MaxCellBytes = 8 << 20

// QueryOptions bounds what one query is allowed to bring back.
type QueryOptions struct {
	// RowCap bounds the number of rows; 0 means HardRowCap.
	RowCap int
	// TextCap bounds the characters kept from any string value; 0 disables it.
	//
	// A row browse has already asked the server for TextCap+1 characters of
	// each long column (see selectList), so here that normally only removes
	// the sentinel character and records that the cell was cut. It is applied
	// on this side as well because two cases have no server-side cap: ad-hoc
	// SQL from the editor, whose select list we must not rewrite, and tables
	// whose column metadata could not be read.
	TextCap int
}

// rowReportInterval is how often the row counter shown in the activity tray is
// updated while streaming.
const rowReportInterval = 512

// MaxResultSets bounds how many result sets one batch may hand back. A
// `WHILE` loop with a SELECT in it can emit them without end, and each one is
// only row-capped, not free.
const MaxResultSets = 32

// RunQuery executes a query and normalises the result into a JSON-safe
// ResultSet. A batch that produces several is not what this call is for — see
// RunQueryAll — and only the first is read.
func RunQuery(ctx context.Context, db *sql.DB, query string, opts QueryOptions) (*ResultSet, error) {
	start := time.Now()

	// Phase reporting for the activity tray. QueryContext covers both the wait
	// for a pooled connection and the server's own work, so "executing" is
	// exactly "we are waiting on the database"; everything after it is us.
	activity.SetPhase(ctx, activity.PhaseExecuting)
	rows, err := db.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	activity.SetPhase(ctx, activity.PhaseReading)

	out, err := scanResultSet(ctx, rows, query, opts)
	if err != nil {
		return nil, err
	}
	out.ElapsedMS = time.Since(start).Milliseconds()
	return out, nil
}

// RunQueryAll executes a batch — one or many statements in one round trip, on
// one connection — and returns every result set it produced, in order.
//
// One round trip and not one per statement: `use other_db; select …` only
// means anything if both halves land on the same session, and splitting the
// text here would hand the second half to whatever connection the pool
// happened to be holding.
//
// Result sets with no columns are dropped. Every statement in a batch reports
// one, so keeping them would put an empty tab in front of the user for the
// `use` they wrote as setup. more is true when the batch produced more than
// MaxResultSets and reading stopped early.
func RunQueryAll(ctx context.Context, db *sql.DB, query string, opts QueryOptions) (sets []*ResultSet, more bool, err error) {
	start := time.Now()

	activity.SetPhase(ctx, activity.PhaseExecuting)
	rows, err := db.QueryContext(ctx, query)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	activity.SetPhase(ctx, activity.PhaseReading)

	for {
		rs, err := scanResultSet(ctx, rows, query, opts)
		if err != nil {
			return nil, false, err
		}
		if len(rs.Columns) > 0 {
			sets = append(sets, rs)
		}
		if len(sets) >= MaxResultSets {
			more = true
			break
		}
		if !rows.NextResultSet() {
			break
		}
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}

	// One elapsed time, stamped on each: the batch was one round trip and the
	// per-statement split is not something the client can be told honestly.
	elapsed := time.Since(start).Milliseconds()
	for _, rs := range sets {
		rs.ElapsedMS = elapsed
	}
	return sets, more, nil
}

// scanResultSet reads the result set rows is currently positioned on. It does
// not advance to the next one — that is the caller's business.
func scanResultSet(ctx context.Context, rows *sql.Rows, query string, opts QueryOptions) (*ResultSet, error) {
	rowCap := opts.RowCap
	if rowCap <= 0 || rowCap > HardRowCap {
		rowCap = HardRowCap
	}

	colTypes, err := rows.ColumnTypes()
	if err != nil {
		return nil, err
	}
	cols := make([]ResultColumn, len(colTypes))
	for i, ct := range colTypes {
		cols[i] = ResultColumn{Name: ct.Name(), DBType: ct.DatabaseTypeName()}
	}

	out := &ResultSet{
		Columns:        cols,
		Rows:           [][]any{},
		Query:          query,
		TextCap:        opts.TextCap,
		TruncatedCells: []CellRef{},
	}

	vals := make([]any, len(cols))
	ptrs := make([]any, len(cols))
	for i := range vals {
		ptrs[i] = &vals[i]
	}

	for rows.Next() {
		if len(out.Rows) >= rowCap {
			out.Truncated = true
			break
		}
		if err := rows.Scan(ptrs...); err != nil {
			return nil, err
		}
		row := make([]any, len(cols))
		for i, v := range vals {
			row[i] = normalise(v, cols[i].DBType)
			if opts.TextCap <= 0 {
				continue
			}
			if s, ok := row[i].(string); ok {
				if cut, was := capString(s, opts.TextCap); was {
					row[i] = cut
					out.TruncatedCells = append(out.TruncatedCells,
						CellRef{Row: len(out.Rows), Col: i})
				}
			}
		}
		out.Rows = append(out.Rows, row)
		// Reported in batches: the tray redraws a few times a second, so a
		// context lookup per row would buy nothing.
		if len(out.Rows)%rowReportInterval == 0 {
			activity.AddRows(ctx, rowReportInterval)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	activity.AddRows(ctx, int64(len(out.Rows)%rowReportInterval))
	return out, nil
}

// Exec runs a statement that returns no rows and reports the affected count.
func Exec(ctx context.Context, db *sql.DB, query string) (*ResultSet, error) {
	start := time.Now()
	// A statement that returns no rows has only the one phase worth showing.
	activity.SetPhase(ctx, activity.PhaseExecuting)
	res, err := db.ExecContext(ctx, query)
	if err != nil {
		return nil, err
	}
	out := &ResultSet{
		Columns:        []ResultColumn{},
		Rows:           [][]any{},
		TruncatedCells: []CellRef{},
		Query:          query,
		ElapsedMS:      time.Since(start).Milliseconds(),
	}
	// Not every driver supports RowsAffected; absence is not an error.
	if n, err := res.RowsAffected(); err == nil {
		out.RowsAffected = &n
	}
	return out, nil
}

// Cell is one value read on its own, for the "show me the whole thing" path
// behind a truncated grid cell.
type Cell struct {
	// Value is nil for NULL, which must stay distinguishable from "".
	Value *string `json:"value"`
	// Bytes is the size the value had in the database, before any trimming
	// here, so the viewer can say how big the thing actually is.
	Bytes int `json:"bytes"`
	// Truncated is true when even this fetch had to stop — see MaxCellBytes.
	Truncated bool   `json:"truncated"`
	Query     string `json:"query"`
}

// ReadCell runs a query expected to yield exactly one value and returns it
// whole, subject to maxBytes. maxBytes of 0 uses MaxCellBytes.
func ReadCell(ctx context.Context, db *sql.DB, query string, maxBytes int) (*Cell, error) {
	if maxBytes <= 0 || maxBytes > MaxCellBytes {
		maxBytes = MaxCellBytes
	}
	out := &Cell{Query: query}

	var v any
	if err := db.QueryRowContext(ctx, query).Scan(&v); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			// The row moved or was deleted between the page load and the
			// click. Saying so beats a bare "no rows in result set".
			return nil, fmt.Errorf("that row is no longer in the result — refresh and try again")
		}
		return nil, err
	}

	// Normalising here means a full-value fetch shows a decimal, a timestamp
	// or a blob exactly as the grid does, only untruncated.
	n := normalise(v, "")
	if n == nil {
		return out, nil
	}
	s, ok := n.(string)
	if !ok {
		s = fmt.Sprintf("%v", n)
	}
	out.Bytes = len(s)
	if b, isBytes := v.([]byte); isBytes {
		// A blob is reported as a hex preview, so the preview's length is not
		// the value's length; the raw byte count is.
		out.Bytes = len(b)
	}
	if len(s) > maxBytes {
		s = truncateBytes(s, maxBytes)
		out.Truncated = true
	}
	out.Value = &s
	return out, nil
}

// capString cuts s to n characters, reporting whether anything was removed.
// Counting runes rather than bytes keeps the cap from splitting a multi-byte
// character in half, which renders as a replacement glyph in the grid.
func capString(s string, n int) (string, bool) {
	// A string of n bytes can hold at most n runes, so this is a cheap and
	// exact "definitely short enough" test.
	if len(s) <= n {
		return s, false
	}
	count := 0
	for i := range s {
		if count == n {
			return s[:i], true
		}
		count++
	}
	return s, false
}

// truncateBytes cuts s to at most max bytes, backing off to a rune boundary.
// Byte-bounded rather than rune-bounded because this one guards memory.
func truncateBytes(s string, max int) string {
	if len(s) <= max {
		return s
	}
	for max > 0 && !utf8.RuneStart(s[max]) {
		max--
	}
	return s[:max]
}

// normalise converts a driver value into something that survives JSON and
// renders sensibly in a grid. The set of possible outputs is deliberately
// small: nil, string, float64, int64-within-safe-range, bool.
func normalise(v any, dbType string) any {
	switch t := v.(type) {
	case nil:
		return nil
	case bool:
		return t
	case string:
		return t
	case time.Time:
		// RFC3339 with nanoseconds sorts lexically and round-trips. Dates
		// without a time component still render usefully.
		return t.Format(time.RFC3339Nano)
	case int64:
		if t > maxSafeInteger || t < -maxSafeInteger {
			return fmt.Sprintf("%d", t)
		}
		return t
	case int32:
		return int64(t)
	case int:
		return int64(t)
	case float64:
		// NaN and ±Inf are not representable in JSON; marshalling them errors
		// out and would fail the whole page.
		if math.IsNaN(t) || math.IsInf(t, 0) {
			return fmt.Sprintf("%v", t)
		}
		return t
	case float32:
		return normalise(float64(t), dbType)
	case []byte:
		return normaliseBytes(t, dbType)
	default:
		return fmt.Sprintf("%v", t)
	}
}

// normaliseBytes decides whether a []byte is text or binary. Most drivers
// hand back []byte for text, numeric and decimal columns alike; decimals in
// particular must stay strings so precision is not lost to float64.
func normaliseBytes(b []byte, dbType string) any {
	if isBinaryType(dbType) || !utf8.Valid(b) || containsNUL(b) {
		n := len(b)
		preview := b
		if n > binaryPreviewBytes {
			preview = b[:binaryPreviewBytes]
		}
		s := "0x" + hex.EncodeToString(preview)
		if n > binaryPreviewBytes {
			s += "…"
		}
		return fmt.Sprintf("%s (%d bytes)", s, n)
	}
	return string(b)
}

func containsNUL(b []byte) bool {
	for _, c := range b {
		if c == 0 {
			return true
		}
	}
	return false
}

// isBinaryType catches types that are valid UTF-8 by luck but are not text.
func isBinaryType(dbType string) bool {
	switch strings.ToUpper(dbType) {
	case "BLOB", "BYTEA", "BINARY", "VARBINARY", "IMAGE", "TINYBLOB",
		"MEDIUMBLOB", "LONGBLOB", "GEOMETRY", "ROWVERSION", "TIMESTAMP_BYTES":
		return true
	}
	return false
}

// scanStrings is a small helper for the introspection queries, which all
// return a handful of text columns.
func scanStrings(rows *sql.Rows, n int) ([][]string, error) {
	defer rows.Close()
	var out [][]string
	for rows.Next() {
		cells := make([]sql.NullString, n)
		ptrs := make([]any, n)
		for i := range cells {
			ptrs[i] = &cells[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return nil, err
		}
		row := make([]string, n)
		for i, c := range cells {
			row[i] = c.String
		}
		out = append(out, row)
	}
	return out, rows.Err()
}
