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

// DownloadUpdate fetches and verifies the newest release next to the running
// exe without touching it. ApplyUpdate installs it when the user is ready.
func (s *Service) DownloadUpdate(ctx context.Context, version string) (selfupdate.Release, error) {
	exe, err := executable()
	if err != nil {
		return selfupdate.Release{}, err
	}
	if !selfupdate.IsRelease(version) {
		return selfupdate.Release{}, errors.New("this build is not a release, so it cannot update itself")
	}
	return s.updates.Stage(ctx, version, exe)
}

// ApplyUpdate swaps the downloaded release in and returns the exe path, for
// the transport to relaunch once it has shut down.
func (s *Service) ApplyUpdate(version string) (string, error) {
	exe, err := executable()
	if err != nil {
		return "", err
	}
	if !selfupdate.IsRelease(version) {
		return "", errors.New("this build is not a release, so it cannot update itself")
	}
	if err := selfupdate.Install(exe); err != nil {
		return "", err
	}
	log.Printf("ja-db: updated from %s", version)
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
