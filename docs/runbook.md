# Bot Center runbook

Operations procedures of Bot Center, phase 1 (one host). The architecture is in `docs/Plano de Arquitetura Servidor Evolution API para Bots de WhatsApp.md` (pt-BR). The decisions are in `docs/implementation-plan.md`, section 8.

## 0. Conventions

- The repository is on the host in `/opt/botcenter`. The env files are in `/etc/botcenter` (directory mode 700, files mode 600).
- `bc` in this runbook means `sudo /opt/botcenter/infra/scripts/compose.sh`. It runs `docker compose` with the production files, the project `botcenter`, and `/etc/botcenter/compose.env`. Example: `bc ps`, `bc logs -f --since 10m worker`.
- You connect to the host only through Tailscale: `ssh <admin user>@botcenter-prod-1`. The public interface has no SSH.
- The Uptime Kuma UI is on `127.0.0.1:3001` of the host. Open it with a tunnel: `ssh -L 3001:127.0.0.1:3001 <admin user>@botcenter-prod-1`, then `http://localhost:3001`.
- Every alert goes to the Discord operations channel. The host scripts use `ALERT_DISCORD_WEBHOOK_URL` of `/etc/botcenter/backup.env`. The API uses the same variable in `/etc/botcenter/api.env`. Grafana Cloud uses its own contact point.

| File in `/etc/botcenter` | Service or script | Template |
| --- | --- | --- |
| `compose.env` | Compose interpolation: image, extra files, memory | `infra/env/compose.env.example` |
| `caddy.env` | Caddy: domain, TLS mode | `infra/env/caddy.env.example` |
| `api.env` | `api` and `worker` | `infra/env/api.env.example` |
| `migrate.env` | `migrate` (owner role of the database) | `infra/env/migrate.env.example` |
| `evolution.env` | Evolution API secrets | `infra/env/evolution.env.example` |
| `postgres.env` | PostgreSQL superuser and role passwords | `infra/env/postgres.env.example` |
| `redis.env` | Redis passwords of the ACL users `default`, `botcenter`, `evolution`, `metrics` | `infra/env/redis.env.example` |
| `alloy.env` | Grafana Cloud credentials | `infra/env/alloy.env.example` |
| `backup.env` | Backup, restore test, disk check, Evolution retention | `infra/env/backup.env.example` |
| `restic.env` | restic repository and R2 credentials | `infra/env/restic.env.example` |
| `firewall.env` | Cloudflare firewall timer | `infra/env/firewall.env.example` |
| `certs/origin.pem`, `certs/origin-key.pem` | Cloudflare origin certificate | Cloudflare dashboard |

## 1. Size and buy the Hetzner host

1. Make a Hetzner Cloud project only for Bot Center. An API token of this project then cannot change other servers.
2. Make the server:
   - Type: CX22 (2 vCPU, 4 GB) at the start. The architecture says that one CX22 is sufficient while only PersonalLife is connected.
   - Image: Ubuntu 24.04.
   - Location: the region nearest to the users (for Brazil: the nearest region that Hetzner has at the time of purchase; compare the latency).
   - SSH key: your public key. No password.
   - Backups: on (daily server snapshots, 20 % of the server price).
   - Name: `botcenter-prod-1`.
3. Do not attach a Primary IPv6 only: keep IPv4, because Cloudflare connects to the origin over IPv4 or IPv6.
4. Write the public IP address. You need it for the DNS record.

Move to the CX32 (4 vCPU, 8 GB) when one of these triggers occurs (procedure 15):

- CPU above 70 % for 15 minutes at the peak (alert `HostCpuHigh`).
- Memory above 80 % (alert `HostMemoryHigh`).
- Delay of the `outbound` queue above 30 s (alert `OutboundQueueDelayHigh`).
- The memory for each connected number (load test, `tests/load/README.md`) times the number of numbers is above the Evolution limit of the CX22 profile (1280 MB).

## 2. Prepare the host

1. Make a Tailscale auth key: Tailscale admin console > Settings > Keys > Generate auth key (one use, pre-approved, tag `tag:server`).
2. Connect to the host with the public IP (the only time): `ssh root@<public IP>`.
3. Install git and clone the repository:

   ```sh
   apt-get update && apt-get install -y git
   git clone https://github.com/<owner>/botcenter.git /opt/botcenter
   ```

4. Run the bootstrap script. It installs Docker, Tailscale, ufw, fail2ban, and unattended-upgrades. It makes the admin user, a 2 GB swap file, and the directories, and it copies the systemd units.

   WARNING: The script closes SSH on the public interface. It does this only when Tailscale is connected. Keep the Hetzner web console open as a fallback.

   ```sh
   TAILSCALE_AUTHKEY=tskey-auth-... ADMIN_USER=ops /opt/botcenter/infra/host/bootstrap.sh
   ```

5. Open a second terminal. Connect through Tailscale: `ssh ops@botcenter-prod-1`. Make sure that `sudo -v` works.
6. Close the first terminal.
7. In the Tailscale admin console, turn off the key expiry of `botcenter-prod-1`.

The script is idempotent. Run it again after a change of `infra/host/bootstrap.sh`.

## 3. DNS and Cloudflare

1. Add the domain to Cloudflare (Free plan).
2. Make an `A` record (and an `AAAA` record if the server has IPv6) for the API host name, for example `api.botcenter.example`, to the public IP. Set the proxy status to "Proxied" (orange cloud).
3. SSL/TLS > Overview: set the mode to "Full (strict)".
4. SSL/TLS > Edge Certificates: turn on "Always Use HTTPS" and "Automatic HTTPS Rewrites". Set "Minimum TLS Version" to 1.2.
5. SSL/TLS > Origin Server: make an origin certificate for the API host name (RSA 2048, 15 years). Save the certificate as `/etc/botcenter/certs/origin.pem` and the key as `/etc/botcenter/certs/origin-key.pem`:

   ```sh
   sudo install -m 644 -o 1000 -g 1000 origin.pem /etc/botcenter/certs/origin.pem
   sudo install -m 600 -o 1000 -g 1000 origin-key.pem /etc/botcenter/certs/origin-key.pem
   sudo chmod 711 /etc/botcenter/certs
   ```

   Caddy runs as uid 1000 and must read the two files through the bind mount of `/etc/botcenter/certs`. The directory stays closed for a listing. `/etc/botcenter` stays mode 700.
6. Security > WAF: turn on the Cloudflare managed rules that the Free plan has. Add a rate limiting rule for the API host name (for example, 600 requests per minute for each IP). The API also has its own limits.
7. Optional: SSL/TLS > Origin Server > "Authenticated Origin Pulls". Then add `client_auth` with the Cloudflare CA to the Caddyfile. This makes sure that only Cloudflare can connect, also from a Cloudflare IP of an other customer.

ACME mode (alternative to the origin certificate): set `CADDY_TLS=<e-mail>` in `caddy.env` and `ALLOW_HTTP=true` in `firewall.env`. Let's Encrypt then uses HTTP-01 through Cloudflare on port 80. The origin certificate is simpler and needs no open port 80.

## 4. Cloudflare R2

1. R2 > Create bucket `botcenter-media` (location hint: the region of the users). It stays private. The API gives pre-signed URLs with a short validity.
2. Add a lifecycle rule to `botcenter-media`: delete objects after the longest `retentionDays` of the tenants (default 90 days). Add a rule to abort incomplete multipart uploads after 1 day.
3. Create bucket `botcenter-backups`. Add a rule to abort incomplete multipart uploads after 1 day. Do not add a delete rule: restic removes old snapshots (`forget --prune`).
4. R2 > Manage API tokens: make two tokens with "Object Read & Write", each for one bucket only.
   - Media token: `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` in `api.env`.
   - Backup token: `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` in `restic.env`.
5. Set `S3_ENDPOINT` (`api.env`) and the host of `RESTIC_REPOSITORY` (`restic.env`) to `https://<account id>.r2.cloudflarestorage.com`.

## 5. Grafana Cloud

1. Make a Grafana Cloud stack (Free plan). Select the region nearest to the host.
2. Make an access policy with the scopes `metrics:write` and `logs:write`, and a token for it. Write the values in `alloy.env`: the Prometheus remote write URL and user, the Loki push URL and user, and the token.
3. Load the alert rules with `mimirtool` (from your computer):

   ```sh
   mimirtool rules load infra/observability/prometheus/alerts.yml \
     --address=https://<prometheus host>.grafana.net --id=<prometheus user> --key=<token with rules:write>
   ```

   Run the unit tests of the rules first: `docker run --rm -v "$PWD/infra/observability/prometheus:/r:ro" -w /r --entrypoint promtool prom/prometheus:v3.15.0 test rules alerts.test.yml`.
4. Alerting > Contact points: add a Discord contact point with the webhook of the operations channel. Send `severity=critical` and `severity=warning` to it.
5. Dashboards > Import: upload `infra/observability/grafana/botcenter-dashboard.json`. Select the Prometheus data source of the stack.
6. Explore > Loki: make sure that the label `service` shows `api`, `worker`, `evolution`, and the other services. Alloy reads the container logs from the journal of the host (journald log driver). On the host, `journalctl COM_DOCKER_COMPOSE_SERVICE=api -n 20` shows the same lines.

## 6. Secrets

1. Make the env files on the host:

   ```sh
   sudo /opt/botcenter/infra/scripts/gen-secrets.sh
   ```

   The script writes `/etc/botcenter/*.env` with mode 600. Each secret is 32 random bytes: the PostgreSQL passwords, the Redis password, the Evolution API key, the internal webhook secret, the API key pepper, the data encryption key, and the restic password. It never prints a secret. It lists the `CHANGE_ME` values that you must set.
2. Edit each file that the script lists (`sudo -e /etc/botcenter/api.env`, and the others).

   In `api.env`, set `CONNECT_ALLOWED_ORIGINS` to the origin of each client frontend that opens the connect event stream, for example `CONNECT_ALLOWED_ORIGINS=https://app.personallife.com.br`. Use a comma between two origins. Write the origin only: scheme, host, and port, with no path and no `/` at the end.

   CAUTION: Without the origin of the frontend, the browser blocks the connect event stream. The user then never sees the QR code or the pairing code.
3. Put `RESTIC_PASSWORD` of `/etc/botcenter/restic.env` in the password manager of the team.

   WARNING: Without `RESTIC_PASSWORD`, no backup can be restored. A lost host also loses this file.

4. Make sure that the modes are correct: `sudo ls -l /etc/botcenter`. Each `.env` file must be `-rw-------` and belong to root.
5. Make sure that `compose.env` has `BOTCENTER_JOURNAL_GID` (the number of `getent group systemd-journal`). Alloy runs as uid 473 and gets only this group, so it reads the container logs and no secret (SEC-07).

Optional: SOPS and age. Keep the env files encrypted in a private infrastructure repository:

1. Make an age key on the host: `sudo age-keygen -o /etc/botcenter/age.key` (mode 600). Put the public key in `.sops.yaml` of the infrastructure repository.
2. Encrypt each env file: `sops --encrypt --input-type dotenv --output-type dotenv api.env > api.sops.env`.
3. On the host, decrypt to `/etc/botcenter`: `SOPS_AGE_KEY_FILE=/etc/botcenter/age.key sops --decrypt api.sops.env > /etc/botcenter/api.env`.
4. Never commit a decrypted file.

## 7. First deploy

1. Do procedures 2 to 6.
2. Write the Cloudflare snippet and the firewall rules:

   ```sh
   sudo bash -c 'set -a; . /etc/botcenter/firewall.env; set +a; /opt/botcenter/infra/host/firewall-cloudflare.sh'
   ```

   With `FIREWALL_BACKENDS=docker-user`, the rules are in the `DOCKER-USER` chain of the host. The script also adds the chain `BOTCENTER-EVO`: the egress rules of the Evolution container (SEC-01). It loads `br_netfilter` and sets `net.bridge.bridge-nf-call-iptables=1`, because the traffic between two containers of one network passes `DOCKER-USER` only with this setting. For a second layer, also set `hcloud` and `HCLOUD_TOKEN` (a token of the Bot Center project). The Hetzner Cloud Firewall then allows only 443 from Cloudflare, UDP 41641 (Tailscale), and ICMP.
3. Initialize the restic repository (one time):

   ```sh
   sudo bash -c 'set -a; . /etc/botcenter/backup.env; set +a; /opt/botcenter/infra/backup/restic.sh init'
   ```

4. Set the image in `/etc/botcenter/compose.env`: `BOTCENTER_IMAGE=ghcr.io/<owner>/botcenter-api:<tag>@sha256:<digest>`. The release workflow prints the value (procedure 11).
5. If the GHCR package is private, log in to GHCR on the host with a read-only token: `sudo docker login ghcr.io -u <user>` (token with `read:packages` only).
6. Deploy the release:

   ```sh
   sudo /opt/botcenter/infra/scripts/deploy.sh <tag> <image with digest>
   ```

   The script checks out the tag, runs the migrations (`migrate`), starts the stack, and waits for the health checks.
7. Make sure that every service is healthy: `bc ps`. `migrate` shows `Exited (0)`.
8. Check the public routes from your computer:
   - `curl -s https://<api host>/health/ready` answers `{"status":"ok",...}`.
   - `curl -s -o /dev/null -w '%{http_code}' https://<api host>/metrics` answers `404`.
   - `curl -s -o /dev/null -w '%{http_code}' https://<api host>/internal/evolution/webhook` answers `404`.
   - `curl -s -D - -o /dev/null -H 'Origin: https://app.personallife.com.br' https://<api host>/v1/connect/ct_test/events` answers `401` with the header `access-control-allow-origin: https://app.personallife.com.br`. Use the origin of `CONNECT_ALLOWED_ORIGINS`.
9. Turn on the timers:

   ```sh
   sudo systemctl enable --now botcenter-backup.timer botcenter-restore-test.timer \
     botcenter-disk-check.timer botcenter-evolution-retention.timer botcenter-cloudflare-firewall.timer
   sudo systemctl enable botcenter-firewall-boot.service
   systemctl list-timers 'botcenter-*'
   ```

   `botcenter-firewall-boot.service` applies the `DOCKER-USER` rules after each boot, before `docker.service` starts. It has no network, so it uses the last Cloudflare ranges of the Caddy snippet. Set `PUBLIC_INTERFACE` in `firewall.env` (Hetzner: `eth0`).

10. Run the first backup and the first restore test by hand:

    ```sh
    sudo systemctl start botcenter-backup.service && journalctl -u botcenter-backup.service -n 30
    sudo systemctl start botcenter-restore-test.service && journalctl -u botcenter-restore-test.service -n 30
    ```

11. Do procedure 8 (Uptime Kuma).

## 8. Uptime Kuma

1. Open the UI (section 0). Make the admin account. Use a long password and keep it in the password manager.
2. Settings > Notifications: add a Discord notification with the webhook of the operations channel. Set it as the default.
3. Add these monitors:

   | Type | Name | Target | Interval |
   | --- | --- | --- | --- |
   | HTTP(s) | API ready (internal) | `http://api:3000/health/ready` | 30 s |
   | HTTP(s) | API ready (public) | `https://<api host>/health/ready` | 60 s |
   | HTTP(s) - Keyword | Edge blocks /internal | `https://<api host>/internal/evolution/webhook`, expect status 404 | 300 s |
   | Push | Backup | heartbeat interval 26 h (93600 s) | — |
   | Push | Restore test | heartbeat interval 32 days | — |

4. Copy the push URL of "Backup". Change the host part to `http://127.0.0.1:3001` and write it in `KUMA_PUSH_URL_BACKUP` of `/etc/botcenter/backup.env`. Do the same for "Restore test" (`KUMA_PUSH_URL_RESTORE_TEST`).
5. Run the backup service again (procedure 7, step 10). Make sure that the "Backup" monitor shows "Up".

## 9. Create the first tenant and API key

The admin CLI runs in the `api` container. Each command writes an audit row.

1. Make the tenant:

   ```sh
   bc exec api node dist/scripts/admin.js tenant:create --name PersonalLife --slug personallife
   ```

2. Make a key for the backend of the product. Give only the scopes that it needs:

   ```sh
   bc exec api node dist/scripts/admin.js key:create --tenant personallife --name backend \
     --scopes messages:send,instances:manage,bots:write,events:read
   ```

3. Copy the key (`bc_live_...`) from the output. The database keeps only its hash, so you cannot read it again. Send it to the product team through the password manager, not through chat or e-mail.
4. Change the quotas when necessary: `bc exec api node dist/scripts/admin.js tenant:update-quotas --tenant personallife ...` (`--help` shows the options).

The same commands exist as pnpm scripts of `@botcenter/api` (`admin:tenant:create`, `admin:key:create`, `admin:key:list`, `admin:key:revoke`, `admin:key:rotate`) for a local run.

## 10. Connect a test number

Use a test number, never a personal number of a team member.

1. Make an instance for a test owner:

   ```sh
   curl -s -X POST https://<api host>/v1/instances \
     -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -H "Idempotency-Key: $(uuidgen)" \
     -d '{"external_ref":"runbook-test","consent_at":"2026-10-19T12:00:00Z"}'
   ```

2. Start the connection with a pairing code (the phone is the only device):

   ```sh
   curl -s -X POST https://<api host>/v1/instances/<id>/connect \
     -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -H "Idempotency-Key: $(uuidgen)" \
     -d '{"method":"pairing_code","phone":"55119XXXXXXXX"}'
   ```

3. Open the `events_url` of the answer (`curl -N <events_url>`). Read the 8-character code.
4. On the phone: WhatsApp > Linked devices > Link a device > Link with phone number. Type the code.
5. Make sure that the SSE stream sends the status `connected` and that `GET /v1/instances/<id>` shows `connected`.
6. Send a message to a second test number with `POST /v1/messages`. Make sure that `GET /v1/messages/<id>` goes to `sent`, then `delivered`.
7. After the test, delete the instance: `DELETE /v1/instances/<id>`.

## 11. Deploy a release

1. Merge `develop` into `main` and tag the release (`vX.Y.Z`). Push the tag.
2. The `Release` workflow builds the image, scans it with Trivy, and pushes it to GHCR only when the scan passes. Then it attests the build provenance. Its summary shows the image with the digest and the deploy command.
3. Read the migrations of the release. A migration must be backward compatible (add columns and tables; remove them in a later release), because a rollback does not revert a migration.
4. Deploy. Use one of the two methods:
   - Over Tailscale SSH: first verify the attestation on your computer: `gh attestation verify oci://ghcr.io/<owner>/botcenter-api:vX.Y.Z@sha256:<digest> --repo <owner>/botcenter`. Then run `sudo /opt/botcenter/infra/scripts/deploy.sh vX.Y.Z ghcr.io/<owner>/botcenter-api:vX.Y.Z@sha256:<digest>`.
   - With the `deploy` job of the `Release` workflow (Actions > Release > Run workflow, with the tag and the image). The environment `production` needs the approval of a reviewer. The job accepts only `ghcr.io/<owner>/botcenter-api:<tag>@sha256:<digest>` and verifies the attestation.

   `deploy.sh` accepts only `BOTCENTER_IMAGE_REPOSITORY` of `/etc/botcenter/compose.env` with the release tag (SEC-12). Set it once: `BOTCENTER_IMAGE_REPOSITORY=ghcr.io/<owner>/botcenter-api`.
   CAUTION: When a release changes the Compose networks (for example the fixed subnets of `v0.1.0`), `up -d` cannot change a network that exists. Stop the stack first in a period with low traffic: `bc down` (the volumes stay), then run `deploy.sh`.

5. The script stops with an alert when a health check fails. Then do a rollback: run `deploy.sh` with the previous tag and the previous image (the alert and `/etc/botcenter/compose.env.previous` have it).
6. The workers stop with a graceful shutdown (`stop_grace_period: 30s`, `SHUTDOWN_TIMEOUT_MS=25000`): they finish the current job and return the rest to the queue.

## 12. Update the Evolution API

A change of Baileys can break every connection. Renovate opens the update only after an approval on the Dependency Dashboard, with the label `needs-test-host`.

1. Read the release notes of the new version. Find the changes of the environment flags: compare `.env.example` and `src/config/env.config.ts` of the new tag with `infra/compose/evolution.flags.env`.
2. Make a test host: a CX22 in the same project, `botcenter-test-1`. Do procedures 2, 6, and 7 with a test domain. Use a separate R2 bucket for the test backups.
3. On the test host, deploy the current release. Connect two test numbers (procedure 10).
4. Change the Evolution image (tag and digest) in `infra/compose/compose.prod.yml` on a branch. Get the digest from Docker Hub: `docker buildx imagetools inspect evoapicloud/evolution-api:<tag>`.
5. Deploy the branch to the test host: `git checkout <branch>` in `/opt/botcenter`, then `bc pull evolution && bc up -d evolution`.
6. Make sure that the two test numbers reconnect without a new QR code, and that a send and a receive work. Watch them for 24 hours: no disconnect, no `InstanceDisconnected` alert.
7. Run the load test against the test host (`tests/load/README.md`). Compare the memory for each connected instance.
8. Merge the branch and make a release (procedure 11).

   CAUTION: Update production in a period with low traffic. The Evolution restart disconnects every number for some seconds.

9. Delete the test host when you do not need it (or keep it stopped; a stopped server still costs money).

## 13. Rotate secrets and API keys

### 13.1 API key of a client

1. Make the new key while the old key is still active: `bc exec api node dist/scripts/admin.js key:rotate --key <prefix>`. The two keys work at the same time.
2. Send the new key to the client team. Wait until the client uses it (`key:list` shows `last_used_at`).
3. Revoke the old key: `bc exec api node dist/scripts/admin.js key:revoke --key <old prefix>`. The revocation removes the key from the Redis cache at once.

### 13.2 Leaked API key

1. Revoke the key at once (`key:revoke`).
2. Read the audit log and the messages of the key in the period. Tell the owner of the tenant.
3. Make a new key (`key:create`) with the same scopes.

### 13.3 PostgreSQL passwords

1. Make a new value: `openssl rand -hex 32`.
2. Change the role password:

   ```sh
   bc exec postgres psql -U postgres -c "ALTER ROLE botcenter_app PASSWORD '<new value>'"
   ```

3. Change the value in every file that uses it: `botcenter_app` in `api.env` and `postgres.env`; `botcenter_owner` in `migrate.env` and `postgres.env`; `evolution` in `evolution.env` and `postgres.env`.
4. Restart the services that use it: `bc up -d --force-recreate api worker` (or `evolution`).

### 13.4 Redis password, Evolution API key, internal webhook secret

A host that has env files from before the Redis users (SEC-11): `gen-secrets.sh` does not change existing files. Add `REDIS_BOTCENTER_PASSWORD`, `REDIS_EVOLUTION_PASSWORD`, and `REDIS_METRICS_PASSWORD` (each `openssl rand -hex 32`) to the files of step 2 by hand. Redis does not start while a value is missing.

1. Make a new value: `openssl rand -hex 32`.
2. Change it in every file:
   - Redis passwords (one ACL user for each client, SEC-11):
     - `default` (`REDIS_PASSWORD`): `redis.env` only.
     - `botcenter` (`REDIS_BOTCENTER_PASSWORD`): `redis.env` and `api.env` (`REDIS_URL`).
     - `evolution` (`REDIS_EVOLUTION_PASSWORD`): `redis.env` and `evolution.env` (`CACHE_REDIS_URI`).
     - `metrics` (`REDIS_METRICS_PASSWORD`): `redis.env` and `alloy.env`.
   - Evolution API key: `evolution.env` (`AUTHENTICATION_API_KEY`) and `api.env` (`EVOLUTION_API_KEY`).
   - Internal webhook secret: `api.env` (`EVOLUTION_WEBHOOK_SECRET`).
3. Restart: `bc up -d --force-recreate redis evolution api worker alloy`.

   CAUTION: The restart stops the queues and the WhatsApp connections for some seconds. The jobs stay in Redis (AOF).

4. After a change of the internal webhook secret, each instance must get the new secret (the provider sets the webhook again for each instance). Until then, Evolution sends the old secret and the API answers 401. See the open problems of the release.

### 13.5 API key pepper and data encryption key

WARNING: A change of `API_KEY_PEPPER` makes every API key invalid. A change of `DATA_ENCRYPTION_KEY` makes the stored webhook secrets unreadable. Release `v0.1.0` has no rotation command for them. Change them only after a leak, then issue new API keys and new webhook subscriptions for every tenant.

## 14. Restore from a backup

Use this procedure after a loss of the database or the host. The WhatsApp sessions are in the `evolution` database, so the numbers reconnect without a new QR code.

1. If the host is lost, make a new host (procedures 1 to 6). Use the same `restic.env` (from the password manager) and the same secrets of `postgres.env`, `api.env`, and `evolution.env` if you have them.
2. List the snapshots:

   ```sh
   sudo bash -c 'set -a; . /etc/botcenter/backup.env; set +a; /opt/botcenter/infra/backup/restic.sh snapshots --tag postgres'
   ```

3. Restore the latest snapshot (or a snapshot id) to a directory:

   ```sh
   sudo mkdir -m 700 -p /var/lib/botcenter/backup-work/restore
   sudo bash -c 'set -a; . /etc/botcenter/backup.env; set +a; /opt/botcenter/infra/backup/restic.sh \
     --data /var/lib/botcenter/backup-work/restore restore latest --tag postgres --target /data'
   ls -l /var/lib/botcenter/backup-work/restore/data
   ```

4. Stop the services that write to the databases:

   ```sh
   bc stop api worker evolution
   ```

5. Restore each database. The roles exist (the init script made them), so the owners and the grants come back.

   WARNING: `--clean` deletes the current objects of the database before the restore.

   ```sh
   for db in botcenter evolution; do
     sudo docker exec -i "$(bc ps -q postgres)" pg_restore -U postgres -d "$db" --clean --if-exists \
       --exit-on-error < "/var/lib/botcenter/backup-work/restore/data/$db.dump"
   done
   ```

6. Start the services: `bc up -d`. The `migrate` service applies the migrations that are newer than the backup.
7. Make sure that `bc ps` shows every service healthy and that the instances go to `connected` (`GET /v1/instances`).
8. Delete the restored files: `sudo rm -rf /var/lib/botcenter/backup-work/restore`.
9. The messages and the events after the backup are lost (at most 24 hours). Tell the tenants. When this loss is not acceptable, move to continuous WAL archiving (pgBackRest or WAL-G).

## 15. Scale up

1. Read the trigger that occurred (procedure 1). Make sure that it is not a fault (for example, a loop in a bot or a stuck queue).
2. Announce a short stop (some minutes) to the tenants.
3. In the Hetzner console: Power off `botcenter-prod-1`. Rescale > CX32. Keep the disk size ("CPU and RAM only"), so that you can go back.
4. Power on. Connect through Tailscale.
5. Remove the CX22 profile: set `BOTCENTER_COMPOSE_EXTRA_FILES=` (empty) in `/etc/botcenter/compose.env`.
6. Apply the new memory limits: `bc up -d`.
7. Make sure that `bc ps` shows every service healthy, and that the instances reconnect.

The next step after the CX32 is phase 2 and phase 3 of the architecture (a second host and the routing of numbers to hosts). That needs a new plan.

## 16. Reboot the host

unattended-upgrades installs the security updates but does not reboot. Do this check each week.

1. Check: `test -f /var/run/reboot-required && cat /var/run/reboot-required.pkgs`.
2. If a reboot is necessary, select a period with low traffic.
3. Reboot: `sudo reboot`. `botcenter-firewall-boot.service` applies the `DOCKER-USER` rules with the last known Cloudflare ranges before Docker starts. Docker then starts the stack again (`restart: unless-stopped`). The firewall timer gets the current ranges 30 seconds after the boot.

4. Make sure that `bc ps` shows every service healthy and that `sudo iptables -S DOCKER-USER` shows the jumps to `BOTCENTER-CF` and `BOTCENTER-EVO`.

## 17. Incident procedures

### 17.1 Instance disconnected (alerts `InstanceDisconnected`, `InstanceDisconnectedLong`)

1. Find the instances: `bc exec postgres psql -U postgres -d botcenter -c "SELECT id, \"externalRef\", status, \"disconnectedSince\" FROM instances WHERE status IN ('connecting','disconnected') AND \"disconnectedSince\" IS NOT NULL AND \"deletedAt\" IS NULL"`. The alert counts the instances that were connected and are `connecting` or `disconnected` for more than 2 minutes (metric `botcenter_instance_incidents`).
2. Read the Evolution log of the period: `bc logs --since 30m evolution`. Look for `connection.update` with a status code.
3. If all instances are disconnected, the cause is the Evolution API or the network:
   - Check the outbound internet access of the Evolution API: `bc exec evolution node -e "fetch('https://web.whatsapp.com').then((r) => console.log(r.status))"`.
   - Restart the Evolution API: `bc restart evolution`. The sessions are in the database, so the instances reconnect.
   - If the instances do not reconnect after a restart, a WhatsApp change can be the cause. Read the issues of the Evolution repository. Do not delete instances.
4. If one instance is disconnected, `disconnected` reconnects on its own. If it stays disconnected for more than 10 minutes, tell the tenant. The owner must start a new connect flow when the status is `logged_out`. After 24 hours, the incident moves to `age="stale"`: the critical alert resolves and the info alert `InstanceDisconnectedLong` starts. Tell the tenant to connect the number again or to delete the instance.

### 17.2 Queue backlog (alerts `OutboundQueueDelayHigh`, `QueueDelayHigh`)

1. Look at the dashboard (panels "Queue size" and "Queue delay").
2. Check the workers: `bc ps worker` and `bc logs --since 15m worker`.
3. If the worker is not healthy, restart it: `bc restart worker`.
4. If the `outbound` delay grows and the failures are low, the rate limit of the instances can be the cause (a bulk send to one number). This is the expected behavior. Tell the tenant.
5. If the Evolution API answers slowly, check its memory (`docker stats --no-stream`) and the host CPU. Do procedure 15 if a trigger occurred.
6. If Redis refuses writes (`OOM command not allowed` in the logs, alerts `RedisMemoryHigh` and `RedisMemoryCritical`), Redis is full: `noeviction` keeps the jobs. Increase `REDIS_MAXMEMORY` and the Redis memory limit, then `bc up -d redis`. Find the queue that grows.

### 17.3 Number banned (alerts `SendFailureRateHigh`, `InstanceSendFailureRateHigh`, `InstanceLoggedOut`)

1. Find the instance with the failures: the alert `InstanceSendFailureRateHigh` and the panel "Send failure rate of each instance" show the instance id. The logs of the worker show the failure reason.
2. Tell the tenant at once. A banned number cannot send. Only the owner can appeal to WhatsApp.
3. Stop the sends to that instance: the tenant must stop its campaign. Lower the `rateLimitPerMinute` of the instance.
4. Check the opt-in of the recipients and the volume of the tenant. The mitigations of the architecture: rate limit for each number, gradual warm-up of new numbers, typing delay, sends only to users with opt-in.
5. For a critical business number, plan the move to the WhatsApp Cloud API (out of phase 1).

### 17.4 Backup failed or missing (alerts `BackupFailed`, `BackupMissing`)

1. Read the log: `journalctl -u botcenter-backup.service -n 100`.
2. Fix the cause (R2 credentials, disk space, PostgreSQL not healthy).
3. Run the backup again: `sudo systemctl start botcenter-backup.service`.
4. Make sure that the Uptime Kuma monitor "Backup" is "Up" and that `/var/lib/botcenter/metrics/botcenter_backup.prom` shows `botcenter_backup_last_run_success 1`.

### 17.5 Disk full (alerts `HostDiskUsageHigh`, disk-check)

1. Find the large directories: `sudo du -xh --max-depth=2 /var/lib/docker | sort -h | tail`. Check the journal too: `journalctl --disk-usage` (limit 2 GB, `/etc/systemd/journald.conf.d/90-botcenter.conf`).
2. Remove the old images: `sudo docker image prune -a --filter "until=168h"`.

   CAUTION: Do not run `docker volume prune` or `docker system prune --volumes`. They delete the PostgreSQL and Redis data.

3. Check the PostgreSQL size: `bc exec postgres psql -U postgres -c "SELECT datname, pg_size_pretty(pg_database_size(datname)) FROM pg_database"`. Make sure that the retention jobs run (`maintenance` queue, `botcenter-evolution-retention.timer`).
4. If the disk is still above 80 %, add a Hetzner volume or move to a larger server (procedure 15).

### 17.6 Host down (alert `MetricsAbsent`, Uptime Kuma public monitor)

1. Open the Hetzner console. Check the state of the server and its graphs.
2. If the server does not answer, use the web console to read the boot messages. Reboot from the console.
3. If the disk or the server is lost, restore the server from the Hetzner backup (daily snapshot), or make a new host and do procedure 14.

### 17.7 Inbound jobs failed (alert `InboundJobsFailed`)

The Evolution API got `200` for these events, so it does not send them again. Each failed job is a user message that the bot did not store or answer.

1. Find the cause: `bc logs --since 1h worker | grep -i inbound`. Usual causes: PostgreSQL or Redis was not available for a long time, or a data error.
2. Fix the cause. Make sure that `bc ps` shows `postgres`, `redis`, and `worker` healthy.
3. Replay the failed jobs with the admin CLI: `bc exec api node dist/scripts/admin.js --help` shows the replay command of the release.
4. Make sure that the panel "Failed inbound jobs" goes back to 0. The alert then resolves.

### 17.8 Worker not ready (alert `WorkerNotReady`)

The worker process answers, but its readiness probe fails: it cannot reach PostgreSQL or Redis. No job runs.

1. Read the report of the probe: `bc exec worker wget -qO- http://10.203.3.21:9464/health/ready`. Each check shows `up` or `down` and an error code.
2. Check the dependency: `bc ps postgres redis`, then `bc logs --since 15m postgres` or `bc logs --since 15m redis`.
3. Fix the dependency. If the dependency is healthy and the probe still fails, restart the worker: `bc restart worker`.

## 18. Reference

### 18.1 Metrics of the application

The alert rules (`infra/observability/prometheus/alerts.yml`) and the dashboard use these names. Alloy scrapes the API on `api:9465/metrics` and the workers on `worker:9464/metrics`, on the `metrics` network only. The HTTP port of the API (3000) has no `/metrics` route (SEC-01).

| Metric | Type | Labels |
| --- | --- | --- |
| `botcenter_instances` | gauge | `status` |
| `botcenter_instance_incidents` | gauge | `age` (`recent`: 2 minutes to 24 hours; `stale`: 24 hours or more) |
| `botcenter_queue_delay_seconds` | gauge | `queue` |
| `botcenter_queue_size` | gauge | `queue`, `state` |
| `botcenter_messages_total` | counter | `status` |
| `botcenter_instance_messages_total` | counter | `instance_id`, `status` (`sent`, `failed`) |
| `botcenter_webhook_deliveries_total` | counter | `result` (`succeeded`, `failed`, `dead`) |
| `botcenter_bot_webhook_calls_total` | counter | `result` (`succeeded`, `failed`: a retry follows, `dead`) |
| `botcenter_rate_limit_denied_total` | counter | `scope` (`key`, `instance`) |
| `botcenter_worker_ready` | gauge | none (worker process: 1 when PostgreSQL and Redis answer) |
| `http_request_duration_seconds` | histogram | `method`, `route`, `status_code` |

Host scripts (text files in `/var/lib/botcenter/metrics`): `botcenter_host_filesystem_size_bytes{mountpoint}` and `botcenter_host_filesystem_avail_bytes{mountpoint}` (`disk-check.sh`, every 15 minutes; Alloy has no mount of the host root), `botcenter_backup_last_run_success`, `botcenter_backup_last_success_timestamp_seconds`, `botcenter_backup_duration_seconds`, `botcenter_backup_dump_size_bytes{database}`, `botcenter_restore_test_last_run_success`, `botcenter_restore_test_last_success_timestamp_seconds`.

### 18.2 Timers

| Timer | When | Script |
| --- | --- | --- |
| `botcenter-backup.timer` | daily 03:15 UTC | `infra/backup/backup.sh` |
| `botcenter-restore-test.timer` | day 1 of each month, 05:00 UTC | `infra/backup/restore-test.sh` |
| `botcenter-disk-check.timer` | every 15 minutes | `infra/backup/disk-check.sh` |
| `botcenter-evolution-retention.timer` | daily 04:30 UTC | `infra/host/evolution-retention.sh` |
| `botcenter-cloudflare-firewall.timer` | 30 s after boot, then every 6 hours | `infra/host/firewall-cloudflare.sh` |
| `botcenter-firewall-boot.service` (no timer) | each boot, before `docker.service` | `infra/host/firewall-cloudflare.sh --offline` |

### 18.3 Ports

| Port | Where | Who can connect |
| --- | --- | --- |
| 443 (and 80 in ACME mode) | host, Caddy | Cloudflare ranges only (`DOCKER-USER` and Hetzner Cloud Firewall) |
| 127.0.0.1:3001 | host, Caddy to Uptime Kuma | the host only (SSH tunnel) |
| 22 | host, sshd | `tailscale0` only (ufw) |
| 3000 | `api` | Caddy and Uptime Kuma (`edge`), the Evolution webhook (`internal`) |
| 9465 | `api`, address `10.203.3.20` | Alloy (`metrics`): `/metrics` only |
| 9464 | `worker`, address `10.203.3.21` | Alloy (`metrics`): `/metrics`, `/health/live`, `/health/ready` |
| 8080 | `evolution` | `api` and `worker` (`internal`) |
| 5432 | `postgres` | the `internal` network only |
| 6379 | `redis` | `internal` (users `botcenter` and `evolution`), `metrics` (Alloy, user `metrics`) |

The fixed addresses are in `infra/compose/compose.prod.yml` (subnets `10.203.1.0/24` `internal`, `10.203.2.0/24` `egress`, `10.203.3.0/24` `metrics`). The chain `BOTCENTER-EVO` of `DOCKER-USER` limits the Evolution container (`10.203.1.30`, `10.203.2.30`): in the private ranges and `169.254.0.0/16`, it can connect only to PostgreSQL, Redis, and port 3000 of the API. The internet stays open.

### 18.4 Settings of `api.env`

`infra/env/api.env.example` lists every variable of `apps/api/src/config/env.ts` with its default value. A test of `tests/infra` fails when a variable of `env.ts` is not in the template. Compose sets `ROLE`, `PORT`, the metrics listeners, and `NODE_OPTIONS` for each service.

| Variable | Default | Use |
| --- | --- | --- |
| `CONNECT_ALLOWED_ORIGINS` | empty | Browser origins (comma list) that can open `GET /v1/connect/{token}/events`. Required for the connect flow of a frontend. |
| `PUBLIC_BASE_URL` | none in production | The public URL. The connect route builds `events_url` from it. |
| `TRUST_PROXY` | `loopback,linklocal,uniquelocal` | Proxies that Fastify trusts for `X-Forwarded-For`. |
| `BODY_LIMIT_BYTES` | `1048576` | Maximum JSON body of a request. |
| `INTERNAL_WEBHOOK_BODY_LIMIT_BYTES` | `8388608` | Maximum body of the Evolution webhook. |
| `KEEP_ALIVE_TIMEOUT_MS` | `65000` | Keep it above the upstream keep-alive of Caddy (60 s). |
| `SHUTDOWN_TIMEOUT_MS` | `25000` | Maximum time of a graceful shutdown. Keep it below `stop_grace_period` of the service. |
| `EVOLUTION_INTERACTIVE_FALLBACK` | `text` | `text` sends buttons and lists as a numbered menu; `native` sends the native messages. |
| `EVOLUTION_REQUEST_TIMEOUT_MS` | `10000` | Time limit of a state, create, logout, delete, or ping request. |
| `EVOLUTION_CONNECT_TIMEOUT_MS` | `20000` | Time limit of a connect request. |
| `EVOLUTION_SEND_TIMEOUT_MS` | `30000` | Time limit of one send (plus the typing delay). |
| `EVOLUTION_MEDIA_TIMEOUT_MS` | `60000` | Time limit of one media download. |
| `WORKER_CONCURRENCY_OUTBOUND`, `_INBOUND`, `_WEBHOOKS` | `10` | Jobs of the queue that one worker process runs at the same time. |
| `WORKER_CONCURRENCY_TIMERS` | `5` | The same for the `timers` queue. |
| `WORKER_CONCURRENCY_MAINTENANCE` | `1` | The same for the `maintenance` queue (maximum 10). |
| `WORKER_CONCURRENCY_INSTANCES` | `1` | The same for the `instances` queue (maximum 10). |
| `OUTBOUND_BUCKET_BURST` | `3` | Size of the send token bucket of each instance (at most its rate). |
| `OUTBOUND_WARMUP_DAYS` | `7` | Days from the first connection of a number to the full send rate. `0` or `1` turns the warm-up off. |
| `OUTBOUND_WARMUP_START_PERCENT` | `20` | Send rate on the first day of the warm-up, in percent of the full rate. |
| `MEDIA_UPLOAD_URL_TTL_SECONDS` | `900` | Validity of the upload URL of `POST /v1/media` (maximum 3600). |
| `MEDIA_SEND_URL_TTL_SECONDS` | `900` | Validity of the download URL that the Evolution API gets for a media message. |
| `INBOUND_MEDIA_DOWNLOAD_CONCURRENCY` | `2` | Inbound media downloads of one worker at the same time (maximum 10; about 60 MiB each). |
| `BOT_INBOUND_LIMIT_PER_MINUTE` | `30` | Messages of one contact on one instance in one minute that the bot answers. The worker stores the others. |
| `BOT_MAX_TIMEOUTS_IN_ROW` | `3` | State timeouts in a row without an inbound message. After the last one, no timer starts. |
| `EXTERNAL_HTTP_ALLOW_PRIVATE` | `false` | Test and development only. The API refuses to start with `true` in production. |
| `EXTERNAL_HTTP_MAX_RESPONSE_BYTES` | `1048576` | Maximum response body of an external HTTP call (maximum 16 MiB). |
| `OUTBOX_DISPATCH_INTERVAL_MS` | `1000` | Pause of the outbox dispatcher when no event waits. |
