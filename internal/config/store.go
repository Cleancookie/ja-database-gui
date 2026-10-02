// Package config persists saved connections.
//
// Connection metadata and passwords are kept in separate files so the secret
// half can be swapped for an OS keyring without touching the rest — see
// docs/adr/0007-credential-storage.md. A Connection never carries its own
// password; it refers to one by ID through a SecretStore.
package config

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
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
	backend BackendInfo
	// legacy holds secrets.json entries a migration could not move. It is read
	// as a fallback and never written, so the keyring stays the one place a
	// saved password goes.
	legacy *FileSecrets
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

// Open loads the store from dir, creating it if absent. Passwords go to the OS
// keyring when one works; see OpenWith for what happens when it does not.
func Open(dir string) (*Store, error) {
	if err := ProbeKeyring(); err != nil {
		return OpenWith(dir, nil, err)
	}
	return OpenWith(dir, KeyringSecrets{}, nil)
}

// OpenWith is Open with the keyring chosen by the caller. A nil kr means none
// is usable and keyringErr says why.
//
// With no keyring, passwords fall back to the plaintext secrets.json — unless
// this directory has used a keyring before, in which case the passwords it
// holds would silently stop being found. That case refuses to read or write
// passwords at all rather than split them across two places.
func OpenWith(dir string, kr SecretStore, keyringErr error) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("creating config dir: %w", err)
	}
	if err := tightenDir(dir); err != nil {
		return nil, fmt.Errorf("securing config dir: %w", err)
	}
	s := &Store{path: filepath.Join(dir, "connections.json")}
	secretsPath := filepath.Join(dir, "secrets.json")
	marker := filepath.Join(dir, keyringMarker)

	switch {
	case kr != nil:
		s.secrets = kr
		s.backend = BackendInfo{Kind: BackendKeyring}
		if err := os.WriteFile(marker, nil, 0o600); err != nil {
			return nil, fmt.Errorf("recording keyring use: %w", err)
		}
		s.legacy = migrateFileSecrets(secretsPath, kr)
	case fileExists(marker):
		s.secrets = unavailableSecrets{err: keyringErr}
		s.backend = BackendInfo{Kind: BackendUnavailable, Reason: reasonOf(keyringErr)}
		log.Printf("ja-db: WARNING the OS keyring is unavailable (%s) but earlier passwords are stored in it; "+
			"passwords cannot be read or saved until it is back", reasonOf(keyringErr))
	default:
		f, err := NewFileSecrets(secretsPath)
		if err != nil {
			return nil, err
		}
		s.secrets = f
		s.backend = BackendInfo{Kind: BackendFile, Reason: reasonOf(keyringErr)}
		log.Printf("ja-db: WARNING no OS keyring (%s); saved passwords are stored in PLAINTEXT in %s", reasonOf(keyringErr), secretsPath)
	}
	if err := s.load(); err != nil {
		return nil, err
	}
	return s, nil
}

func reasonOf(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// Backend says where passwords are kept, for the UI to show.
func (s *Store) Backend() BackendInfo { return s.backend }

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
	if s.legacy != nil {
		_ = s.legacy.Delete(id)
	}
	return s.secrets.Delete(id)
}

// setSecret writes to the keyring and then drops any stale legacy copy, so a
// later migration retry cannot overwrite the new password with the old one.
func (s *Store) setSecret(id, password string) error {
	if err := s.secrets.Set(id, password); err != nil {
		return err
	}
	if s.legacy != nil {
		_ = s.legacy.Delete(id)
	}
	return nil
}

// Password returns the stored password for a connection, or "" if none.
func (s *Store) Password(id string) (string, error) {
	pw, err := s.secrets.Get(id)
	if err != nil || pw != "" || s.legacy == nil {
		return pw, err
	}
	return s.legacy.Get(id)
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
