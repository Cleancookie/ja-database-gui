package main

import (
	"os"
	"testing"

	"github.com/zalando/go-keyring"
)

// Tests must never touch the developer's real OS keyring.
func TestMain(m *testing.M) {
	keyring.MockInit()
	os.Exit(m.Run())
}
