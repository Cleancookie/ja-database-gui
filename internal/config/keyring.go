package config

import (
	"errors"
	"fmt"

	"github.com/zalando/go-keyring"
)

// keyringService is the service name every ja-db credential is filed under.
// The account is the connection ID. Windows Credential Manager shows these as
// "ja-db:<id>".
const keyringService = "ja-db"

const keyringProbeAccount = "ja-db-probe"

// Backend names where passwords live. The UI shows it, so the strings are API.
type Backend string

const (
	// BackendKeyring is the OS credential store.
	BackendKeyring Backend = "keyring"
	// BackendFile is the plaintext secrets.json fallback.
	BackendFile Backend = "file"
	// BackendUnavailable means a keyring was used before and is not answering
	// now. Nothing is stored or read, and nothing falls back to a file.
	BackendUnavailable Backend = "unavailable"
)

// keyringMarker is dropped in the config dir the first time the keyring works.
// Its presence is what stops a later keyring outage falling back to plaintext.
const keyringMarker = ".keyring-in-use"

// BackendInfo is what the UI needs to tell the user how safe their passwords
// are. Reason is why the keyring was not used, when it was not.
type BackendInfo struct {
	Kind   Backend `json:"kind"`
	Reason string  `json:"reason,omitempty"`
}

// unavailableSecrets fails every call, loudly, instead of guessing.
type unavailableSecrets struct{ err error }

func (u unavailableSecrets) fail() error {
	return fmt.Errorf("the OS keyring is unavailable and holds this app's passwords: %v", u.err)
}
func (u unavailableSecrets) Get(string) (string, error) { return "", u.fail() }
func (u unavailableSecrets) Set(_, _ string) error      { return u.fail() }
func (u unavailableSecrets) Delete(string) error        { return u.fail() }

// KeyringSecrets keeps passwords in the OS credential store: Windows
// Credential Manager, macOS Keychain or the Linux Secret Service.
type KeyringSecrets struct{}

var _ SecretStore = KeyringSecrets{}

func (KeyringSecrets) Get(ref string) (string, error) {
	v, err := keyring.Get(keyringService, ref)
	if errors.Is(err, keyring.ErrNotFound) {
		return "", nil
	}
	return v, err
}

func (KeyringSecrets) Set(ref, secret string) error {
	return keyring.Set(keyringService, ref, secret)
}

func (KeyringSecrets) Delete(ref string) error {
	err := keyring.Delete(keyringService, ref)
	if errors.Is(err, keyring.ErrNotFound) {
		return nil
	}
	return err
}

// ProbeKeyring reports whether the OS credential store can be written and read
// back. A missing or locked Secret Service fails here, once, at startup — not
// on the first save.
func ProbeKeyring() error {
	const want = "probe"
	if err := keyring.Set(keyringService, keyringProbeAccount, want); err != nil {
		return err
	}
	got, err := keyring.Get(keyringService, keyringProbeAccount)
	_ = keyring.Delete(keyringService, keyringProbeAccount)
	if err != nil {
		return err
	}
	if got != want {
		return fmt.Errorf("keyring probe read back a different value")
	}
	return nil
}
