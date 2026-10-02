//go:build windows

package config

// tightenDir does nothing: mode bits mean nothing on Windows, where the
// profile ACL on %AppData% is the protection.
func tightenDir(string) error { return nil }
