#!/bin/sh
# Layer 4 of the trial (docs/trial.md): the customer broker port 1883 only accepts Vietnamese IPv4 sources.
# List = APNIC delegated stats (apnic|VN|ipv4) in ipset cl-vn4, + LAN, + /etc/cl-geoip/allow-extra.txt (one CIDR per
# line, for a new 4G range missing from APNIC). Rule: DOCKER-USER (Docker publishes 1883, INPUT never sees it).
# Fails OPEN: no list ever loaded = no DROP rule (cabinets keep working).
#   cl-geoip.sh start    load the saved list (fetch if none), install the rules     (cl-geoip.service)
#   cl-geoip.sh update   fetch APNIC again and swap the set in place                 (cl-geoip-update.timer, weekly)
#   cl-geoip.sh stop     remove the rules (port open to every source again)
#   cl-geoip.sh status   counters + set size
set -eu
SET=cl-vn4
DIR=/var/lib/cl-geoip
EXTRA=/etc/cl-geoip/allow-extra.txt
URL=https://ftp.apnic.net/stats/apnic/delegated-apnic-latest
LAN=${CL_GEOIP_LAN:-192.168.1.0/24}
IFACE=${CL_GEOIP_IFACE:-ens160}
PORT=${CL_GEOIP_PORT:-1883}
MIN_RANGES=300            # VN has ~1 000 ranges; fewer = broken download, keep the old list

mkdir -p "$DIR" /etc/cl-geoip
[ -f "$EXTRA" ] || printf '# extra source ranges allowed on port %s, one CIDR per line\n' "$PORT" > "$EXTRA"

fetch() {
  tmp=$(mktemp)
  if curl -fsS -m 120 "$URL" -o "$tmp"; then
    # "start count" -> CIDR list (count may not be a power of two: split)
    awk -F'|' '$1=="apnic" && $2=="VN" && $3=="ipv4" { print $4, $5 }' "$tmp" | awk '
      function ip2n(s,  a) { split(s, a, "."); return ((a[1]*256 + a[2])*256 + a[3])*256 + a[4] }
      function n2ip(n) { return int(n/16777216) "." int(n/65536)%256 "." int(n/256)%256 "." n%256 }
      { s = ip2n($1); left = $2
        while (left > 0) {
          size = 1; bits = 32
          while (bits > 0 && s % (size*2) == 0 && size*2 <= left) { size *= 2; bits-- }
          print n2ip(s) "/" bits; s += size; left -= size } }' > "$tmp.cidr"
    n=$(wc -l < "$tmp.cidr")
    if [ "$n" -ge "$MIN_RANGES" ]; then mv "$tmp.cidr" "$DIR/vn4.txt"; echo "cl-geoip: fetched $n VN CIDRs"
    else echo "cl-geoip: only $n CIDRs downloaded, keeping the old list"; rm -f "$tmp.cidr"; fi
  else
    echo "cl-geoip: download failed, keeping the old list"
  fi
  rm -f "$tmp"
}

load_set() {
  [ -s "$DIR/vn4.txt" ] || return 1
  ipset create -exist "$SET" hash:net maxelem 131072
  ipset create -exist "$SET-new" hash:net maxelem 131072
  ipset flush "$SET-new"
  sed "s/^/add $SET-new /" "$DIR/vn4.txt" | ipset restore -exist
  ipset swap "$SET-new" "$SET"
  ipset destroy "$SET-new"
  echo "cl-geoip: $SET = $(wc -l < "$DIR/vn4.txt") CIDRs"
}

rules_on() {
  iptables -N CL-GEOIP 2>/dev/null || true
  iptables -F CL-GEOIP
  iptables -A CL-GEOIP -s "$LAN" -j RETURN
  iptables -A CL-GEOIP -m set --match-set "$SET" src -j RETURN
  grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+(/[0-9]+)?$' "$EXTRA" | while read -r c; do iptables -A CL-GEOIP -s "$c" -j RETURN; done
  iptables -A CL-GEOIP -m limit --limit 6/min --limit-burst 10 -j LOG --log-prefix "cl-geoip-drop: "
  iptables -A CL-GEOIP -j DROP
  iptables -L DOCKER-USER -n >/dev/null 2>&1 || { echo "cl-geoip: DOCKER-USER missing (Docker not started?)"; exit 1; }
  iptables -C DOCKER-USER -i "$IFACE" -p tcp --dport "$PORT" -m conntrack --ctstate NEW -j CL-GEOIP 2>/dev/null ||
    iptables -I DOCKER-USER 1 -i "$IFACE" -p tcp --dport "$PORT" -m conntrack --ctstate NEW -j CL-GEOIP
  echo "cl-geoip: port $PORT on $IFACE limited to LAN + $SET + allow-extra"
}

rules_off() {
  while iptables -D DOCKER-USER -i "$IFACE" -p tcp --dport "$PORT" -m conntrack --ctstate NEW -j CL-GEOIP 2>/dev/null; do :; done
  iptables -F CL-GEOIP 2>/dev/null || true
  iptables -X CL-GEOIP 2>/dev/null || true
  echo "cl-geoip: rules removed, port $PORT open to every source"
}

case "${1:-}" in
  start)  [ -s "$DIR/vn4.txt" ] || fetch
          if load_set; then rules_on; else echo "cl-geoip: no list, port left open (fail open)"; fi ;;
  update) fetch; load_set || true
          iptables -L CL-GEOIP -n >/dev/null 2>&1 && rules_on || true ;;
  stop)   rules_off ;;
  status) iptables -L CL-GEOIP -n -v 2>/dev/null || echo "no CL-GEOIP chain"
          iptables -L DOCKER-USER -n -v --line-numbers | head -5
          ipset list "$SET" -terse 2>/dev/null | grep -E 'Name|entries' || true ;;
  *) echo "usage: $0 start|update|stop|status"; exit 2 ;;
esac
