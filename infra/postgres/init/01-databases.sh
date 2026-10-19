#!/usr/bin/env bash
# Creates the databases and the roles of Bot Center on the first start of the PostgreSQL container.
# The official postgres image runs this script only when the data directory is empty.
# Compose files: infra/compose/compose.dev.yml and infra/compose/compose.prod.yml.
#
# Databases and roles:
#   botcenter        Owner: botcenter_owner.
#     botcenter_owner  Owner of the database and of the schema `public`. Runs the Prisma migrations
#                      (DATABASE_URL_MIGRATE). The API and the workers never use it.
#     botcenter_app    Role of the API and of the workers (DATABASE_URL). SELECT, INSERT, UPDATE, and
#                      DELETE on the tables only. It cannot create, alter, or drop an object.
#   evolution        Owner: evolution. The Evolution API runs its own Prisma migrations with this role.
#
# No role can connect to the database of the other application. PUBLIC has no CONNECT privilege.
set -euo pipefail

: "${POSTGRES_USER:?POSTGRES_USER is not set}"
: "${BOTCENTER_OWNER_PASSWORD:?BOTCENTER_OWNER_PASSWORD is not set}"
: "${BOTCENTER_APP_PASSWORD:?BOTCENTER_APP_PASSWORD is not set}"
: "${EVOLUTION_DB_PASSWORD:?EVOLUTION_DB_PASSWORD is not set}"

echo "db-init: create the databases botcenter and evolution, and their roles"

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname postgres \
  --set owner_password="$BOTCENTER_OWNER_PASSWORD" \
  --set app_password="$BOTCENTER_APP_PASSWORD" \
  --set evolution_password="$EVOLUTION_DB_PASSWORD" <<'SQL'
CREATE ROLE botcenter_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
  PASSWORD :'owner_password';
CREATE ROLE botcenter_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
  PASSWORD :'app_password';
CREATE ROLE evolution LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
  PASSWORD :'evolution_password';

CREATE DATABASE botcenter OWNER botcenter_owner;
CREATE DATABASE evolution OWNER evolution;

REVOKE ALL ON DATABASE botcenter FROM PUBLIC;
REVOKE ALL ON DATABASE evolution FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE botcenter TO botcenter_app;
SQL

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname botcenter <<'SQL'
ALTER SCHEMA public OWNER TO botcenter_owner;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO botcenter_app;

-- The migrations of botcenter_owner create the tables later. These grants apply to them automatically.
ALTER DEFAULT PRIVILEGES FOR ROLE botcenter_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO botcenter_app;
ALTER DEFAULT PRIVILEGES FOR ROLE botcenter_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO botcenter_app;
ALTER DEFAULT PRIVILEGES FOR ROLE botcenter_owner IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO botcenter_app;
SQL

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname evolution <<'SQL'
ALTER SCHEMA public OWNER TO evolution;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SQL

echo "db-init: databases and roles created"
