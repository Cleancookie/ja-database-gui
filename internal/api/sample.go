package api

import (
	"fmt"

	"github.com/Cleancookie/ja-db/internal/config"
	"github.com/Cleancookie/ja-db/internal/driver"
	"github.com/Cleancookie/ja-db/internal/sample"
)

// OpenSample makes sure the sample database file and its saved connection
// exist, and returns the connection for the UI to connect with the normal
// Connect call. An existing file is reused untouched. Takes no path: the only
// file involved is the fixed sample file in the config directory.
func (s *Service) OpenSample() (config.Connection, error) {
	s.sampleMu.Lock()
	defer s.sampleMu.Unlock()
	path, err := sample.Ensure(s.store.Dir())
	if err != nil {
		return config.Connection{}, err
	}
	return s.sampleConnection(path)
}

// ResetSample rebuilds the sample database from its seed, discarding any edits.
// The UI asks for confirmation first. Open sessions on it are closed so the
// file is not replaced underneath a live pool.
func (s *Service) ResetSample() (config.Connection, error) {
	s.sampleMu.Lock()
	defer s.sampleMu.Unlock()
	dir := s.store.Dir()
	if c, ok := s.findSampleConnection(sample.Path(dir)); ok {
		s.Disconnect(c.ID)
	}
	path, err := sample.Reset(dir)
	if err != nil {
		return config.Connection{}, err
	}
	return s.sampleConnection(path)
}

func (s *Service) findSampleConnection(path string) (config.Connection, bool) {
	for _, c := range s.store.List() {
		if c.Kind == driver.KindSQLite && c.File == path {
			return c, true
		}
	}
	return config.Connection{}, false
}

func (s *Service) sampleConnection(path string) (config.Connection, error) {
	if c, ok := s.findSampleConnection(path); ok {
		return c, nil
	}
	c, err := s.store.Create(config.Connection{
		Name: sample.ConnectionName,
		Kind: driver.KindSQLite,
		File: path,
	}, "")
	if err != nil {
		return config.Connection{}, fmt.Errorf("saving sample connection: %w", err)
	}
	return c, nil
}
