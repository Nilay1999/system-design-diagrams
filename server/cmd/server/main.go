// Command server is the API (and, from Phase 6, the background worker) in one binary:
//
//	server api                 serve HTTP
//	server migrate [command]   run goose migrations: up (default), down, status, redo, reset
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"runtime/debug"
	"syscall"
	"time"

	"github.com/Nilay1999/system-design-diagrams/server/internal/config"
	"github.com/Nilay1999/system-design-diagrams/server/internal/db"
	"github.com/Nilay1999/system-design-diagrams/server/internal/httpapi"
)

// version is set at build time with -ldflags "-X main.version=<sha>".
var version = ""

const usage = "usage: server api | server migrate [up|down|status|redo|reset]"

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		return errors.New(usage)
	}
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		return err
	}
	logger := newLogger(cfg)
	slog.SetDefault(logger)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	switch args[0] {
	case "api":
		return serveAPI(ctx, cfg, logger)
	case "migrate":
		command := "up"
		if len(args) > 1 {
			command = args[1]
		}
		pool, err := db.Connect(ctx, cfg.DatabaseURL)
		if err != nil {
			return err
		}
		defer pool.Close()
		return db.Migrate(ctx, pool, command, args[min(2, len(args)):]...)
	default:
		return fmt.Errorf("unknown command %q\n%s", args[0], usage)
	}
}

func serveAPI(ctx context.Context, cfg config.Config, logger *slog.Logger) error {
	pool, err := db.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()

	api := httpapi.New(logger, pool, buildVersion())
	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           api.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       120 * time.Second,
		// Requests outlive the signal context, so in-flight work isn't cancelled on SIGTERM.
		BaseContext: func(net.Listener) context.Context { return context.WithoutCancel(ctx) },
	}

	errc := make(chan error, 1)
	go func() {
		logger.Info("api listening", "addr", cfg.Addr, "version", buildVersion())
		errc <- srv.ListenAndServe()
	}()

	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}

	// Fail readiness first so the load balancer stops routing here, then stop accepting
	// connections and let in-flight requests finish.
	logger.Info("shutting down", "drain_delay", cfg.DrainDelay, "timeout", cfg.ShutdownTimeout)
	api.Drain()
	time.Sleep(cfg.DrainDelay)

	shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("shutdown: %w", err)
	}
	if err := <-errc; !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	logger.Info("stopped")
	return nil
}

func newLogger(cfg config.Config) *slog.Logger {
	opts := &slog.HandlerOptions{Level: cfg.LogLevel}
	if cfg.LogFormat == "text" {
		return slog.New(slog.NewTextHandler(os.Stdout, opts))
	}
	return slog.New(slog.NewJSONHandler(os.Stdout, opts))
}

// buildVersion prefers the -ldflags version and falls back to the VCS revision Go embeds
// in builds from a git checkout.
func buildVersion() string {
	if version != "" {
		return version
	}
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, s := range info.Settings {
			if s.Key == "vcs.revision" {
				return s.Value
			}
		}
	}
	return "dev"
}
