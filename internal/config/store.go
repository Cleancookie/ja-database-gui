// Package config persists saved connections.
//
// Connection metadata and passwords are kept in separate files so the secret
// half can be swapped for an OS keyring without touching the rest — see
// docs/adr/0003-credential-storage.md. A Connection never carries its own
// password; it refers to one by ID through a SecretStore.
package config

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/Cleancookie/ja-db/internal/driver"
)

const fileVersion = 1

// Connection is a saved connection, without its password.
type Connection struct {
	ID       string            `json:"id"`
	Name     string            `json:"name"`
	Kind     driver.Kind       `json:"kind"`
	Host     string            `json:"host,omitempty"`
	Port     int               `json:"port,omitempty"`
	User     string            `json:"user,omitempty"`
	Database string            `json:"database,omitempty"`
	File     string            `json:"file,omitempty"` // SQLite
	SSLMode  string            `json:"sslMode,omitempty"`
	Params   map[string]string `json:"params,omitempty"`
	// Colour is a UI accent, used to make production connections obvious.
	Colour    string    `json:"colour,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type connectionsFile struct {
	Version     int          `json:"version"`
	Connections []Connection `json:"connections"`
}

// Store is the on-disk connection list. Safe for concurrent use.
type Store struct {
	mu      sync.RWMutex
	path    string
	secrets SecretStore
	conns   []Connection
}

// DefaultDir is where ja-db keeps its state: %AppData%\ja-db on Windows,
// ~/.config/ja-db on Linux, ~/Library/Application Support/ja-db on macOS.
func DefaultDir() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("locating user config dir: %w", err)
	}
	return filepath.Join(base, "ja-db"), nil
}

// Open loads the store from dir, creating it if absent.
func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("creating config dir: %w", err)
	}
	secrets, err := NewFileSecrets(filepath.Join(dir, "secrets.json"))
	if err != nil {
		return nil, err
	}
	s := &Store{
		path:    filepath.Join(dir, "connections.json"),
		secrets: secrets,
	}
	if err := s.load(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Store) load() error {
	b, err := os.ReadFile(s.path)
	if os.IsNotExist(err) {
		s.conns = []Connection{}
		return nil
	}
	if err != nil {
		return fmt.Errorf("reading %s: %w", s.path, err)
	}
	var f connectionsFile
	if err := json.Unmarshal(b, &f); err != nil {
		return fmt.Errorf("parsing %s: %w", s.path, err)
	}
	s.conns = f.Connections
	if s.conns == nil {
		s.conns = []Connection{}
	}
	return nil
}

// persist must be called with the write lock held.
func (s *Store) persist() error {
	f := connectionsFile{Version: fileVersion, Connections: s.conns}
	b, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(s.path, b)
}

// List returns the saved connections, ordered by name.
func (s *Store) List() []Connection {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Connection, len(s.conns))
	copy(out, s.conns)
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// Get returns one connection by ID.
func (s *Store) Get(id string) (Connection, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, c := range s.conns {
		if c.ID == id {
			return c, nil
		}
	}
	return Connection{}, fmt.Errorf("no connection with id %q", id)
}

// Create saves a new connection and its password.
func (s *Store) Create(c Connection, password string) (Connection, error) {
	if err := validate(c); err != nil {
		return Connection{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	c.ID = newID()
	now := time.Now().UTC()
	c.CreatedAt, c.UpdatedAt = now, now
	s.conns = append(s.conns, c)

	if err := s.persist(); err != nil {
		s.conns = s.conns[:len(s.conns)-1] // keep memory consistent with disk
		return Connection{}, err
	}
	if password != "" {
		if err := s.secrets.Set(c.ID, password); err != nil {
			return c, fmt.Errorf("connection saved but password was not: %w", err)
		}
	}
	return c, nil
}

// Update replaces a connection. password is only written when non-nil, so the
// UI can save an edited connection without re-sending an unchanged password.
func (s *Store) Update(c Connection, password *string) (Connection, error) {
	if err := validate(c); err != nil {
		return Connection{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	idx := -1
	for i, existing := range s.conns {
		if existing.ID == c.ID {
			idx = i
			break
		}
	}
	if idx < 0 {
		return Connection{}, fmt.Errorf("no connection with id %q", c.ID)
	}

	prev := s.conns[idx]
	c.CreatedAt = prev.CreatedAt
	c.UpdatedAt = time.Now().UTC()
	s.conns[idx] = c

	if err := s.persist(); err != nil {
		s.conns[idx] = prev
		return Connection{}, err
	}
	if password != nil {
		if err := s.secrets.Set(c.ID, *password); err != nil {
			return c, fmt.Errorf("connection saved but password was not: %w", err)
		}
	}
	return c, nil
}

// Delete removes a connection and its password.
func (s *Store) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	idx := -1
	for i, c := range s.conns {
		if c.ID == id {
			idx = i
			break
		}
	}
	if idx < 0 {
		return fmt.Errorf("no connection with id %q", id)
	}

	prev := s.conns
	s.conns = append(append([]Connection{}, s.conns[:idx]...), s.conns[idx+1:]...)
	if err := s.persist(); err != nil {
		s.conns = prev
		return err
	}
	// A leftover secret is harmless but is still a credential on disk, so a
	// failure here is reported rather than swallowed.
	return s.secrets.Delete(id)
}

// Password returns the stored password for a connection, or "" if none.
func (s *Store) Password(id string) (string, error) {
	return s.secrets.Get(id)
}

// DriverConfig assembles the full connection config, password included, ready
// to hand to a driver.
func (s *Store) DriverConfig(id string) (driver.ConnConfig, error) {
	c, err := s.Get(id)
	if err != nil {
		return driver.ConnConfig{}, err
	}
	pw, err := s.Password(id)
	if err != nil {
		return driver.ConnConfig{}, err
	}
	return driver.ConnConfig{
		Kind:     c.Kind,
		Host:     c.Host,
		Port:     c.Port,
		User:     c.User,
		Password: pw,
		Database: c.Database,
		File:     c.File,
		SSLMode:  c.SSLMode,
		Params:   c.Params,
	}, nil
}

func validate(c Connection) error {
	if c.Name == "" {
		return fmt.Errorf("connection needs a name")
	}
	d, err := driver.Get(c.Kind)
	if err != nil {
		return err
	}
	if c.Kind == driver.KindSQLite {
		if c.File == "" {
			return fmt.Errorf("SQLite connections need a database file")
		}
		return nil
	}
	if c.Host == "" {
		return fmt.Errorf("%s connections need a host", d.Caps().DisplayName)
	}
	return nil
}

func newID() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand failing is unrecoverable and not worth a nil-able ID.
		panic(fmt.Sprintf("ja-db: crypto/rand unavailable: %v", err))
	}
	return hex.EncodeToString(b)
}

// writeFileAtomic writes via a temp file in the same directory then renames,
// so an interrupted write cannot leave a truncated connections list behind.
func writeFileAtomic(path string, b []byte) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op once the rename has succeeded

	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}
