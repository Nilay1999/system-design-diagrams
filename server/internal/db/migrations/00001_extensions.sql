-- +goose Up
-- citext: case-insensitive handles and slugs. pg_trgm: fuzzy title search (Phase 4).
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- +goose Down
DROP EXTENSION IF EXISTS pg_trgm;
DROP EXTENSION IF EXISTS citext;
