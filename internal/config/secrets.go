package config

import (
	"encoding/json"
	"fmt"
	"os"
	"sync"
)

// SecretStore holds connection passwords, keyed by connection ID.
//
// KeyringSecrets is the default implementation and FileSecrets the fallback.
// Swapping one for the other needs no change anywhere
// else, because nothing outside this package ever holds a password by value
// for longer than a single call.
type SecretStore interface {
	Get(ref string) (string, error)
	Set(ref, secret string) error
	Delete(ref string) error
}

// FileSecrets keeps passwords in a mode-0600 JSON file. This is plaintext on
// disk and is a known, documented gap, used only when no OS keyring works — see
// docs/adr/0007-credential-storage.md.
type FileSecrets struct {
	mu     sync.RWMutex
	path   string
	values map[string]string
}

var _ SecretStore = (*FileSecrets)(nil)

func NewFileSecrets(path string) (*FileSecrets, error) {
	f := &FileSecrets{path: path, values: map[string]string{}}
	b, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return f, nil
	}
	if err != nil {
		return nil, fmt.Errorf("reading secrets: %w", err)
	}
	if err := json.Unmarshal(b, &f.values); err != nil {
		return nil, fmt.Errorf("parsing secrets: %w", err)
	}
	if f.values == nil {
		f.values = map[string]string{}
	}
	return f, nil
}

func (f *FileSecrets) Get(ref string) (string, error) {
	f.mu.RLock()
	defer f.mu.RUnlock()
	return f.values[ref], nil
}

func (f *FileSecrets) Set(ref, secret string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	prev, existed := f.values[ref]
	f.values[ref] = secret
	if err := f.persist(); err != nil {
		if existed {
			f.values[ref] = prev
		} else {
			delete(f.values, ref)
		}
		return err
	}
	return nil
}

func (f *FileSecrets) Delete(ref string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	prev, existed := f.values[ref]
	if !existed {
		return nil
	}
	delete(f.values, ref)
	if err := f.persist(); err != nil {
		f.values[ref] = prev
		return err
	}
	return nil
}

// persist must be called with the write lock held.
func (f *FileSecrets) persist() error {
	b, err := json.MarshalIndent(f.values, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(f.path, b)
}
