# Despliegue en AWS (una EC2, costo < 1 USD) — Persona 3

Todo desde la consola web de AWS. Región: **us-east-1 (N. Virginia)**.

## 0. Presupuesto (hacer primero)

1. Buscar **Billing and Cost Management → Budgets → Create budget**.
2. *Use a template* → **Monthly cost budget**.
3. Nombre `preconteo`, monto **5 USD**, correo de alerta del grupo → *Create budget*.

## 1. Security group

**EC2 → Security Groups → Create security group** (en us-east-1, VPC por defecto):

| Tipo | Puerto | Origen |
|---|---|---|
| HTTP | 80 | `0.0.0.0/0` (Anywhere-IPv4) |
| SSH | 22 | **My IP** (solo tu IP) |

Nombre: `preconteo-sg`.

## 2. Lanzar la instancia

**EC2 → Instances → Launch instances**:

- **Name:** `preconteo`
- **AMI:** Amazon Linux 2023 (x86_64). Si eliges ARM, usa `t4g.medium`; el script sirve para ambas.
- **Instance type:** `t3.medium` (2 vCPU, 4 GB)
- **Key pair:** crear o elegir uno (para SSH).
- **Network settings → Select existing security group:** `preconteo-sg`. *Auto-assign public IP*: Enable.
- **Storage:** 8–16 GB gp3 es suficiente.
- **Advanced details:**
  - **Credit specification:** **Standard** (¡no Unlimited! Unlimited cobra créditos extra bajo carga).
  - **User data:** pegar el contenido completo de [`user-data.sh`](user-data.sh).
    Ajustar `REPO_URL` si el repo cambia.
- *Launch instance*.

## 3. Verificar

Tarda ~3–5 min (instala Docker y construye la imagen).

```bash
IP=<ip-publica>
curl http://$IP/salud
for i in $(seq 16); do curl -s http://$IP/api/instancia; echo; done   # 8 instancias distintas
# Navegador: http://$IP/tablero.html   (o http://$IP.sslip.io/tablero.html)
```

Si algo falla: `ssh -i llave.pem ec2-user@$IP` y `sudo tail -f /var/log/preconteo-user-data.log`.

Para actualizar a lo último de `main`:

```bash
cd /opt/preconteo && sudo git pull && sudo docker compose up -d --build
```

## 4. Terminar (obligatorio después de la sustentación)

**EC2 → Instances →** seleccionar `preconteo` → **Instance state → Terminate instance** → confirmar.

*Detener* (Stop) **no basta**: el volumen EBS sigue cobrando. Comprobar después:
- **EC2 → Volumes**: no debe quedar ningún volumen del proyecto.
- **EC2 → Elastic IPs**: si se asignó una, *Release*.
- Opcional: borrar `preconteo-sg` y el presupuesto.
