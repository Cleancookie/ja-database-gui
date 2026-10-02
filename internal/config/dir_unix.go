//go:build !windows

package config

import "os"

// tightenDir forces 0700: MkdirAll leaves an existing, looser directory as it was.
func tightenDir(dir string) error { return os.Chmod(dir, 0o700) }
