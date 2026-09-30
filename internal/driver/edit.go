package driver

import "fmt"

// EditFacts is what the catalogue says about a relation that decides whether its
// rows can be edited in the grid, and by which key.
//
// It is separate from ListColumns on purpose. The row browser runs ListColumns on
// every page and keeps it to one cheap query; these facts need the index catalogue
// and, on some dialects, the generated-column flag that only DescribeObject reads.
// Callers cache it the way they cache columns (see api.columnCache).
//
// Each dialect only gathers the raw rows. The policy — which key wins, which
// columns are read-only — is newEditFacts, once.
type EditFacts struct {
	// EditKey is the columns that identify one row, in key order: the primary
	// key, else the first unique index whose columns are all NOT NULL. Empty
	// means no row can be addressed, and ReadOnlyReason says so.
	EditKey []string `json:"editKey"`
	// ReadOnlyReason is why no row of this relation can be edited, in words for
	// the person looking at the grid. Empty when the relation is editable.
	ReadOnlyReason string `json:"readOnlyReason"`
	// ReadOnlyColumns maps a column that cannot be written to the reason. Empty
	// on a relation that is read-only as a whole: that has one reason, above.
	ReadOnlyColumns map[string]string `json:"readOnlyColumns"`
}

// Reasons shared by every dialect, so the same situation reads the same way.
const (
	reasonView     = "views cannot be edited"
	reasonNoKey    = "no primary key, and no unique index on NOT NULL columns, to identify a row by"
	reasonNotFound = "the table's columns could not be read"
	reasonBinary   = "binary values are shown as a hex preview, so they cannot be edited here"
	reasonComputed = "generated column"
)

// newEditFacts applies the editing policy to what a dialect found. cols must come
// from the dialect's describeColumns, since only that fills Column.Generated.
func newEditFacts(cols []Column, indexes []Index, view bool) EditFacts {
	f := EditFacts{EditKey: []string{}, ReadOnlyColumns: map[string]string{}}

	switch {
	case view:
		f.ReadOnlyReason = reasonView
		return f
	case len(cols) == 0:
		f.ReadOnlyReason = reasonNotFound
		return f
	}

	f.EditKey = chooseEditKey(cols, indexes)
	if len(f.EditKey) == 0 {
		f.ReadOnlyReason = reasonNoKey
		return f
	}

	for _, c := range cols {
		base, _, _ := splitTypeArg(c.DataType)
		switch {
		case c.Generated:
			f.ReadOnlyColumns[c.Name] = reasonComputed
		case isBinaryType(base):
			// The wire value of a blob is a lossy hex preview (see scan.go), so a
			// save would write the preview's text over the real bytes.
			f.ReadOnlyColumns[c.Name] = reasonBinary
		}
	}
	return f
}

// markReadOnly records a dialect-specific column the policy above cannot know
// about, such as a SQL Server identity or rowversion column.
func (f *EditFacts) markReadOnly(column, reason string) {
	if f.ReadOnlyColumns == nil {
		f.ReadOnlyColumns = map[string]string{}
	}
	if _, already := f.ReadOnlyColumns[column]; !already {
		f.ReadOnlyColumns[column] = reason
	}
}

// chooseEditKey picks the primary key when there is one. Failing that it takes
// the first unique index that can stand in for one: complete (no expression and
// no WHERE clause, either of which makes uniqueness partial) and with every
// column NOT NULL, since a NULL never compares equal and a row with one in its
// key could not be found again to update.
func chooseEditKey(cols []Column, indexes []Index) []string {
	if pk := primaryKeyOf(indexes, cols); len(pk) > 0 {
		return append([]string{}, pk...)
	}
	notNull := make(map[string]bool, len(cols))
	for _, c := range cols {
		notNull[c.Name] = !c.Nullable
	}
	for _, ix := range indexes {
		if !ix.Unique || ix.partial || len(ix.Columns) == 0 {
			continue
		}
		usable := true
		for _, c := range ix.Columns {
			if !notNull[c] {
				usable = false
				break
			}
		}
		if usable {
			return append([]string{}, ix.Columns...)
		}
	}
	return nil
}

// gatherEditFacts is the shared shape of every dialect's EditFacts: the same
// three questions, each answered by the dialect's own catalogue query.
func gatherEditFacts(
	columns func() ([]Column, error),
	indexes func() ([]Index, error),
	isView func() (bool, error),
) (EditFacts, []Column, error) {
	cols, err := columns()
	if err != nil {
		return EditFacts{}, nil, fmt.Errorf("reading columns: %w", err)
	}
	idx, err := indexes()
	if err != nil {
		return EditFacts{}, nil, fmt.Errorf("reading indexes: %w", err)
	}
	view, err := isView()
	if err != nil {
		return EditFacts{}, nil, fmt.Errorf("reading object type: %w", err)
	}
	return newEditFacts(cols, idx, view), cols, nil
}

// Clone copies the slice and map, so a cached value cannot be altered through one
// that was handed out.
func (f EditFacts) Clone() EditFacts {
	out := f
	out.EditKey = append([]string{}, f.EditKey...)
	out.ReadOnlyColumns = make(map[string]string, len(f.ReadOnlyColumns))
	for k, v := range f.ReadOnlyColumns {
		out.ReadOnlyColumns[k] = v
	}
	return out
}
