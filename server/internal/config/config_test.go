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
		cfg.ShutdownTimeout != 15*time.Second || cfg.DrainDelay != 0 ||
		cfg.PublicURL.String() != "http://localhost:5173" || cfg.GitHubEnabled() || len(cfg.AdminGitHubIDs) != 0 ||
		cfg.SessionTTL != 30*24*time.Hour {
		t.Fatalf("unexpected defaults: %+v", cfg)
	}
}

func TestLoadOverrides(t *testing.T) {
	cfg, err := Load(env(map[string]string{
		"DATABASE_URL":         "postgres://x",
		"PORT":                 "9000",
		"LOG_FORMAT":           "text",
		"LOG_LEVEL":            "debug",
		"SHUTDOWN_TIMEOUT":     "30s",
		"DRAIN_DELAY":          "5s",
		"PUBLIC_URL":           "https://sdd.example",
		"GITHUB_CLIENT_ID":     "id",
		"GITHUB_CLIENT_SECRET": "secret",
		"ADMIN_GITHUB_IDS":     " 101, 202 ,",
		"SESSION_TTL":          "24h",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Addr != ":9000" || cfg.LogFormat != "text" || cfg.LogLevel != slog.LevelDebug ||
		cfg.ShutdownTimeout != 30*time.Second || cfg.DrainDelay != 5*time.Second ||
		cfg.PublicURL.Host != "sdd.example" || !cfg.GitHubEnabled() || cfg.SessionTTL != 24*time.Hour ||
		len(cfg.AdminGitHubIDs) != 2 || !cfg.AdminGitHubIDs[101] || !cfg.AdminGitHubIDs[202] {
		t.Fatalf("unexpected config: %+v", cfg)
	}
}

func TestLoadReportsEveryError(t *testing.T) {
	_, err := Load(env(map[string]string{
		"PORT": "abc", "LOG_FORMAT": "xml", "SHUTDOWN_TIMEOUT": "soon",
		"PUBLIC_URL": "ftp://x/path", "GITHUB_CLIENT_ID": "only-id", "ADMIN_GITHUB_IDS": "nilay",
	}))
	if err == nil {
		t.Fatal("expected an error")
	}
	for _, want := range []string{"DATABASE_URL", "LOG_FORMAT", "SHUTDOWN_TIMEOUT", "PORT", "PUBLIC_URL", "GITHUB_CLIENT_SECRET", "ADMIN_GITHUB_IDS"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not mention %s", err, want)
		}
	}
}
