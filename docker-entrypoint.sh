#!/bin/sh
# Initialize the schema+seed ONLY on a fresh volume. init.js drops & recreates the
# analyzer_runs table every run (a one-time migration), so running it on every boot
# would wipe analyzer data — hence the "init only when the DB is absent" guard.
# To migrate an existing DB after an upgrade, run `node server/db/init.js` by hand.
set -e

DB="${ARTHA_DB:-${ARTHA_DATA:-/app/data}/artha.sqlite}"
mkdir -p "$(dirname "$DB")"

if [ ! -f "$DB" ]; then
  echo "[entrypoint] No DB at $DB — initializing schema + seed…"
  node server/db/init.js
else
  echo "[entrypoint] DB present at $DB — skipping init."
fi

exec node server/index.js
