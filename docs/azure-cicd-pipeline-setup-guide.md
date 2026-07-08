# Azure CI/CD Pipeline Setup Guide

Guia para conectar un repositorio de Azure DevOps con Oryon usando Azure Pipelines.

El pipeline ejecuta el wrapper publico de `oryon-cicd-pipeline`. Ese wrapper valida la ejecucion con Oryon usando el token CI y el OIDC token de Azure, descarga el scanner privado autorizado, verifica su SHA256 y sube el resultado al dashboard.

## Requisitos

- Proyecto creado en Oryon.
- Permisos para gestionar CI/CD en el proyecto de Oryon.
- Permisos de admin o maintainer sobre la pipeline de Azure DevOps.
- Repo en Azure DevOps con `azure-pipelines.yml`.
- Agente con Node.js 20 o superior. `ubuntu-latest` suele ser suficiente; en agentes self-hosted anade `NodeTool@0`.

## Datos que necesitas

| Campo en Oryon | De donde sale |
| --- | --- |
| `Organization URL` | `https://dev.azure.com/<organization>` |
| `Project` | Nombre del proyecto de Azure DevOps |
| `Repository` | Nombre del repo de Azure DevOps |
| `Org ID` | Claim `org_id` del OIDC token de Azure |
| `Project ID` | UUID del proyecto Azure DevOps |
| `Pipeline ID` | ID numerico de la pipeline |
| `Repo ID` | UUID del repo Azure DevOps |
| `Allowed refs` | Refs permitidas, por ejemplo `refs/heads/main` |

## 1. Obtener IDs de Azure DevOps

Configura la CLI:

```bash
az extension add --name azure-devops
az devops configure \
  --defaults organization=https://dev.azure.com/<organization> \
             project="<Azure project>"
```

Obtener `Project ID`:

```bash
az devops project show \
  --project "<Azure project>" \
  --query id \
  -o tsv
```

Obtener `Repo ID`:

```bash
az repos show \
  --repository "<repo name>" \
  --query id \
  -o tsv
```

Obtener `Pipeline ID`:

```bash
az pipelines list \
  --query "[].{id:id,name:name}" \
  -o table
```

Si aun no existe la pipeline, creala primero desde Azure DevOps y vuelve a ejecutar el comando.

## 2. Obtener el Org ID OIDC

El `Org ID` no es el nombre de la organizacion. Es el UUID que Azure emite en el OIDC token y en el issuer:

```text
https://vstoken.dev.azure.com/<org_id>
```

La forma mas fiable de obtenerlo es ejecutar temporalmente este paso en una pipeline de Azure del mismo proyecto/repo:

```yaml
steps:
  - bash: |
      set -euo pipefail

      response="$(curl -fsS -X POST "${SYSTEM_OIDCREQUESTURI}?api-version=7.1" \
        -H "Authorization: Bearer ${SYSTEM_ACCESSTOKEN}" \
        -H "Content-Length: 0")"

      node - "$response" <<'NODE'
      const response = JSON.parse(process.argv[2])
      const token = response.oidcToken || response.oidc_token || response.idToken || response.id_token || response.token
      if (!token) throw new Error("OIDC token not found in Azure response")
      const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"))
      console.log(`Org ID: ${payload.org_id}`)
      console.log(`Project ID: ${payload.prj_id}`)
      console.log(`Pipeline ID: ${payload.def_id}`)
      console.log(`Repo ID: ${payload.rpo_id}`)
      console.log(`Ref: ${payload.rpo_ref}`)
      NODE
    displayName: Print Azure OIDC identifiers
    env:
      SYSTEM_ACCESSTOKEN: $(System.AccessToken)
```

No imprimas el OIDC token completo. Usa solo los IDs y elimina este paso despues.

## 3. Crear el token CI en Oryon

1. Abre el proyecto en Oryon.
2. Entra en `CI/CD`.
3. Selecciona `Azure Pipelines`.
4. Rellena:
   - `Organization URL`
   - `Project`
   - `Repository`
   - `Org ID`
   - `Project ID`
   - `Pipeline ID`
   - `Repo ID`
   - `Allowed refs`, por ejemplo:

```text
refs/heads/main
refs/heads/release
```

5. Pulsa `Generar token CI`.
6. Copia el token. Solo se muestra una vez.

## 4. Guardar el token en Azure Pipelines

En Azure DevOps:

1. Abre la pipeline.
2. Entra en `Edit`.
3. Abre `Variables`.
4. Crea `ORYON_CI_TOKEN`.
5. Marca la variable como secreta.
6. Guarda la pipeline.

No guardes `ORYON_CI_TOKEN` en el repositorio.

## 5. Crear `azure-pipelines.yml`

YAML recomendado:

```yaml
trigger:
  branches:
    include:
      - main

pr:
  branches:
    include:
      - main

pool:
  vmImage: ubuntu-latest

steps:
  - checkout: self
    persistCredentials: false

  - bash: |
      set -euo pipefail
      curl -fsSL https://raw.githubusercontent.com/Oryon-Technology/oryon-cicd-pipeline/v1/azure/oryon-scan.sh | bash
    displayName: Oryon Security Scan
    env:
      ORYON_CI_TOKEN: $(ORYON_CI_TOKEN)
      SYSTEM_ACCESSTOKEN: $(System.AccessToken)
```

Si el agente no tiene Node.js 20, anade este paso antes del scan:

```yaml
  - task: NodeTool@0
    inputs:
      versionSpec: "20.x"
    displayName: Use Node.js 20
```

## 6. Opciones del scan

Puedes ajustar el comportamiento con variables de entorno:

| Variable | Default | Uso |
| --- | --- | --- |
| `ORYON_FAIL_ON` | `none` | Falla el job si hay findings desde `low`, `medium`, `high` o `critical` |
| `ORYON_AI` | `true` | Activa enriquecimiento AI |
| `ORYON_UPLOAD` | `true` | Sube el scan a Oryon |
| `ORYON_REPORT` | `none` | Usa `pdf` para generar reporte si esta disponible |
| `ORYON_SARIF` | `true` | Genera SARIF si el scanner lo soporta |
| `ORYON_SCANNER_VERSION` | `v1` | Canal/version del scanner |
| `ORYON_BACKEND_URL` | `https://dashboard.oryontechnology.com` | URL del backend Oryon |

Ejemplo:

```yaml
    env:
      ORYON_CI_TOKEN: $(ORYON_CI_TOKEN)
      SYSTEM_ACCESSTOKEN: $(System.AccessToken)
      ORYON_FAIL_ON: high
      ORYON_REPORT: none
      ORYON_AI: "true"
```

## 7. Verificar que funciona

Ejecuta la pipeline. En logs deberias ver:

```text
Requesting Azure Pipelines OIDC token.
Requesting Oryon CI bootstrap lease.
Downloading Oryon scanner ...
Running Oryon scanner.
```

En Oryon:

- El estado de Azure Pipelines pasa a `Conectado` despues del primer uso correcto.
- El scan aparece en el historial del proyecto.
- La pestana de GitHub Actions sigue separada y no se marca como conectada por usar Azure.

## Troubleshooting

`ORYON_CI_TOKEN is required`
: La variable secreta no existe, tiene otro nombre o no esta expuesta al step.

`SYSTEM_OIDCREQUESTURI is unavailable`
: Azure no ha expuesto la URI OIDC para ese job. Revisa que estas en Azure Pipelines, que el job tiene acceso a `$(System.AccessToken)` y que la pipeline usa una configuracion compatible con OIDC.

`Azure Pipelines OIDC token request failed`
: Normalmente falta `SYSTEM_ACCESSTOKEN: $(System.AccessToken)` en `env`, o la pipeline no permite que el script use el token OAuth.

`Azure Pipelines organization/project/repository/pipeline does not match`
: Alguno de los IDs configurados en Oryon no coincide con el OIDC token real de Azure. Repite el paso de diagnostico y actualiza el token CI en Oryon.

`Azure Pipelines ref is not allowed`
: La ref del run no esta en `Allowed refs`. Usa valores completos como `refs/heads/main`.

`Oryon Azure wrapper requires Node.js 20 or newer`
: Instala Node.js 20 con `NodeTool@0` o actualiza el agente self-hosted.

## Seguridad

- El repo publico solo contiene el wrapper/bootstrap.
- El scanner privado se descarga en runtime tras validar token CI + OIDC.
- El token CI esta limitado al proyecto, pipeline, repo y refs configuradas.
- Revocar o rotar el token en Oryon corta el acceso de esa pipeline.
- No imprimas `ORYON_CI_TOKEN` ni el OIDC token en logs.
