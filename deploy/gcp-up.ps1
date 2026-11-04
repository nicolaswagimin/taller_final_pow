# Script de despliegue provisional en GCP
param(
  [string]$Zona = "us-central1-a",
  [string]$Nombre = "preconteo-vm"
)

Write-Host "Creando regla de firewall para puerto 80..." -ForegroundColor Cyan
gcloud compute firewall-rules create permitir-http-preconteo `
  --direction=INGRESS `
  --priority=1000 `
  --network=default `
  --action=ALLOW `
  --rules=tcp:80 `
  --source-ranges=0.0.0.0/0 `
  --target-tags=http-server 2>$null

Write-Host "Creando y aprovisionando instancia $Nombre en $Zona..." -ForegroundColor Cyan
gcloud compute instances create $Nombre `
  --zone=$Zona `
  --machine-type=e2-standard-2 `
  --image-family=debian-12 `
  --image-project=debian-cloud `
  --boot-disk-size=20GB `
  --tags=http-server `
  --metadata-from-file=startup-script=deploy/gcp-startup.sh

$ip = gcloud compute instances describe $Nombre --zone=$Zona --format="get(networkInterfaces[0].accessConfigs[0].natIP)"

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Green
Write-Host "Despliegue iniciado exitosamente en Google Cloud Platform!" -ForegroundColor Green
Write-Host "IP Publica: http://$ip" -ForegroundColor Yellow
Write-Host "Tablero de metricas: http://$ip/tablero.html" -ForegroundColor Yellow
Write-Host "Web publico:         http://$ip/publico.html" -ForegroundColor Yellow
Write-Host "Consola auditores:   http://$ip/auditor.html" -ForegroundColor Yellow
Write-Host ""
Write-Host "Para destruir todo en 1 solo paso cuando termines:" -ForegroundColor White
Write-Host "  deploy/gcp-down.ps1" -ForegroundColor Red
Write-Host "==========================================================" -ForegroundColor Green
