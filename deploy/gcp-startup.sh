#!/bin/bash
# Startup script para Google Cloud Compute Engine (Debian/Ubuntu).
# Instala Docker, Docker Compose, clona el repositorio y levanta el sistema completo.
set -euxo pipefail
exec > >(tee -a /var/log/preconteo-gcp-startup.log) 2>&1

REPO_URL="https://github.com/nicolaswagimin/taller_final_pow.git"
RAMA="main"
DIR="/opt/preconteo"

# 1. Instalar dependencias del sistema y Docker
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl gnupg git

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch="$(dpkg --print-architecture)" signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian \
  "$(. /etc/os-release && echo "$VERSION_CODENAME")" stable" | \
  tee /etc/apt/sources.list.d/docker.list > /dev/null

apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

systemctl enable --now docker

# 2. Ajustes de descriptores de archivos y red para alta concurrencia
cat > /etc/security/limits.d/90-preconteo.conf <<'LIM'
*    soft nofile 1048576
*    hard nofile 1048576
root soft nofile 1048576
root hard nofile 1048576
LIM

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

# 3. Clonar repositorio
mkdir -p "$DIR"
cd "$DIR"
if [ ! -d ".git" ]; then
  git clone --branch "$RAMA" "$REPO_URL" .
else
  git fetch origin "$RAMA"
  git reset --hard "origin/$RAMA"
fi

# 4. Construir y levantar servicios (Nginx + App x8 + Redis)
docker compose build --no-cache app
docker compose up -d

# 5. Cargar catálogo semilla y generar actas de prueba iniciales
docker compose exec -T app npm run semilla || true
docker compose exec -T app npx tsx scripts/dudosas-demo.ts || true

echo "=== Preconteo desplegado exitosamente en GCP ==="
