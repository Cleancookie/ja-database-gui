//go:build !windows

package activity

import (
	"errors"
	"os"
	"syscall"
)

// pidAlive uses signal 0, which checks the pid without delivering anything.
// EPERM means the process exists but is someone else's, so it is alive.
func pidAlive(pid int) (running, known bool) {
	p, err := os.FindProcess(pid)
	if err != nil {
		return false, true
	}
	err = p.Signal(syscall.Signal(0))
	return err == nil || errors.Is(err, syscall.EPERM), true
}
