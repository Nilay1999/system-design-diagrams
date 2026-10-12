package config

import (
	"log/slog"
	"strings"
	"testing"
	"time"
)

func env(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func TestLoadDefaults(t *testing.T) {
	cfg, err := Load(env(map[string]string{"DATABASE_URL": "postgres://x"}))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Addr != ":8080" || cfg.LogFormat != "json" || cfg.LogLevel != slog.LevelInfo ||
		cfg.ShutdownTimeout != 15*time.Second || cfg.DrainDelay != 0 {
		t.Fatalf("unexpected defaults: %+v", cfg)
	}
}

func TestLoadOverrides(t *testing.T) {
	cfg, err := Load(env(map[string]string{
		"DATABASE_URL":     "postgres://x",
		"PORT":             "9000",
		"LOG_FORMAT":       "text",
		"LOG_LEVEL":        "debug",
		"SHUTDOWN_TIMEOUT": "30s",
		"DRAIN_DELAY":      "5s",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Addr != ":9000" || cfg.LogFormat != "text" || cfg.LogLevel != slog.LevelDebug ||
		cfg.ShutdownTimeout != 30*time.Second || cfg.DrainDelay != 5*time.Second {
		t.Fatalf("unexpected config: %+v", cfg)
	}
}

func TestLoadReportsEveryError(t *testing.T) {
	_, err := Load(env(map[string]string{"PORT": "abc", "LOG_FORMAT": "xml", "SHUTDOWN_TIMEOUT": "soon"}))
	if err == nil {
		t.Fatal("expected an error")
	}
	for _, want := range []string{"DATABASE_URL", "LOG_FORMAT", "SHUTDOWN_TIMEOUT", "PORT"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not mention %s", err, want)
		}
	}
}
