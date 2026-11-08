#!/bin/sh
# One-shot install of the trial broker on the customer machine (docs/trial.md, step 4). Run from the bundle folder:
#   sudo sh install.sh
# Does: packages -> WireGuard key + wg0 (dials out to the VPS) -> Docker starts after wg0 -> EMQX -> layer 4 (VN-only
# 1883). Safe to run again (keeps an existing key / wg0.conf). The private key never leaves /etc/wireguard.
set -eu
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
cd "$(dirname "$0")"
OWNER=${SUDO_USER:-root}
VPS_PUB=${VPS_PUB:-pe7xyQ1IeroI3QZ9o/kkvJzlJ0cWEXQU4IaRdfmlyzE=}
VPS_ENDPOINT=${VPS_ENDPOINT:-13.55.91.187:51820}

echo "== [1/6] packages"
# stdin from /dev/null: under `sudo … | tee` apt touches the tty and gets stopped (SIGTTOU), seen 2026-11-08
PKGS="docker.io docker-compose-v2 wireguard-tools ipset"
if dpkg-query -W -f='${Status}\n' $PKGS 2>/dev/null | grep -vc 'install ok installed' | grep -qx 0; then
  echo "packages already installed"
else
  apt-get update -q < /dev/null
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q $PKGS < /dev/null
fi

echo "== [2/6] WireGuard wg0 = 10.88.0.2"
( umask 077
  [ -s /etc/wireguard/customer.key ] || wg genkey > /etc/wireguard/customer.key
  wg pubkey < /etc/wireguard/customer.key > /etc/wireguard/customer.pub
  if [ ! -f /etc/wireguard/wg0.conf ]; then
    cat > /etc/wireguard/wg0.conf <<EOF
# CityLight trial (docs/trial.md). Private key read from its file. Only the VPS address goes through the tunnel.
[Interface]
Address = 10.88.0.2/24
PostUp = wg set %i private-key /etc/wireguard/customer.key

[Peer]
# CityLight VPS
PublicKey = $VPS_PUB
Endpoint = $VPS_ENDPOINT
AllowedIPs = 10.88.0.1/32
PersistentKeepalive = 25
EOF
  fi )
install -m 644 -o "$OWNER" /etc/wireguard/customer.pub ./customer.pub
systemctl enable --now wg-quick@wg0

echo "== [3/6] Docker starts after wg0 (1885 binds 10.88.0.2)"
mkdir -p /etc/systemd/system/docker.service.d
printf '[Unit]\nAfter=wg-quick@wg0.service\nWants=wg-quick@wg0.service\n' > /etc/systemd/system/docker.service.d/after-wg.conf
systemctl daemon-reload
systemctl enable --now docker
systemctl restart docker

echo "== [4/6] EMQX"
chmod 644 emqx/acl.conf emqx/device-users.csv
docker compose up -d

echo "== [5/6] layer 4: 1883 only from VN IPv4"
install -m 755 cl-geoip.sh /usr/local/sbin/cl-geoip.sh
install -m 644 cl-geoip.service cl-geoip-update.service cl-geoip-update.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now cl-geoip.service cl-geoip-update.timer

echo "== [6/6] status"
wg show wg0 | sed -n '1,12p'
docker compose ps
/usr/local/sbin/cl-geoip.sh status
echo "customer public key (send to CityLight): $(cat customer.pub)"
