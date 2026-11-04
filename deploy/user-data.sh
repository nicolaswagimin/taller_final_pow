#!/bin/bash
# User-data para EC2 Amazon Linux 2023 (x86_64 o ARM). Pegar completo en
# "Advanced details → User data" al lanzar la instancia. Log: /var/log/preconteo-user-data.log
set -euxo pipefail
exec > >(tee -a /var/log/preconteo-user-data.log) 2>&1

REPO_URL="https://github.com/nicolaswagimin/taller_final_pow.git"
RAMA="main"
DIR="/opt/preconteo"

# --- Docker + git ---
dnf install -y docker git
systemctl enable --now docker
usermod -aG docker ec2-user

# --- Plugin docker compose (AL2023 no lo trae en dnf) ---
case "$(uname -m)" in
  x86_64)  ARQ=x86_64 ;;
  aarch64) ARQ=aarch64 ;;
  *) echo "Arquitectura no soportada: $(uname -m)"; exit 1 ;;
esac
mkdir -p /usr/local/lib/docker/cli-plugins
curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-${ARQ}" \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
docker compose version

# --- Límites de descriptores ---
cat > /etc/security/limits.d/90-preconteo.conf <<'LIM'
*    soft nofile 1048576
*    hard nofile 1048576
root soft nofile 1048576
root hard nofile 1048576
LIM
mkdir -p /etc/systemd/system/docker.service.d
cat > /etc/systemd/system/docker.service.d/limites.conf <<'LIM'
[Service]
LimitNOFILE=1048576
LIM

# --- sysctl: muchas conexiones concurrentes ---
cat > /etc/sysctl.d/90-preconteo.conf <<'SYS'
fs.file-max = 2097152
fs.nr_open = 2097152
net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 65535
net.core.netdev_max_backlog = 65535
net.ipv4.ip_local_port_range = 1024 65535
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_fin_timeout = 15
SYS
sysctl --system
systemctl daemon-reload
systemctl restart docker

# --- Código y arranque ---
rm -rf "$DIR"
git clone --depth 1 --branch "$RAMA" "$REPO_URL" "$DIR"
cd "$DIR"
# El docker de AL2023 no trae buildx y `docker compose up --build` exige buildx ≥ 0.17.
# Se construye la imagen con `docker build` (preconteo-app, la misma de docker-compose.yml)
# y compose solo la arranca.
docker build -t preconteo-app .
docker compose up -d
docker compose ps
echo "Listo: http://$(curl -s http://checkip.amazonaws.com)/tablero.html"
