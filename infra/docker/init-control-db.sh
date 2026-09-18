#!/usr/bin/env bash
# Creates the kemfai_control database on first kemfai-db startup, alongside the per-tenant
# kemfai_tenant_<id> databases Odoo creates dynamically. Runs once via Postgres's
# docker-entrypoint-initdb.d mechanism (T006).
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    SELECT 'CREATE DATABASE kemfai_control OWNER $POSTGRES_USER'
    WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'kemfai_control')\gexec

    DO $$
    BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'kemfai_api') THEN
            CREATE ROLE kemfai_api LOGIN PASSWORD 'kemfai_api_dev';
        END IF;
    END
    $$;

    GRANT CONNECT ON DATABASE kemfai_control TO kemfai_api;

    \connect kemfai_control

    GRANT USAGE ON SCHEMA public TO kemfai_api;
EOSQL
