# Private attachment scanner

`railway.json` records the intended configuration for the private ClamAV service.
The official ClamAV 1.4.6 image runs one instance in each Railway environment in
US East. The service has no public domain or TCP proxy; `clamd` listens on port
3310 inside the environment's private network. A 4 GB memory and 2 vCPU limit
provides room for the signature database. `freshclam` refreshes signatures and
ClamAV checks files against bounded archive and scan limits. Scan failures and
signatures older than 48 hours keep attachments unavailable.

Runtime settings are kept in Infisical under `/mailflow-core`: `CLAMAV_HOST` is
`mailflow-attachment-scanner.railway.internal`, `CLAMAV_PORT` is `3310`, and
`CLAMAV_TIMEOUT_MS` is `30000`. The local development command overrides the host
to `127.0.0.1` after Infisical injection and uses the local Compose scanner.
Railway API services also have these values set directly with deployment skipped;
verify Infisical Secret Sync propagation and keep the direct values aligned until
it is confirmed. Neither setting changes the currently deployed application code.

Before enabling attachment traffic, verify each environment from its API service
on the private network: `VERSION` must report current signatures, a benign
INSTREAM must return `OK`, and the EICAR test string must return `FOUND`. Inspect
service logs for successful signature updates, resource limits, and restarts.
The app must fail closed when the scanner cannot respond. These settings provide
resource bounds, not a guarantee that scanned files are safe.

## Listening

Each environment has a separate scanner because Railway private networks are
isolated by environment. A shared public scanner would expose an unauthenticated
ClamAV protocol and was rejected. The pinned patch image makes runtime changes
reviewable; update the image deliberately when upstream releases security fixes.
Capacity, signature freshness, Secret Sync propagation and scanner cost require
operational monitoring.
