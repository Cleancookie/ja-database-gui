// Package sample builds the sample SQLite database offered to new users.
//
// The source of truth is seed.sql, embedded in the binary and run into a new
// file through the normal SQLite driver. Nothing here takes a path from the
// caller other than the config directory: the only file ever written is
// <dir>/sample.sqlite (via a temp file beside it), with 0600 like the other
// config files.
package sample

import (
	"context"
	"database/sql"
	_ "embed"
	"fmt"
	"os"
	"path/filepath"

	"github.com/Cleancookie/ja-db/internal/driver"
)

//go:embed seed.sql
var seed string

// FileName is the sample database's name inside the config directory.
const FileName = "sample.sqlite"

// ConnectionName is the saved connection's display name.
const ConnectionName = "Sample database (SQLite)"

// Path is where the sample database lives for a config directory.
func Path(dir string) string { return filepath.Join(dir, FileName) }

// Ensure returns the sample file's path, building it only when absent. An
// existing file is never touched: the user may have edited it.
func Ensure(dir string) (string, error) {
	p := Path(dir)
	if _, err := os.Stat(p); err == nil {
		return p, nil
	} else if !os.IsNotExist(err) {
		return "", err
	}
	return p, build(dir, p)
}

// Reset replaces the sample file with a freshly built one, discarding edits.
// The caller must close any open connection to it first.
func Reset(dir string) (string, error) {
	p := Path(dir)
	return p, build(dir, p)
}

// build runs the seed into a temp file, then renames it into place, so a
// failed build never leaves a half-made sample behind.
func build(dir, dest string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, FileName+".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op once renamed
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := run(tmpName); err != nil {
		return fmt.Errorf("building sample database: %w", err)
	}
	return os.Rename(tmpName, dest)
}

func run(file string) error {
	d, err := driver.Get(driver.KindSQLite)
	if err != nil {
		return err
	}
	dsn, err := d.DSN(driver.ConnConfig{Kind: driver.KindSQLite, File: file}, "")
	if err != nil {
		return err
	}
	db, err := sql.Open(d.SQLDriverName(), dsn)
	if err != nil {
		return err
	}
	defer db.Close()
	// One connection: the seed's PRAGMA and its statements must share it.
	db.SetMaxOpenConns(1)
	if _, err := db.ExecContext(context.Background(), seed); err != nil {
		return err
	}
	return nil
}
