package api

import (
	"context"
	"errors"
	"log"
	"os"
	"path/filepath"

	"github.com/Cleancookie/ja-db/internal/selfupdate"
)

// CheckUpdate reports the newest release. The transport supplies its own
// build's version, which is stamped at link time.
func (s *Service) CheckUpdate(ctx context.Context, version string) (selfupdate.Release, error) {
	return s.updates.Check(ctx, version)
}

// ApplyUpdate replaces the running executable with the newest release and
// returns its path, for the transport to relaunch once it has shut down.
func (s *Service) ApplyUpdate(ctx context.Context, version string) (string, error) {
	exe, err := executable()
	if err != nil {
		return "", err
	}
	if !selfupdate.IsRelease(version) {
		return "", errors.New("this build is not a release, so it cannot update itself")
	}
	r, err := s.updates.Apply(ctx, version, exe)
	if err != nil {
		return "", err
	}
	log.Printf("ja-db: updated %s → %s", r.Current, r.Latest)
	return exe, nil
}

// cleanupUpdate removes the exe the last update moved aside.
func cleanupUpdate() {
	if exe, err := executable(); err == nil {
		selfupdate.Cleanup(exe)
	}
}

func executable() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(exe)
}
