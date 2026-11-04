# Despliegue en Google Cloud Platform (GCP) — Compute Engine

Despliegue provisional en GCP con una máquina virtual `e2-standard-2` (2 vCPU, 8 GB RAM) con Docker Compose (Nginx + 8 réplicas Node.js + Redis).

---

## 1. Crear Regla de Firewall (Puerto 80)

Si no tienes una regla que permita tráfico HTTP en la red por defecto:

```bash
gcloud compute firewall-rules create permitir-http-preconteo \
  --direction=INGRESS \
  --priority=1000 \
  --network=default \
  --action=ALLOW \
  --rules=tcp:80 \
  --source-ranges=0.0.0.0/0 \
  --target-tags=http-server
```

---

## 2. Comando de Creación y Despliegue en 1 Solo Paso

Ejecuta el siguiente comando (puedes ajustar `--zone` si lo prefieres, e.g., `us-central1-a`):

```bash
gcloud compute instances create preconteo-vm \
  --zone=us-central1-a \
  --machine-type=e2-standard-2 \
  --image-family=debian-12 \
  --image-project=debian-cloud \
  --boot-disk-size=20GB \
  --tags=http-server \
  --metadata-from-file=startup-script=deploy/gcp-startup.sh
```

El script `deploy/gcp-startup.sh` se ejecutará automáticamente:
1. Instala Docker y Docker Compose plugin.
2. Ajusta los límites de descriptores (`ulimit` y `sysctl`) a 1.048.576.
3. Clona el repositorio en la rama `main`.
4. Construye y levanta el stack completo: **Nginx :80 (round-robin) + 8 réplicas de App + Redis**.
5. Carga el catálogo semilla y las actas iniciales.

---

## 3. Verificar el Despliegue

Obtén la IP pública asignada:

```bash
gcloud compute instances describe preconteo-vm --zone=us-central1-a --format='get(networkInterfaces[0].accessConfigs[0].natIP)'
```

Comprueba los endpoints:
```bash
IP=$(gcloud compute instances describe preconteo-vm --zone=us-central1-a --format='get(networkInterfaces[0].accessConfigs[0].natIP)')

curl http://$IP/salud
# {"instancia":"...","redis":"ok"}

# Comprobar que Nginx reparte round-robin entre las 8 instancias:
for i in $(seq 8); do curl -s http://$IP/api/instancia; echo; done

# En el navegador:
# http://$IP/tablero.html    (Métricas de las 8 instancias en tiempo real)
# http://$IP/publico.html    (Interfaz pública SSE)
# http://$IP/auditor.html    (Consola WebSocket de auditores)
# http://$IP/jurado.html     (Transmisión de actas de jurado)
```

---

## 4. Comando para Bajar y Destruir Todo en 1 Solo Paso

Para no consumir créditos ni generar costos, destruye la instancia y la regla de firewall con un solo comando:

```bash
gcloud compute instances delete preconteo-vm --zone=us-central1-a --quiet && gcloud compute firewall-rules delete permitir-http-preconteo --quiet
```
