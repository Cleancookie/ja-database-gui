package api

import (
	"testing"

	"github.com/Cleancookie/ja-db/internal/driver"
)

func TestOpenSampleReusesConnection(t *testing.T) {
	s := newService(t, t.TempDir())
	a, err := s.OpenSample()
	if err != nil {
		t.Fatal(err)
	}
	b, err := s.OpenSample()
	if err != nil {
		t.Fatal(err)
	}
	if a.ID != b.ID {
		t.Errorf("second call made a new connection: %s vs %s", a.ID, b.ID)
	}
	if n := len(s.ListConnections()); n != 1 {
		t.Errorf("%d connections saved, want 1", n)
	}
}

func TestSampleConnectsAndResets(t *testing.T) {
	s := newService(t, t.TempDir())
	c, err := s.OpenSample()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Connect(t.Context(), ConnectRequest{ConnectionID: c.ID}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RunSQL(t.Context(), RunSQLRequest{ConnectionID: c.ID, SQL: "DELETE FROM audit_log"}); err != nil {
		t.Fatal(err)
	}
	r, err := s.ResetSample()
	if err != nil {
		t.Fatal(err)
	}
	if r.ID != c.ID || len(s.ListConnections()) != 1 {
		t.Errorf("reset changed the saved connections")
	}
	if len(s.ConnectedIDs()) != 0 {
		t.Errorf("reset left sessions open")
	}
	if _, err := s.Connect(t.Context(), ConnectRequest{ConnectionID: c.ID}); err != nil {
		t.Fatal(err)
	}
	res, err := s.CountRows(t.Context(), CountRowsRequest{ConnectionID: c.ID, Ref: driver.ObjectRef{Database: "main", Name: "audit_log"}})
	if err != nil || res != 40 {
		t.Errorf("audit_log count = %d, err %v; want 40", res, err)
	}
}
