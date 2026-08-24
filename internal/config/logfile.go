package config

import (
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
)

// logMaxBytes is the size at which the log is rotated. One previous file is
// kept, so the worst case on disk is twice this. Small on purpose: this is a
// diagnostic for "why was that slow", not an audit trail.
const logMaxBytes = 1 << 20 // 1 MiB

// LogFileName is the log's name inside the config directory.
const LogFileName = "ja-db.log"

// OpenLog points the standard logger at a file in dir, in addition to wherever
// it already writes.
//
// This exists because a Windows GUI binary has no stdout: launched from
// Explorer, every log line the app writes is discarded, which makes "check the
// logs to see why startup was slow" impossible to answer. Nothing about the
// logging calls themselves changes — only where they land.
//
// The returned closer should be called on shutdown. A failure to open the file
// is returned but is not worth aborting the app over; the caller may log it and
// carry on with an unpersisted logger.
func OpenLog(dir string) (io.Closer, error) {
	path := filepath.Join(dir, LogFileName)
	if err := rotateIfLarge(path); err != nil {
		return nil, err
	}

	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return nil, fmt.Errorf("opening log file: %w", err)
	}

	// Kept alongside the original writer rather than replacing it, so running
	// from a terminal still shows output live.
	log.SetOutput(io.MultiWriter(os.Stderr, f))
	// Date as well as time: the file spans sessions, and "10:14:03" alone is
	// ambiguous once there is more than one day in it.
	log.SetFlags(log.LstdFlags)
	return f, nil
}

// rotateIfLarge moves the log aside once it passes the cap, keeping exactly one
// previous file. Checked at startup rather than per write: a size check on every
// log line would be a syscall per query.
func rotateIfLarge(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("checking log size: %w", err)
	}
	if info.Size() < logMaxBytes {
		return nil
	}
	if err := os.Rename(path, path+".1"); err != nil {
		return fmt.Errorf("rotating log: %w", err)
	}
	return nil
}
