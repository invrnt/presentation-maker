package main

import "testing"

func TestNewerVersion(t *testing.T) {
	tests := []struct {
		candidate string
		current   string
		want      bool
	}{
		{"1.0.1", "1.0.0", true},
		{"1.1.0", "1.0.9", true},
		{"2.0.0", "1.9.9", true},
		{"1.0.0", "1.0.0", false},
		{"1.0.0", "1.0.1", false},
		{"1.0.0", "dev", true},
	}
	for _, test := range tests {
		if got := newerVersion(test.candidate, test.current); got != test.want {
			t.Fatalf("newerVersion(%q, %q) = %v, want %v", test.candidate, test.current, got, test.want)
		}
	}
}
