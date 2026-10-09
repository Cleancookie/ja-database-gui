//go:build bindings

package main

// Wails builds and runs a copy tagged `bindings` only to read App's methods.
// Opening config there probes the OS keyring, which on Linux with no secret
// service waits out a two-minute D-Bus timeout on every build.
const generatingBindings = true
