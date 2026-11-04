# Script para bajar y destruir todo en GCP en 1 solo paso
param(
  [string]$Zona = "us-central1-a",
  [string]$Nombre = "preconteo-vm"
)

Write-Host "Eliminando instancia $Nombre en $Zona..." -ForegroundColor Yellow
gcloud compute instances delete $Nombre --zone=$Zona --quiet

Write-Host "Eliminando regla de firewall..." -ForegroundColor Yellow
gcloud compute firewall-rules delete permitir-http-preconteo --quiet

Write-Host "Todo ha sido destruido en GCP exitosamente. Costo detenido." -ForegroundColor Green
