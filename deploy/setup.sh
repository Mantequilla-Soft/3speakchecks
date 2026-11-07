#!/usr/bin/env bash
# One-time setup for automatic checker deploys (merged PR on main -> both prod checkers).
#
#   From a checkout of this repo (deploy/ folder), as root.
#   1. On Helsinki:
#        sudo US_HOST=15.204.229.29 US_SSH_PORT=<US sshd port> bash deploy/setup.sh helsinki
#      prints a public key line.
#   2. On the US box (git pull first, so deploy/ is there):
#        sudo bash deploy/setup.sh us 'restrict,command=... ssh-ed25519 AAAA... github-actions@...'
#   3. Merge the PR that adds .github/workflows/deploy.yml, then run Actions > Deploy > check.
#
# Each box gets:
#   1. system user `deploy-checker`: password locked, key only, no forwarding/tty/shell,
#      its key forced to /usr/local/sbin/checker-deploy-entry ("deploy <sha>" / "check <sha>")
#   2. /usr/local/sbin/checker-deploy (root-owned) + sudoers rule for exactly that script
#   3. /etc/checker-deploy.conf (which checkout, unit, user, port, primary or replica)
#   4. sshd drop-in with the per-user restrictions (`sshd -t` before reload)
# Helsinki also creates the key pair and the GitHub environment `checker-production` on
# Mantequilla-Soft/3speakchecks (usable only from `main`): secrets DEPLOY_SSH_KEY +
# DEPLOY_KNOWN_HOSTS, variables HELSINKI_HOST/PORT, US_HOST/PORT, DEPLOY_USER. The local
# private key is deleted afterwards.
#
# Safe to re-run. A Helsinki re-run rotates the key: run the US step again with the new line.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
USER_NAME=deploy-checker
REPO_GH=Mantequilla-Soft/3speakchecks
ENV_NAME=checker-production
role="${1:-}"

[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }
case "$role" in helsinki|us) ;; *) echo "usage: setup.sh helsinki | setup.sh us '<public key line>'"; exit 1 ;; esac

if [ "$role" = helsinki ]; then
  REPO=/mnt/HC_Volume_103240961/prodops/services/3speakchecks
  UNIT=prod-3speakchecks; RUN_AS=prodops; PORT=3131; EXPECT_PRIMARY=true
  NODE_BIN=/mnt/HC_Volume_103240961/prodops/.nvm/versions/node/v22.22.3/bin
  HOST_IP=65.109.133.80; SSH_PORT=23051
  : "${US_HOST:?set US_HOST (the US box address)}"
  : "${US_SSH_PORT:?set US_SSH_PORT (the US box sshd port)}"
  command -v gh >/dev/null || { echo "gh CLI missing"; exit 1; }
  gh auth status >/dev/null 2>&1 || { echo "gh is not logged in for root"; exit 1; }
else
  REPO=/opt/checker/3speakchecks
  UNIT=checker-us; RUN_AS=checker; PORT=3131; EXPECT_PRIMARY=false
  NODE_BIN=$(dirname "$(command -v node)")
  PUBLINE="${2:-}"
  [[ "$PUBLINE" =~ ^restrict,command=\"/usr/local/sbin/checker-deploy-entry\"\ ssh-ed25519\ [A-Za-z0-9+/=]+\ [^[:space:]]+$ ]] \
    || { echo "pass the public key line printed by the Helsinki step, in single quotes"; exit 1; }
fi
[ -d "$REPO/.git" ] || { echo "$REPO is not a git checkout"; exit 1; }
systemctl cat "$UNIT" >/dev/null || { echo "unit $UNIT not found"; exit 1; }
[ -x "$NODE_BIN/node" ] && [ -x "$NODE_BIN/npm" ] || { echo "node/npm not in $NODE_BIN"; exit 1; }

echo "==> 1. user"
if ! id "$USER_NAME" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "/home/$USER_NAME" --shell /bin/bash \
    --comment "GitHub Action deploys of the checker (forced command only)" "$USER_NAME"
fi
passwd -l "$USER_NAME" >/dev/null

echo "==> 2. scripts + sudoers"
install -o root -g root -m 0755 "$HERE/checker-deploy" /usr/local/sbin/checker-deploy
install -o root -g root -m 0755 "$HERE/checker-deploy-entry" /usr/local/sbin/checker-deploy-entry
tmp_sudo=$(mktemp)
cat > "$tmp_sudo" <<EOF
# The checker deploy user may run the deploy script with one of its two verbs, nothing else.
# The script itself validates the commit argument (40 lowercase hex characters).
$USER_NAME ALL=(root) NOPASSWD: /usr/local/sbin/checker-deploy deploy *, /usr/local/sbin/checker-deploy check *
Defaults:$USER_NAME !requiretty
EOF
visudo -cf "$tmp_sudo" >/dev/null
install -o root -g root -m 0440 "$tmp_sudo" /etc/sudoers.d/deploy-checker
rm -f "$tmp_sudo"
visudo -c >/dev/null

echo "==> 3. /etc/checker-deploy.conf"
cat > /etc/checker-deploy.conf <<EOF
# Read by /usr/local/sbin/checker-deploy (parsed as KEY=VALUE, never sourced).
NAME=$role
REPO=$REPO
UNIT=$UNIT
RUN_AS=$RUN_AS
NODE_BIN=$NODE_BIN
PORT=$PORT
# true = this box runs the background jobs (payouts, broadcasts). Exactly ONE box.
EXPECT_PRIMARY=$EXPECT_PRIMARY
# Tracked files that may carry a local patch (the TEMPORARY ad caps-off switch).
ALLOWED_LOCAL="routes/adServe.js"
EOF
chmod 0644 /etc/checker-deploy.conf
# The deploy runs git and npm as the service user, so it must own the whole checkout
# (a few files were root-owned from earlier hand deploys).
n_foreign=$(find "$REPO" -not -user "$RUN_AS" -not -path "$REPO/.env" | wc -l)
if [ "$n_foreign" -gt 0 ]; then
  echo "   chown $n_foreign file(s) in $REPO to $RUN_AS"
  chown -R "$RUN_AS:$RUN_AS" "$REPO"
fi

echo "==> 4. sshd restrictions"
cat > /etc/ssh/sshd_config.d/61-deploy-checker.conf <<EOF
# Checker deploy user: key only, one forced command, nothing else.
Match User $USER_NAME
    AuthenticationMethods publickey
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    AllowTcpForwarding no
    AllowStreamLocalForwarding no
    AllowAgentForwarding no
    X11Forwarding no
    PermitTTY no
    PermitUserRC no
    ForceCommand /usr/local/sbin/checker-deploy-entry
# Close the Match block, so nothing included after this file is scoped to the deploy user.
Match all
EOF
sshd -t
systemctl reload ssh 2>/dev/null || systemctl reload sshd
if sshd -T 2>/dev/null | grep -qiE '^(allowusers|allowgroups) '; then
  sshd -T | grep -iE '^(allowusers|allowgroups) ' | grep -qw "$USER_NAME" \
    || { echo "!! sshd has AllowUsers/AllowGroups: add $USER_NAME there, or the Action cannot log in"; exit 1; }
fi
install -d -o "$USER_NAME" -g "$USER_NAME" -m 0700 "/home/$USER_NAME/.ssh"

if [ "$role" = us ]; then
  printf '%s\n' "$PUBLINE" > "/home/$USER_NAME/.ssh/authorized_keys"
  chown "$USER_NAME:$USER_NAME" "/home/$USER_NAME/.ssh/authorized_keys"
  chmod 0600 "/home/$USER_NAME/.ssh/authorized_keys"
  echo "==> 5. self-test"
  if SSH_ORIGINAL_COMMAND=id /usr/local/sbin/checker-deploy-entry 2>/dev/null; then echo "!! entry ran an arbitrary command"; exit 1; fi
  echo "   arbitrary command refused: ok"
  tip=$(runuser -u "$RUN_AS" -- git -C "$REPO" ls-remote origin refs/heads/main | cut -f1)
  runuser -u "$USER_NAME" -- sudo -n /usr/local/sbin/checker-deploy check "$tip"
  echo
  echo "Done. This box's host key (compare with what the Helsinki step pinned):"
  ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
  exit 0
fi

echo "==> 5. key pair"
keydir=$(mktemp -d)
trap 'rm -rf "$keydir"' EXIT
ssh-keygen -q -t ed25519 -N '' -C "github-actions@$REPO_GH" -f "$keydir/id"
publine="restrict,command=\"/usr/local/sbin/checker-deploy-entry\" $(cut -d' ' -f1,2 "$keydir/id.pub") github-actions@$REPO_GH"
printf '%s\n' "$publine" > "/home/$USER_NAME/.ssh/authorized_keys"
chown "$USER_NAME:$USER_NAME" "/home/$USER_NAME/.ssh/authorized_keys"
chmod 0600 "/home/$USER_NAME/.ssh/authorized_keys"
printf '%s\n' "$publine" > "$HERE/deploy-checker.pub.line"

echo "==> 6. known hosts (Helsinki from its own key, US via ssh-keyscan)"
known_h="[$HOST_IP]:$SSH_PORT $(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)"
us_key=$(ssh-keyscan -T 10 -t ed25519 -p "$US_SSH_PORT" "$US_HOST" 2>/dev/null | grep -v '^#' | head -1 | cut -d' ' -f2,3)
[ -n "$us_key" ] || { echo "ssh-keyscan of $US_HOST:$US_SSH_PORT returned nothing"; exit 1; }
if [ "$US_SSH_PORT" = 22 ]; then known_u="$US_HOST $us_key"; else known_u="[$US_HOST]:$US_SSH_PORT $us_key"; fi
echo "   pinned US host key: $(printf '%s\n' "$known_u" | ssh-keygen -lf - | cut -d' ' -f2)  (the US step prints its own; they must match)"

echo "==> 7. GitHub environment + secrets"
gh api -X PUT "repos/$REPO_GH/environments/$ENV_NAME" --silent \
  -F 'deployment_branch_policy[protected_branches]=false' \
  -F 'deployment_branch_policy[custom_branch_policies]=true'
if ! gh api "repos/$REPO_GH/environments/$ENV_NAME/deployment-branch-policies" -q '.branch_policies[].name' | grep -qx main; then
  gh api -X POST "repos/$REPO_GH/environments/$ENV_NAME/deployment-branch-policies" --silent -f name=main -f type=branch
fi
gh secret set DEPLOY_SSH_KEY --env "$ENV_NAME" -R "$REPO_GH" < "$keydir/id"
printf '%s\n%s\n' "$known_h" "$known_u" | gh secret set DEPLOY_KNOWN_HOSTS --env "$ENV_NAME" -R "$REPO_GH"
gh variable set HELSINKI_HOST --env "$ENV_NAME" -R "$REPO_GH" --body "$HOST_IP"
gh variable set HELSINKI_PORT --env "$ENV_NAME" -R "$REPO_GH" --body "$SSH_PORT"
gh variable set US_HOST --env "$ENV_NAME" -R "$REPO_GH" --body "$US_HOST"
gh variable set US_PORT --env "$ENV_NAME" -R "$REPO_GH" --body "$US_SSH_PORT"
gh variable set DEPLOY_USER --env "$ENV_NAME" -R "$REPO_GH" --body "$USER_NAME"

echo "==> 8. self-test (Helsinki, over ssh with the new key)"
kh=$(mktemp); printf '[127.0.0.1]:%s %s\n' "$SSH_PORT" "$(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)" > "$kh"
sshq() { ssh -i "$keydir/id" -p "$SSH_PORT" -o IdentitiesOnly=yes -o UserKnownHostsFile="$kh" -o StrictHostKeyChecking=yes -o BatchMode=yes "$USER_NAME@127.0.0.1" "$@"; }
if sshq id 2>/dev/null; then echo "!! the key could run an arbitrary command"; exit 1; fi
echo "   arbitrary command refused: ok"
tip=$(runuser -u "$RUN_AS" -- git -C "$REPO" ls-remote origin refs/heads/main | cut -f1)
sshq "check $tip"
rm -f "$kh"

echo
echo "Done. The private key now lives only in the GitHub environment '$ENV_NAME'."
echo "Next, on the US box (as root, with this folder copied there):"
echo "  sudo bash setup.sh us '$publine'"
echo "(also saved in $HERE/deploy-checker.pub.line)"
