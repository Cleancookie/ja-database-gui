package driver

import (
	"errors"
	"fmt"
	"net"
	"sort"
	"strings"
)

// TLS levels, weakest first. The UI colours and warns on these.
const (
	TLSNotApplicable = "na"        // SQLite: no network
	TLSPlain         = "plain"     // never encrypted
	TLSPartial       = "partial"   // may fall back to plaintext, or encrypts the login only
	TLSEncrypted     = "encrypted" // encrypted, but the server's certificate is not checked
	TLSVerified      = "verified"  // encrypted and the certificate is checked
)

// TLSInfo is the TLS mode a connection will actually use, after defaults are
// applied. It is what the connection form and the Picker show.
type TLSInfo struct {
	// Mode is the dialect's own spelling of the mode in effect.
	Mode  string `json:"mode"`
	Level string `json:"level"`
	// Implicit is true when the user chose nothing and a default applied.
	Implicit bool `json:"implicit"`
	// Label is one line for the UI, e.g. "TLS verified (verify-full)".
	Label string `json:"label"`
	// Warn is true when the connection leaves a non-loopback host short of
	// verified TLS.
	Warn bool `json:"warn"`
}

// IsLoopbackHost reports whether host stays on this machine. An empty host
// counts: every driver here dials 127.0.0.1 for it. A leading "/" is a
// postgres unix-socket directory.
func IsLoopbackHost(host string) bool {
	h := strings.ToLower(strings.Trim(host, "[]"))
	if h == "" || h == "localhost" || strings.HasSuffix(h, ".localhost") || strings.HasPrefix(h, "/") {
		return true
	}
	ip := net.ParseIP(h)
	return ip != nil && ip.IsLoopback()
}

// checkSSLMode rejects a mode the dialect does not know. An empty mode is "use
// the default" and always passes.
func checkSSLMode(d Driver, mode string) error {
	if mode == "" {
		return nil
	}
	for _, m := range d.Caps().SSLModes {
		if m == mode {
			return nil
		}
	}
	return fmt.Errorf("%s does not accept SSL mode %q (use one of: %s)",
		d.Caps().DisplayName, mode, strings.Join(d.Caps().SSLModes, ", "))
}

// checkParams refuses an extra parameter that would override the SSL mode.
// Params is an escape hatch appended to the DSN; letting it carry the TLS keys
// would sidestep both the allow-list and the warning in the form.
func checkParams(params map[string]string, managed ...string) error {
	keys := make([]string, 0, len(params))
	for k := range params {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		for _, m := range managed {
			if strings.EqualFold(k, m) {
				return fmt.Errorf("%w: %q is set by the SSL mode settings, not by extra parameters", errManagedParam, k)
			}
		}
	}
	return nil
}

// ValidateConn is the save-time check shared by every dialect: the mode is on
// the allow-list and Params does not smuggle in a TLS key.
func ValidateConn(d Driver, cfg ConnConfig) error {
	if err := checkSSLMode(d, cfg.SSLMode); err != nil {
		return err
	}
	if _, err := d.DSN(cfg, ""); errors.Is(err, errManagedParam) {
		return err
	}
	return nil
}

var errManagedParam = errors.New("managed parameter")

func tlsLabel(info TLSInfo) string {
	switch info.Level {
	case TLSNotApplicable:
		return "no network"
	case TLSPlain:
		return fmt.Sprintf("NOT encrypted (%s)", info.Mode)
	case TLSPartial:
		return fmt.Sprintf("encryption not guaranteed (%s)", info.Mode)
	case TLSEncrypted:
		return fmt.Sprintf("encrypted, certificate NOT checked (%s)", info.Mode)
	default:
		return fmt.Sprintf("TLS verified (%s)", info.Mode)
	}
}

func finishTLS(info TLSInfo, host string) TLSInfo {
	info.Label = tlsLabel(info)
	info.Warn = info.Level != TLSVerified && info.Level != TLSNotApplicable && !IsLoopbackHost(host)
	return info
}
