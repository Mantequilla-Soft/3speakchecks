# Automatic deploys

A PR merged into `main` deploys itself to both production checkers once **Tests** has passed for that commit (`.github/workflows/deploy.yml`):

1. **US** (`checker-us.3speak.tv`, replica, `BACKGROUND_JOBS=false`) goes first, as the canary.
2. **Helsinki** (`checker.3speak.tv`, the primary that runs payouts and Hive broadcasts) follows, but only if the US deploy succeeded.

The Action can do exactly one thing on each box: SSH as `deploy-checker`, whose key is forced to `checker-deploy-entry`. That allows only `deploy <sha>` or `check <sha>` and calls `sudo /usr/local/sbin/checker-deploy`.

## What `checker-deploy` does

- **Deploys exactly the tested commit.** It must be on `origin/main`. It never deploys a newer, untested tip, and never goes backwards (an older commit is a no-op).
- **Keeps local patches.** Files listed in `ALLOWED_LOCAL` (today only `routes/adServe.js`, the temporary ad caps-off switch) keep their patch. If upstream changed one of those files, it **refuses**, and a human merges it by hand. Any other local edit to a tracked file also refuses.
- **Checks before touching disk.** Every changed JS file gets `node --check`. `npm ci --omit=dev` runs only when a package file changed.
- **Restarts and smoke tests.** It checks `/health/latency` (`primary` must match the box), `/healthz`, `/feeds/new`, `/feeds/trending` and `/audio/creators`, then confirms the unit stays up for 20 s.
- **Rolls back** to the previous commit on any failure (`git reset --keep`, patches intact).
- 🚨 **A replica that reports `primary:true` is STOPPED** and left stopped, because it would be running payouts and broadcasts a second time.

Each box has its own settings in `/etc/checker-deploy.conf`: checkout, unit, user, port and `EXPECT_PRIMARY`. Each box also has a log at `/var/log/checker-deploy.log` and records the last deployed commit in `/var/lib/checker-deploy/deployed_sha`.

## Setup (once, as root)

```bash
# 1. Helsinki: creates the key, the GitHub environment `checker-production`, prints a public key line
sudo US_HOST=15.204.229.29 US_SSH_PORT=<US sshd port> bash deploy/setup.sh helsinki
# 2. US box (git pull first): installs the same user + script with that public key
sudo bash deploy/setup.sh us '<the line printed by step 1>'
# 3. merge the PR adding deploy.yml, then Actions > Deploy > Run workflow > mode: check
```

Run setup **before** the workflow reaches `main`, or the first run fails (no environment yet). The US step prints its host key fingerprint, and it must match the one the Helsinki step pinned.

## Manual runs

Go to Actions > Deploy > Run workflow:

- `mode: check` verifies both boxes and changes nothing.
- `mode: deploy` deploys the selected `main` commit.
- `target` limits the run to one box.

## Tests

`bash deploy/tests/run.sh` runs a sandbox (throwaway git origin, stubbed systemctl, curl and npm). It also runs in CI as part of Tests.

Changing `deploy/checker-deploy` in the repo does **not** change the installed copy. Re-run `setup.sh` on each box to install a new version.
