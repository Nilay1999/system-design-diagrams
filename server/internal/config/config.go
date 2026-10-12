// Package config loads process configuration from environment variables.
package config

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strconv"
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
}

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
