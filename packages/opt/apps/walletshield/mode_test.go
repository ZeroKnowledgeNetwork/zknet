package main

import "testing"

// The config decides the mode: a thin config runs thin without -thin, and a
// full one never does.
func TestTheConfigDecidesTheMode(t *testing.T) {
	for path, want := range map[string]bool{
		"testdata/thin.toml":    true,
		"testdata/full.toml":    false,
		"testdata/missing.toml": false,
	} {
		if got := isThinConfig(path); got != want {
			t.Errorf("isThinConfig(%q) = %v, want %v", path, got, want)
		}
	}
}
