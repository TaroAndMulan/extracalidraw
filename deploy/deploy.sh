#!/usr/bin/env bash
# Deploys the whiteboard to your server, from this computer.
#
# The server builds what is on GitHub, so commit and push main first. The
# one-time setup of the server (Docker, deploy/.env, nginx or Caddy) is in
# WHITEBOARD.md; this script updates a server that runs already.
#
# Settings: environment variables, or deploy/.deploy.env (a copy of
# deploy/.deploy.env.example). Options: deploy/deploy.sh --help
#
# It never uses sudo, never removes volumes (all data lives in one), and
# never reads or copies deploy/.env.

set -euo pipefail

readonly IMAGE=extracalidraw-whiteboard # `image:` in docker-compose.yml
readonly SERVICE=whiteboard
readonly BRANCH=main
readonly MIN_MEM_MB=3584        # building the image needs 3–4 GB of free RAM
readonly MIN_DISK_BUILD_MB=4096 # build layers, and the new image next to the old
readonly MIN_DISK_MB=1024
readonly HEALTH_TIMEOUT_S=120

usage() {
  cat <<'EOF'
Usage: deploy/deploy.sh [options]

  (none)         deploy: the server pulls main from GitHub, rebuilds and
                 restarts the app, then it's checked from here
  --status       what runs on the server: commit, health, memory, disk
                 (changes nothing)
  --backup       first back up all data on the server, to
                 ~/whiteboard-backups/whiteboard-<date>-<commit>.tgz
  --rollback     run the image from before the last deploy again
  --ship-image   build the image on this computer and send it over
                 (servers with less than ~3.5 GB of free RAM)
  --dry-run      run the checks and print what would be done; changes nothing
  -h, --help     this help

Settings (environment variables, or deploy/.deploy.env):
  DEPLOY_HOST    ssh target: a Host from ~/.ssh/config, or user@host (required)
  DEPLOY_DIR     the checkout on the server, relative to the home directory
                 (default: extracalidraw)
  DEPLOY_URL     public address, e.g. https://board.example.com, for the
                 checks from here (skipped when empty)
  DEPLOY_PORT    the app's port on the server (default: 3002)
EOF
}

# ---- output -----------------------------------------------------------------

if [[ -t 1 ]]; then
  bold=$'\e[1m' dim=$'\e[2m' red=$'\e[31m' green=$'\e[32m' yellow=$'\e[33m' reset=$'\e[0m'
else
  bold='' dim='' red='' green='' yellow='' reset=''
fi

step() { printf '\n%s==> %s%s\n' "$bold" "$*" "$reset"; }
say() { printf '  %s\n' "$*"; }
ok() { printf '  %s✓%s %s\n' "$green" "$reset" "$*"; }
warn() { printf '  %s!%s %s\n' "$yellow" "$reset" "$*"; }
bad() { printf '  %s✗%s %s\n' "$red" "$reset" "$*"; }
die() {
  printf '\n%s✗ %s%s\n' "$red" "$*" "$reset" >&2
  exit 1
}

# a check that didn't pass: stops, but a dry run goes on to show the rest
fail() {
  bad "$*"
  if ((dry_run)); then
    say "${yellow}(a real run stops here)${reset}"
  else
    die "Stopped before changing anything."
  fi
}

gb() { awk -v mb="${1:-0}" 'BEGIN { printf "%.1f GB", mb / 1024 }'; }

# ---- options and settings ---------------------------------------------------

mode=deploy
backup=0
dry_run=0
set_mode() {
  [[ $mode == deploy ]] || die "--$mode and --$1 don't go together."
  mode=$1
}
for arg in "$@"; do
  case $arg in
    --status) set_mode status ;;
    --rollback) set_mode rollback ;;
    --ship-image) set_mode ship-image ;;
    --backup) backup=1 ;;
    --dry-run) dry_run=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die "Unknown option: $arg (see --help)" ;;
  esac
done
if [[ $mode == status ]] && ((backup)); then
  die "--status only looks; run --backup with a deploy (or --dry-run to see it)."
fi

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(dirname "$here")
config=$here/.deploy.env

# deploy/.deploy.env: KEY=value lines (quotes optional); the environment wins
load_config() {
  local key value
  [[ -f $config ]] || return 0
  while IFS='=' read -r key value || [[ -n $key ]]; do
    case $key in
      '' | '#'*) continue ;;
      DEPLOY_HOST | DEPLOY_DIR | DEPLOY_URL | DEPLOY_PORT) ;;
      *) die "$config: unknown setting '$key'" ;;
    esac
    if [[ $value == \"*\" || $value == \'*\' ]]; then
      value=${value:1:${#value}-2}
    fi
    # (set, even to nothing: `DEPLOY_URL= deploy/deploy.sh` skips the checks)
    if [[ -z ${!key+set} ]]; then
      printf -v "$key" '%s' "$value"
    fi
  done <"$config"
}
load_config

DEPLOY_HOST=${DEPLOY_HOST:-}
DEPLOY_DIR=${DEPLOY_DIR:-extracalidraw}
DEPLOY_DIR=${DEPLOY_DIR#\~/} # ssh starts in the home directory anyway
DEPLOY_URL=${DEPLOY_URL:-}
DEPLOY_URL=${DEPLOY_URL%/}
DEPLOY_PORT=${DEPLOY_PORT:-3002}

[[ -n $DEPLOY_HOST ]] ||
  die "Set DEPLOY_HOST (the ssh target) in deploy/.deploy.env or the environment; see deploy/.deploy.env.example."
[[ $DEPLOY_PORT =~ ^[0-9]+$ ]] || die "DEPLOY_PORT must be a number, not '$DEPLOY_PORT'."

# ---- running things on the server -------------------------------------------

ssh_opts=(-o BatchMode=yes -o ConnectTimeout=15)

# Runs the bash script on stdin on the server, in <checkout>/deploy, with
# $image, $service, $branch, $port and the NAME=value arguments set. (The
# braces make bash read the whole script before running any of it.)
remote() {
  local var
  {
    printf '{\nset -euo pipefail\n'
    printf 'image=%q service=%q branch=%q port=%q\n' "$IMAGE" "$SERVICE" "$BRANCH" "$DEPLOY_PORT"
    for var in "$@"; do
      printf '%s=%q\n' "${var%%=*}" "${var#*=}"
    done
    printf 'cd %q/deploy\n' "$DEPLOY_DIR"
    cat
    printf '\n}\n'
  } | ssh "${ssh_opts[@]}" "$DEPLOY_HOST" bash -s
}

# Like `remote`, for steps that change something: a dry run prints them.
change() {
  local var
  if ((dry_run)); then
    say "${dim}[dry run] would run on $DEPLOY_HOST, in ~/$DEPLOY_DIR/deploy:${reset}"
    for var in "$@"; do
      printf '      %s\n' "$var"
    done
    grep -v '^[[:space:]]*$' | sed 's/^/      /'
  else
    remote "$@"
  fi
}

# Like `change`, for commands on this computer.
run() {
  if ((dry_run)); then
    say "${dim}[dry run] would run here:${reset} $*"
  else
    "$@"
  fi
}

# The scripts below run on the server (quoted here-documents: nothing in them
# is expanded on this computer).

server_facts() {
  cat <<'EOF'
echo "docker=$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo none)"
echo "compose=$(docker compose version --short 2>/dev/null || echo none)"
echo "services=$(docker compose config --services 2>/dev/null | paste -sd ' ' - || true)"
echo "branch=$(git symbolic-ref --short -q HEAD || echo '(detached)')"
echo "head=$(git rev-parse HEAD)"
echo "modified=$(git status --porcelain --untracked-files=no | wc -l | tr -d ' ')"
echo "curl=$(command -v curl >/dev/null && echo yes || echo no)"
echo "arch=$(uname -m)"
echo "mem_mb=$(awk '/^MemAvailable:/ { print int($2 / 1024) }' /proc/meminfo)"
docker_root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo /)
echo "disk_mb=$(df -Pm "$docker_root" | awk 'NR == 2 { print $4 }')"
container=$(docker compose ps -a -q "$service" 2>/dev/null || true)
if [[ -n $container ]]; then
  echo "app=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container")"
else
  echo "app=not running"
fi
previous=$(docker image inspect --format '{{.Created}}' "$image:previous" 2>/dev/null || true)
if [[ -n $previous ]]; then
  previous=$(date -d "$previous" '+%F %H:%M %Z' 2>/dev/null || echo "$previous")
fi
echo "previous=$previous"
EOF
}

server_status() {
  cat <<'EOF'
set +e
when() { date -d "$1" '+%F %H:%M %Z' 2>/dev/null || echo "$1"; }
echo "Checkout:  $(git log -1 --format='%h %s (%cr)') on $(git symbolic-ref --short -q HEAD)"
container=$(docker compose ps -a -q "$service" 2>/dev/null)
if [[ -n $container ]]; then
  state=$(docker inspect --format '{{.State.Status}}{{if .State.Health}}, {{.State.Health.Status}}{{end}}' "$container")
  echo "App:       $state, since $(when "$(docker inspect --format '{{.State.StartedAt}}' "$container")")"
  running=$(docker inspect --format '{{.Image}}' "$container")
  name="$(cut -c8-19 <<<"$running") (untagged)"
  for tag in previous latest; do
    if [[ $(docker image inspect --format '{{.Id}}' "$image:$tag" 2>/dev/null) == "$running" ]]; then
      name=$image:$tag
    fi
  done
  echo "Image:     $name, built $(when "$(docker image inspect --format '{{.Created}}' "$running")")"
else
  echo "App:       not running"
fi
health=$(curl -s --max-time 5 "http://127.0.0.1:$port/api/health")
echo "Health:    ${health:-no answer} (http://127.0.0.1:$port/api/health)"
echo "Services:  $(docker compose config --services 2>/dev/null | paste -sd ' ' -)"
free -m | awk 'NR == 2 { printf "Memory:    %.1f GB free of %.1f GB\n", $7 / 1024, $2 / 1024 }'
docker_root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo /)
df -Pm "$docker_root" | awk 'NR == 2 { printf "Disk:      %.1f GB free of %.1f GB (Docker)\n", $4 / 1024, $2 / 1024 }'
backups=$(ls -1t "$HOME"/whiteboard-backups/*.tgz 2>/dev/null | head -n 3)
echo "Backups:   ${backups:-none in ~/whiteboard-backups}" | sed '2,$s/^/           /'
echo
docker image ls "$image" --format 'table {{.Tag}}\t{{.ID}}\t{{.CreatedSince}}\t{{.Size}}'
echo
docker system df
EOF
}

server_backup() {
  cat <<'EOF'
container=$(docker compose ps -a -q "$service")
volume=""
if [[ -n $container ]]; then
  volume=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$container")
fi
if [[ -z $volume ]]; then
  echo "  can't find the app's data volume: is it running?" >&2
  exit 1
fi
dir=$HOME/whiteboard-backups
name=whiteboard-$(date +%F-%H%M%S)-$(git rev-parse --short HEAD).tgz
mkdir -p "$dir"
# tar runs as root (to read every file), then hands the archive to us
docker run --rm -v "$volume:/data:ro" -v "$dir:/backup" alpine \
  sh -c 'tar czf "/backup/$1" -C /data . && chown "$2" "/backup/$1"' \
  sh "$name.partial" "$(id -u):$(id -g)"
mv "$dir/$name.partial" "$dir/$name"
echo "  $dir/$name ($(du -h "$dir/$name" | cut -f1))"
EOF
}

server_keep_previous() {
  cat <<'EOF'
# the image that runs now becomes :previous, for --rollback
container=$(docker compose ps -a -q "$service")
if [[ -z $container ]]; then
  echo "  nothing runs yet: no image to keep for --rollback"
else
  state=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container")
  if [[ $state != healthy ]] && docker image inspect "$image:previous" >/dev/null 2>&1; then
    echo "  the app is $state now: keeping the older $image:previous for --rollback"
  else
    docker tag "$(docker inspect --format '{{.Image}}' "$container")" "$image:previous"
    echo "  kept the running image as $image:previous (for --rollback)"
  fi
fi
EOF
}

server_pull() {
  cat <<'EOF'
git pull --ff-only --quiet
echo "  checkout: $(git log -1 --oneline)"
if [[ $(git rev-parse HEAD) != "$expected" ]]; then
  echo "  ! GitHub's $branch changed since the checks; that's what gets deployed"
fi
EOF
}

server_start() {
  cat <<'EOF'
docker compose up -d "$build"
# removes untagged images only: :previous stays
docker image prune -f
EOF
}

server_rollback() {
  cat <<'EOF'
docker tag "$image:previous" "$image:latest"
docker compose up -d --no-build
container=$(docker compose ps -q "$service")
if [[ $(docker inspect --format '{{.Image}}' "$container") != "$(docker image inspect --format '{{.Id}}' "$image:previous")" ]]; then
  echo "  ! the app doesn't run $image:previous" >&2
  exit 1
fi
echo "  the app runs $image:previous again"
EOF
}

server_logs() {
  cat <<'EOF'
docker compose logs --tail 80 "$service"
EOF
}

server_wait_healthy() {
  cat <<'EOF'
started=$SECONDS
container=$(docker compose ps -a -q "$service")
while ((SECONDS - started < limit)); do
  if [[ $(curl -s --max-time 3 "http://127.0.0.1:$port/api/health" || true) == *'"ok":true'* ]]; then
    echo "  healthy after $((SECONDS - started)) s"
    exit 0
  fi
  restarts=$(docker inspect --format '{{.RestartCount}}' "$container" 2>/dev/null || echo 0)
  if ((restarts >= 3)); then
    echo "  it keeps crashing ($restarts restarts)"
    exit 1
  fi
  sleep 2
done
exit 1
EOF
}

# ---- checks -----------------------------------------------------------------

target='' # the commit GitHub has, which the server will pull
facts=''
fact() { sed -n "s/^$1=//p" <<<"$facts" | head -n 1; }

local_preflight() {
  local branch head ahead
  step "This computer"
  cd "$root"
  branch=$(git symbolic-ref --short -q HEAD || true)
  if [[ $branch == "$BRANCH" ]]; then
    ok "on $BRANCH"
  else
    fail "on ${branch:-a detached HEAD}, not $BRANCH: the server deploys $BRANCH"
  fi
  if [[ -z $(git status --porcelain) ]]; then
    ok "nothing uncommitted"
  else
    fail "uncommitted changes (git status): the server only gets what's pushed"
  fi
  target=$(git ls-remote origin "refs/heads/$BRANCH" | cut -f1)
  [[ -n $target ]] || die "Can't read $BRANCH from GitHub (git ls-remote origin)."
  head=$(git rev-parse HEAD)
  if [[ $head == "$target" ]]; then
    ok "pushed: $(git log -1 --format='%h %s')"
  elif git merge-base --is-ancestor "$target" HEAD 2>/dev/null; then
    ahead=$(git rev-list --count "$target..HEAD")
    fail "$ahead commit(s) not pushed yet (git push): the server would deploy ${target:0:8}"
  else
    fail "GitHub's $BRANCH (${target:0:8}) has commits this computer doesn't (git pull), or the branches differ"
  fi
}

# $1: what will happen (deploy, ship-image, rollback)
remote_preflight() {
  local need=$1 value mem disk min_disk
  step "The server ($DEPLOY_HOST, ~/$DEPLOY_DIR)"
  facts=$(server_facts | remote) ||
    die "Can't run commands in ~/$DEPLOY_DIR/deploy on $DEPLOY_HOST (does 'ssh $DEPLOY_HOST' work without a password? is the checkout there?)"

  value=$(fact docker)
  if [[ $value == none ]]; then
    fail "can't use Docker (is the ssh user in the docker group?)"
  elif [[ $(fact compose) == none ]]; then
    fail "Docker $value, but no 'docker compose' (the Compose plugin)"
  else
    ok "Docker $value, Compose $(fact compose)"
  fi
  value=$(fact services)
  if [[ -n $value ]]; then
    ok "Compose services: $value"
  else
    fail "docker compose can't read deploy/ (is deploy/.env there, with DOMAIN set?)"
  fi
  value=$(fact branch)
  if [[ $value == "$BRANCH" ]]; then
    ok "checkout on $BRANCH, at $(fact head | cut -c1-8)${target:+ (deploying ${target:0:8})}"
  else
    fail "the checkout is on $value, not $BRANCH"
  fi
  value=$(fact modified)
  if [[ $value == 0 ]]; then
    ok "no tracked files changed on the server"
  else
    fail "$value tracked file(s) changed on the server ('git status' there), so git pull would stop. Server settings go in untracked files: deploy/.env, deploy/docker-compose.override.yml"
  fi
  if [[ $(fact curl) != yes ]]; then
    fail "curl isn't installed on the server (the health check needs it)"
  fi

  mem=$(fact mem_mb)
  if [[ $need == deploy ]]; then
    if ((${mem:-0} >= MIN_MEM_MB)); then
      ok "$(gb "$mem") of RAM free (building needs about $(gb "$MIN_MEM_MB"))"
    else
      fail "only $(gb "$mem") of RAM free, building needs about $(gb "$MIN_MEM_MB"): build here and send it with --ship-image"
    fi
  else
    ok "$(gb "$mem") of RAM free"
  fi
  disk=$(fact disk_mb)
  min_disk=$MIN_DISK_MB
  [[ $need == deploy ]] && min_disk=$MIN_DISK_BUILD_MB
  if ((${disk:-0} >= min_disk)); then
    ok "$(gb "$disk") of disk free for Docker"
  else
    fail "only $(gb "$disk") of disk free for Docker, $(gb "$min_disk") needed ('docker system df' shows what takes space)"
  fi

  value=$(fact app)
  if [[ $value == healthy ]]; then
    ok "the app runs and is healthy"
  else
    warn "the app is $value now"
  fi
  value=$(fact previous)
  if [[ $need == rollback ]]; then
    if [[ -n $value ]]; then
      ok "$IMAGE:previous is there (built $value)"
    else
      fail "no $IMAGE:previous on the server: nothing to go back to"
    fi
  fi
}

# from the internet, like a browser; returns how many checks failed
public_checks() {
  local url=$DEPLOY_URL host out failed=0
  step "From here${url:+ ($url)}"
  if [[ -z $url ]]; then
    warn "DEPLOY_URL isn't set: skipped"
    return 0
  fi
  if ((dry_run)); then
    say "${dim}[dry run] would check: the page, /api/health, the WebSocket upgrade, http → https${reset}"
    return 0
  fi
  host=${url#*://}
  host=${host%%/*}

  # (curl checks the certificate)
  out=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$url/" 2>&1) || true
  if [[ $out == 200 && $url == https://* ]]; then
    ok "page: 200, valid certificate"
  elif [[ $out == 200 ]]; then
    ok "page: 200"
  else
    bad "page: ${out%%$'\n'*}"
    failed=$((failed + 1))
  fi
  out=$(curl -sS --max-time 10 "$url/api/health" 2>&1) || true
  if [[ $out == *'"ok":true'* ]]; then
    ok "health: $out"
  else
    bad "health: ${out:0:200}"
    failed=$((failed + 1))
  fi
  # the proxy must pass WebSockets on (live collaboration); curl waits on the
  # open connection until --max-time
  out=$(curl -si --http1.1 --max-time 3 -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
    -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
    "$url/socket.io/?EIO=4&transport=websocket" 2>/dev/null | head -n 1 | tr -d '\r') || true
  if [[ $out == *" 101"* ]]; then
    ok "WebSocket: $out"
  else
    bad "WebSocket: ${out:-no answer} (expected 101: does the proxy pass Upgrade/Connection on?)"
    failed=$((failed + 1))
  fi
  if [[ $url == https://* ]]; then
    out=$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 10 "http://$host/" 2>&1) || true
    if [[ $out == 30[1278]" https://"* ]]; then
      ok "http → https: $out"
    else
      bad "http → https: ${out%%$'\n'*} (expected 301 to https://)"
      failed=$((failed + 1))
    fi
  fi
  return "$failed"
}

wait_healthy() {
  step "Waiting for the app (up to $HEALTH_TIMEOUT_S s)"
  if ((dry_run)); then
    say "${dim}[dry run] would wait for http://127.0.0.1:$DEPLOY_PORT/api/health on the server${reset}"
    return 0
  fi
  if server_wait_healthy | remote "limit=$HEALTH_TIMEOUT_S"; then
    return 0
  fi
  bad "the app isn't healthy; its last log lines:"
  server_logs | remote || true
  die "The new version doesn't start. To run the previous image again: deploy/deploy.sh --rollback"
}

back_up() {
  step "Backing up the data on the server"
  server_backup | change
}

finish() {
  local failed=0
  public_checks || failed=$?
  step "Done"
  if ((dry_run)); then
    say "Dry run: nothing was changed."
    return 0
  fi
  say "the server's checkout: $(echo 'git log -1 --oneline' | remote)"
  ((failed == 0)) ||
    die "The app runs, but $failed check(s) from the internet failed (above): nginx, the certificate or DNS?"
}

# ---- what to do ---------------------------------------------------------------

deploy() {
  local platform=''
  local_preflight
  remote_preflight "$mode"
  if [[ $mode == ship-image ]]; then
    case $(fact arch) in
      x86_64 | amd64) platform=linux/amd64 ;;
      aarch64 | arm64) platform=linux/arm64 ;;
      *) die "Don't know how to build for the server's CPU ($(fact arch))." ;;
    esac
    step "Building the image here ($platform)"
    run docker buildx build --platform "$platform" -f "$root/whiteboard-server/Dockerfile" \
      -t "$IMAGE:latest" --load "$root"
  fi
  if ((backup)); then
    back_up
  fi

  step "Updating the server"
  server_keep_previous | change
  if [[ $mode == ship-image ]]; then
    if ((dry_run)); then
      say "${dim}[dry run] would run here:${reset} docker save $IMAGE:latest | gzip | ssh $DEPLOY_HOST 'gunzip | docker load'"
    else
      say "sending the image…"
      docker save "$IMAGE:latest" | gzip | ssh "${ssh_opts[@]}" "$DEPLOY_HOST" 'gunzip | docker load'
    fi
    server_pull | change "expected=$target"
    server_start | change "build=--no-build"
  else
    server_pull | change "expected=$target"
    server_start | change "build=--build"
  fi
  wait_healthy
  finish
}

rollback() {
  local checkout
  remote_preflight rollback
  if ((backup)); then
    back_up
  fi
  step "Rolling back"
  server_rollback | change
  checkout=$(fact head)
  say "The checkout on the server stays at ${checkout:0:8}, so the next deploy builds"
  say "that code again: push a fix (or a git revert) first."
  wait_healthy
  finish
}

status() {
  local deployed github
  step "The server ($DEPLOY_HOST, ~/$DEPLOY_DIR)"
  server_status | remote | sed 's/^/  /' ||
    die "Can't run commands in ~/$DEPLOY_DIR/deploy on $DEPLOY_HOST."
  deployed=$(echo 'git rev-parse HEAD' | remote)
  github=$(cd "$root" && git ls-remote origin "refs/heads/$BRANCH" | cut -f1) || true
  echo
  if [[ -z $github ]]; then
    warn "can't read GitHub's $BRANCH (git ls-remote origin) to compare"
  elif [[ $deployed == "$github" ]]; then
    ok "the server's checkout is GitHub's $BRANCH"
  else
    warn "GitHub's $BRANCH is at ${github:0:8}, the server at ${deployed:0:8}: not deployed yet"
  fi
  public_checks || true
}

case $mode in
  status) status ;;
  rollback) rollback ;;
  *) deploy ;;
esac
