// Package config loads process configuration from environment variables.
package config

import (
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config is everything the server reads from its environment.
type Config struct {
	// Addr is the listen address, built from PORT (default 8080).
	Addr        string
	DatabaseURL string
	LogLevel    slog.Level
	// LogFormat is "json" (default, for production) or "text" (for local dev).
	LogFormat string
	// ShutdownTimeout bounds how long in-flight requests get to finish after SIGTERM.
	ShutdownTimeout time.Duration
	// DrainDelay is how long /ready reports 503 before the listener closes, so the
	// load balancer stops routing new requests first.
	DrainDelay time.Duration

	// PublicURL is where browsers reach the app (the web origin, which proxies /api). It
	// builds the OAuth callback URL, is the trusted origin for CSRF checks, and decides
	// whether cookies are Secure.
	PublicURL *url.URL
	// GitHubClientID and GitHubClientSecret enable "Sign in with GitHub". Without them the
	// API runs with sign-in turned off.
	GitHubClientID     string
	GitHubClientSecret string
	// AdminGitHubIDs are GitHub user IDs promoted to admin when they sign in. IDs, not
	// logins: a login can be renamed and then claimed by someone else.
	AdminGitHubIDs map[int64]bool
	// SessionTTL is how long a session lasts without use. Active sessions slide forward.
	SessionTTL time.Duration
}

// GitHubEnabled reports whether GitHub sign-in is configured.
func (c Config) GitHubEnabled() bool { return c.GitHubClientID != "" }

// Load reads the config from the environment. getenv is os.Getenv outside tests.
func Load(getenv func(string) string) (Config, error) {
	if getenv == nil {
		getenv = os.Getenv
	}
	var errs []error

	cfg := Config{
		Addr:        ":" + withDefault(getenv("PORT"), "8080"),
		DatabaseURL: getenv("DATABASE_URL"),
		LogFormat:   withDefault(getenv("LOG_FORMAT"), "json"),
	}
	if cfg.DatabaseURL == "" {
		errs = append(errs, errors.New("DATABASE_URL is required"))
	}
	if cfg.LogFormat != "json" && cfg.LogFormat != "text" {
		errs = append(errs, fmt.Errorf("LOG_FORMAT must be json or text, got %q", cfg.LogFormat))
	}
	if err := cfg.LogLevel.UnmarshalText([]byte(withDefault(getenv("LOG_LEVEL"), "info"))); err != nil {
		errs = append(errs, fmt.Errorf("LOG_LEVEL: %w", err))
	}
	var err error
	if cfg.ShutdownTimeout, err = duration(getenv, "SHUTDOWN_TIMEOUT", 15*time.Second); err != nil {
		errs = append(errs, err)
	}
	if cfg.DrainDelay, err = duration(getenv, "DRAIN_DELAY", 0); err != nil {
		errs = append(errs, err)
	}
	if cfg.SessionTTL, err = duration(getenv, "SESSION_TTL", 30*24*time.Hour); err != nil {
		errs = append(errs, err)
	}

	cfg.PublicURL, err = url.Parse(withDefault(getenv("PUBLIC_URL"), "http://localhost:5173"))
	if err != nil || (cfg.PublicURL.Scheme != "http" && cfg.PublicURL.Scheme != "https") || cfg.PublicURL.Host == "" ||
		strings.Trim(cfg.PublicURL.Path, "/") != "" {
		errs = append(errs, fmt.Errorf("PUBLIC_URL must be an http(s) origin like https://example.com, got %q", getenv("PUBLIC_URL")))
	}

	cfg.GitHubClientID, cfg.GitHubClientSecret = getenv("GITHUB_CLIENT_ID"), getenv("GITHUB_CLIENT_SECRET")
	if (cfg.GitHubClientID == "") != (cfg.GitHubClientSecret == "") {
		errs = append(errs, errors.New("set both GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET, or neither"))
	}

	cfg.AdminGitHubIDs = map[int64]bool{}
	for _, v := range strings.Split(getenv("ADMIN_GITHUB_IDS"), ",") {
		if v = strings.TrimSpace(v); v == "" {
			continue
		}
		id, err := strconv.ParseInt(v, 10, 64)
		if err != nil || id <= 0 {
			errs = append(errs, fmt.Errorf("ADMIN_GITHUB_IDS must be comma-separated numeric GitHub user IDs, got %q", v))
			continue
		}
		cfg.AdminGitHubIDs[id] = true
	}

	if _, err := strconv.Atoi(cfg.Addr[1:]); err != nil {
		errs = append(errs, fmt.Errorf("PORT must be a number, got %q", cfg.Addr[1:]))
	}
	return cfg, errors.Join(errs...)
}

func withDefault(v, def string) string {
	if v == "" {
		return def
	}
	return v
}

func duration(getenv func(string) string, key string, def time.Duration) (time.Duration, error) {
	v := getenv(key)
	if v == "" {
		return def, nil
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		return 0, fmt.Errorf("%s: %w", key, err)
	}
	return d, nil
}
