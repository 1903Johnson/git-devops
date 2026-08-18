#!/bin/bash
# Runs once, on first initialisation of an empty postgres volume.
#
# Creates the test database alongside the development one so the integration suites work
# against a fresh clone without extra setup. Re-running needs `docker compose down -v`,
# because Postgres skips this directory when the data volume already exists.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-SQL
  SELECT 'CREATE DATABASE church_test'
   WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'church_test')\gexec
SQL

echo "init-databases: church_test ready"
