//go:build windows

package activity

// pidAlive cannot tell on Windows: os.FindProcess reports success for pids
// that are gone, so sweepStale falls back to the directory's age.
func pidAlive(int) (running, known bool) { return false, false }
