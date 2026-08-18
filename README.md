# artha_leaderboard

Validation leaderboard for Artha / DocAI. **The app is the scorer**: upload a predictions JSON
for a model config, it scores against stored ground truth, and the row lands on the board — one
place to answer *"which model config wins, on which task, on which dataset."*

Four tasks: **segmentation · classification · extraction · segregation**, plus an **Analysers**
view (our model vs a Gemini reference). No-build vanilla-JS frontend, Fastify + SQLite backend.

> Architecture, data model, metrics, and design decisions live in **[CLAUDE.md](CLAUDE.md)** —
> start there. Companion docs: **[PLAN.md](PLAN.md)** (phasing), **[SCHEMAS.md](SCHEMAS.md)** (file contracts).

---

## Run locally

```bash
npm install
npm run db:init                          # apply schema, seed 4 tasks, sync models.json -> DB
node scripts/set-password.js <user> <pw> # set the login credential (writes .env)
npm run dev                              # http://0.0.0.0:5173  (PORT=xxxx to override)
```

- The DB is a SQLite file at `data/artha.sqlite` (gitignored, WAL mode). `db:init` is idempotent.
- If **no credential is set**, the app runs **open** (dev convenience). Set one to enable the login gate.

---

## Deploy with Docker

The whole app is one container; the SQLite DB + uploads persist in a named volume.

```bash
# 1. create the credential (writes .env, which compose passes into the container)
node scripts/set-password.js <user> <pw>

# 2. build + run
docker compose up -d --build            # serves on http://<host>:5173

# logs / status
docker compose logs -f
docker compose ps
```

- **Persistence** — the volume `artha-data` holds `/app/data` (DB + uploads). It survives
  `down`/`up` and rebuilds. `docker compose down -v` deletes it (and your data) — don't, unless you mean it.
- **First boot only** initializes the schema (see below). Restarts skip init, so no data is lost.
- **Change the host port** — `PORT=8080 docker compose up -d` maps host `8080` → container `5173`.
- **Credential** — `.env` is read via `env_file`; it is never baked into the image. Re-run
  `set-password.js` and `docker compose up -d` to rotate it.

### Reaching it from a phone (Tailscale)

The container listens on `0.0.0.0:5173`, mapped to the host. With the VM on your tailnet, browse to
`http://<vm-tailscale-ip>:5173` from the phone. (See the operator notes for the Tailscale setup.)

### First-boot init (why it's guarded)

`docker-entrypoint.sh` runs `server/db/init.js` **only when `data/artha.sqlite` is absent** — i.e.
on a fresh volume. `init.js` drops & recreates the `analyzer_runs` table each run (a one-time
migration), so running it on every boot would wipe analyzer data. **To migrate an existing DB after
an upgrade**, run it deliberately: `docker compose exec artha node server/db/init.js`.

### Seeding an existing DB into the volume

To carry local data onto the VM, copy your SQLite file into the volume before first boot:

```bash
docker compose up -d --build            # creates the (empty) volume
docker compose cp data/artha.sqlite artha:/app/data/artha.sqlite
docker compose restart artha            # now it sees a DB and skips init
```

---

## Backup & export

The DB is mostly small text, so exports are cheap. From the running app (**⚙ Settings → Export DB**)
or via the API:

| What | How |
|---|---|
| Whole DB as CSV (one file per table, zipped) | `GET /api/export?format=csv` |
| A single table as CSV | `GET /api/export?format=csv&table=runs` |
| Full SQLite snapshot (WAL-collapsed, consistent) | `GET /api/export?format=sqlite` |
| List exportable tables | `GET /api/export/tables` |

For an offline snapshot (e.g. before a risky migration), the CSV zip + a `.sqlite` copy together are
a complete, restorable backup of every number in the board.
