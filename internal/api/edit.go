package api

import (
	"context"
	"fmt"
	"log"

	"github.com/Cleancookie/ja-db/internal/activity"
	"github.com/Cleancookie/ja-db/internal/driver"
	"github.com/Cleancookie/ja-db/internal/engine"
	"github.com/Cleancookie/ja-db/internal/query"
)

// --- what can be edited ------------------------------------------------------------

// GridColumn is a column as the grid receives it: the catalogue's description,
// plus whether a cell in it can be written. The embedded Column flattens in JSON,
// so a consumer that only knows Column keeps working.
type GridColumn struct {
	driver.Column
	// Editable is false for every column of a read-only table, and for the
	// columns of an editable one that cannot be written: generated, binary,
	// identity, rowversion.
	Editable bool `json:"editable"`
	// ReadOnlyReason says why, for a tooltip. Empty when Editable.
	ReadOnlyReason string `json:"readOnlyReason,omitempty"`
}

func gridColumns(cols []driver.Column, facts driver.EditFacts) []GridColumn {
	out := make([]GridColumn, 0, len(cols))
	for _, c := range cols {
		g := GridColumn{Column: c, Editable: true}
		switch reason, ro := facts.ReadOnlyColumns[c.Name]; {
		case facts.ReadOnlyReason != "":
			g.Editable, g.ReadOnlyReason = false, facts.ReadOnlyReason
		case ro:
			g.Editable, g.ReadOnlyReason = false, reason
		}
		out = append(out, g)
	}
	return out
}

// editFacts answers "can these rows be edited, and by which key" for a table,
// from the cache when it has a live entry.
//
// It never fails: a relation whose key cannot be worked out is simply read-only,
// with the reason, and stays browsable. A failed lookup is not cached, so the next
// read tries again.
func (s *Service) editFacts(ctx context.Context, sess *engine.Session, connID string, ref driver.ObjectRef, cols []driver.Column) driver.EditFacts {
	if len(cols) == 0 {
		return readOnlyFacts("column metadata is not available for this object")
	}
	if cached, ok := s.columns.getFacts(connID, ref); ok {
		return cached
	}

	var facts driver.EditFacts
	if err := s.runner.Do(ctx, query.Op{
		ConnectionID: connID,
		Database:     ref.Database,
		Kind:         activity.KindIntrospect,
		SQL:          "edit facts " + qualify(ref),
	}, func(qctx context.Context) error {
		var err error
		facts, err = sess.Driver.EditFacts(qctx, sess.DB, ref)
		return err
	}); err != nil {
		log.Printf("edit facts for %s: %s", logText(qualify(ref)), logErr(err))
		return readOnlyFacts(fmt.Sprintf("could not work out how to identify a row: %v", err))
	}
	s.columns.putFacts(connID, ref, facts)
	return facts
}

func readOnlyFacts(reason string) driver.EditFacts {
	return driver.EditFacts{EditKey: []string{}, ReadOnlyReason: reason, ReadOnlyColumns: map[string]string{}}
}
