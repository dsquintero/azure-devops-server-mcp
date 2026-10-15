# Azure DevOps Server MCP 🚀

> Proyecto comunitario, **no oficial**: no está afiliado ni respaldado por Microsoft. Azure DevOps es una marca de Microsoft.

Servidor MCP (Model Context Protocol) que conecta asistentes de IA (Claude Code, OpenCode, Cursor, VS Code Copilot…) con **Azure DevOps Server (on-premises)** —y también con Azure DevOps Services— a través de su API REST.

El servidor oficial `@azure-devops/mcp` solo funciona con la nube (`dev.azure.com`): únicamente acepta PATs de hosts de la nube y fija `api-version=7.2-preview`. Este adaptador está pensado para colecciones propias (self-hosted), usa por defecto la **API 6.0** (Azure DevOps Server 2020) y sigue el mismo diseño de herramientas que el servidor oficial.

## ✨ Características

- **Multi-proyecto:** el alcance es todo lo que tu PAT pueda ver. Todas las herramientas aceptan un `project` opcional; cuando se puede deducir (por ejemplo, a partir del ID de un work item) no hace falta indicarlo. `AZURE_DEVOPS_PROJECT` es solo un valor de respaldo.
- **Cualquier campo, sin mapeos fijos:** los campos se envían como `{ nombre: valor }` usando el nombre de referencia (`Custom.Cliente`) o el nombre visible (`Remaining Work`). Si un nombre no existe, falla antes de llamar al servidor y sugiere el correcto; `get_type` muestra los campos, estados, valores permitidos y obligatorios de cada tipo.
- **Detecta la versión de la API sola:** al conectarse consulta al servidor cuál es su versión estable más alta (6.0 en Azure DevOps Server 2020, 7.0 en Server 2022, 7.1 en la nube). Los endpoints que todavía son *preview* reciben el sufijo `-preview` correcto, y si el servidor exige preview en alguno no previsto, se reintenta automáticamente.
- **Sprints y capacidad:** sprint actual de cualquier equipo y tus equipos en todos los proyectos.
- **Test Plans para QA:** planes, suites por requerimiento y test cases con pasos ligados a la User Story o Bug que validan.
- **Respuestas compactas:** identidades simplificadas, relaciones resumidas y columnas por defecto en los listados, para gastar menos tokens.
- **Seguro para equipos:** modo de solo lectura, anotaciones MCP (`readOnlyHint`/`destructiveHint`), control de concurrencia en las actualizaciones y validación sin guardar (`validateOnly`).

---

## 🛠️ Instalación

### 1. Requisitos

- **Node.js 18+** (`npx` debe estar en el `PATH`). `npx` descarga el servidor desde GitHub la primera vez que se ejecuta.
- Un **Personal Access Token (PAT)** creado en tu Azure DevOps Server (*User settings → Personal access tokens*) con estos permisos:
  - Work Items — Read & Write
  - Project and Team — Read
  - Test Management — Read & Write (solo necesario para QA / Test Plans)
  - Identity — Read

### 2. Guarda el PAT en una variable de entorno

Nunca pegues el PAT en un archivo que se suba a git. Expórtalo una sola vez en el perfil de tu terminal y referéncialo desde la configuración del cliente:

```bash
# macOS / Linux (~/.zshrc o ~/.bashrc)
export AZURE_DEVOPS_PAT="tu-personal-access-token"
```

```powershell
# Windows (PowerShell, queda disponible en las terminales nuevas)
setx AZURE_DEVOPS_PAT "tu-personal-access-token"
```

Después de definirla, reinicia la terminal (y el cliente de IA).

### 3. Configura tu cliente de IA

#### Claude Code

**Opción A — por comando, disponible en todos tus proyectos (recomendada):**

```bash
claude mcp add --env AZURE_DEVOPS_ORG_URL=https://your-devops-server.com/CollectionName --env AZURE_DEVOPS_PAT=$AZURE_DEVOPS_PAT --scope user --transport stdio azure-devops-server-mcp -- npx -y github:dsquintero/azure-devops-server-mcp
```

- `--scope user` lo guarda en `~/.claude.json` para todos tus proyectos; usa `--scope local` (por defecto) para solo el proyecto actual.
- Todo lo que va después de `--` es el comando del servidor.
- En Windows usa `-- cmd /c npx -y github:dsquintero/azure-devops-server-mcp`.

**Opción B — compartida con el equipo desde el repositorio (`.mcp.json` en la raíz del proyecto):**

```json
{
  "mcpServers": {
    "azure-devops-server-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "github:dsquintero/azure-devops-server-mcp"],
      "env": {
        "AZURE_DEVOPS_ORG_URL": "https://your-devops-server.com/CollectionName",
        "AZURE_DEVOPS_PAT": "${AZURE_DEVOPS_PAT}"
      }
    }
  }
}
```

Claude Code reemplaza `${AZURE_DEVOPS_PAT}` con la variable de entorno de cada persona, así que el archivo se puede subir a git sin exponer tokens. Cada usuario aprueba el servidor del proyecto la primera vez.

**Verificar:** ejecuta `claude mcp list` (debe aparecer `azure-devops-server-mcp: ✓ Connected`) o escribe `/mcp` dentro de una sesión. Luego pregunta *"¿quién soy en Azure DevOps?"*: la IA llamará a `core` → `whoami`.

#### OpenCode

Agrega el servidor a tu configuración global `~/.config/opencode/opencode.json` (todos los proyectos) o a un `opencode.json` en la raíz de un proyecto (compartido con el equipo):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "azure-devops-server-mcp": {
      "type": "local",
      "command": ["npx", "-y", "github:dsquintero/azure-devops-server-mcp"],
      "enabled": true,
      "timeout": 20000,
      "environment": {
        "AZURE_DEVOPS_ORG_URL": "https://your-devops-server.com/CollectionName",
        "AZURE_DEVOPS_PAT": "{env:AZURE_DEVOPS_PAT}"
      }
    }
  }
}
```

- OpenCode usa `{env:VAR}` (no `${VAR}`) para leer variables de entorno. Si la variable no existe queda vacía, el servidor se detiene y OpenCode solo muestra `MCP error -32000: Connection closed` (ver Solución de problemas).
- `timeout` amplía el límite por defecto de 5 segundos, que puede quedarse corto la primera vez que `npx` descarga el paquete.

**Verificar:** ejecuta `opencode mcp list` y luego pregunta *"¿quién soy en Azure DevOps?"*.

#### Otros clientes (Cursor, Claude Desktop, Windsurf…)

Usan el formato común `mcpServers` (ver [mcp_config.example.json](mcp_config.example.json)). La mayoría no reemplaza variables de entorno, así que el PAT debe ir escrito en el archivo: mantenlo fuera de git.

Archivos listos para copiar: [examples/claude-code.mcp.json](examples/claude-code.mcp.json) · [examples/opencode.json](examples/opencode.json) · [mcp_config.example.json](mcp_config.example.json)

### 4. Variables de entorno

| Variable | Obligatoria | Por defecto | Descripción |
| --- | --- | --- | --- |
| `AZURE_DEVOPS_ORG_URL` | ✅ | | URL de la colección, por ejemplo `https://devops.company.com/DefaultCollection` |
| `AZURE_DEVOPS_PAT` | ✅ | | Personal Access Token |
| `AZURE_DEVOPS_API_VERSION` | | `auto` | Normalmente no hace falta: se detecta del servidor. Úsala solo para forzar una versión (`6.0` = Server 2020, `7.0` = Server 2022, `7.1` = Server 2022.1+ / nube). `whoami` muestra la versión en uso y si fue detectada o configurada |
| `AZURE_DEVOPS_PROJECT` | | | Proyecto de respaldo cuando una herramienta lo necesita y no se puede deducir. Déjala vacía para trabajar con todos los proyectos |
| `AZURE_DEVOPS_DOMAINS` | | `all` | Separados por coma: `core,work,work-items,test-plans` (`core` siempre está activo) |
| `AZURE_DEVOPS_READONLY` | | `false` | `true` registra solo las herramientas de lectura |
| `AZURE_DEVOPS_TIMEOUT_MS` | | `30000` | Tiempo máximo de cada petición HTTP |
| `NODE_EXTRA_CA_CERTS` | | | Ruta al certificado de la CA corporativa (`.pem`) cuando el servidor usa un certificado interno |

Perfiles sugeridos:

| Rol | Configuración |
| --- | --- |
| Desarrolladores / SM / PO / LT | valores por defecto |
| QA | valores por defecto (incluye Test Plans) |
| Usuarios de consulta, reportes | `AZURE_DEVOPS_READONLY=true` |
| Solo tableros, menos herramientas | `AZURE_DEVOPS_DOMAINS=work,work-items` |

### Solución de problemas

| Síntoma | Solución |
| --- | --- |
| `Invalid configuration: AZURE_DEVOPS_PAT is required`, o el cliente solo dice `Connection closed` / `failed` | El cliente no ve una variable obligatoria: reinicia la terminal y el cliente después de exportarla, y revisa `{env:…}` (OpenCode) frente a `${…}` (Claude Code). Si ejecutas el comando del servidor en una terminal con las mismas variables, verás el error exacto |
| `[HTTP 401]` / `[HTTP 203]` | El PAT venció o es incorrecto |
| `[HTTP 403]` | Al PAT le falta un permiso, o no tienes acceso a ese proyecto |
| `Network error (UNABLE_TO_VERIFY_LEAF_SIGNATURE / SELF_SIGNED_CERT…)` | Define `NODE_EXTRA_CA_CERTS` con la CA corporativa |
| `Network error (ENOTFOUND / ECONNREFUSED / ETIMEDOUT)` | Revisa la URL y que estés conectado a la VPN |
| OpenCode marca el servidor como fallido al primer arranque | Aumenta `timeout`, o ejecuta una vez `npx -y github:dsquintero/azure-devops-server-mcp` en una terminal para dejarlo en caché (detenlo con Ctrl+C) |
| `TF401320: Rule Error for field …` al crear o actualizar | Una regla del proceso exige ese campo. El error lista todos los campos que faltan; usa `get_type` (ver `requiredOnCreate`) o `validateOnly` para comprobarlo antes de guardar |

---

## 🤖 Herramientas

Las herramientas se agrupan por dominio y usan un parámetro `action` (mismo diseño que el servidor oficial).

### `core` (lectura)
| Acción | Descripción |
| --- | --- |
| `whoami` | Usuario autenticado y datos de la conexión (útil para validar la instalación) |
| `list_projects` | Todos los proyectos que el PAT puede ver |
| `list_teams` | Equipos de un proyecto o, sin proyecto, los equipos a los que perteneces en todos los proyectos |
| `search_identities` | Busca personas por el inicio de su nombre, cuenta o correo, para `Assigned To` o WIQL |

### `work` (lectura)
| Acción | Descripción |
| --- | --- |
| `list_team_iterations` | Sprints de un equipo (`timeframe`: current / past / future) |
| `list_iterations` | Árbol de iteraciones de un proyecto |
| `get_team_capacity` | Capacidad y días libres por miembro (por defecto, del sprint actual) |

### `wit_work_item` (lectura)
| Acción | Descripción |
| --- | --- |
| `get` / `get_batch` | Work items por ID, de cualquier proyecto |
| `my` | Items asignados a mí o creados por mí, en todos los proyectos o en uno |
| `list_for_iteration` | Items del sprint de un equipo (por defecto el actual), con su padre |
| `list_comments` | Comentarios (Discussion) de un work item |
| `list_history` | Quién cambió qué y cuándo |
| `list_types` / `get_type` | Tipos de un proyecto; estados, campos, valores permitidos y `requiredOnCreate` (campos que exigen las reglas del proceso, detectados con una validación que no guarda nada) |

### `wit_query` (lectura)
| Acción | Descripción |
| --- | --- |
| `wiql` | Consulta WIQL libre (en toda la colección si no se indica proyecto) |
| `list_saved` / `run_saved` | Consultas guardadas (por ID o por ruta, por ejemplo `Shared Queries/Sprint/Bugs`) |

### `wit_work_item_write`
| Acción | Descripción |
| --- | --- |
| `create` | Crea cualquier tipo con cualquier campo, opcionalmente bajo un padre |
| `update` | Asigna o vacía (`null`) campos; acepta JSON-PATCH directo y `expectedRev` |
| `validateOnly` (en create/update) | Comprueba las reglas del proceso sin guardar; el error lista todos los campos inválidos (por ejemplo, `Original Estimate` es obligatorio para pasar una Task a Active) |
| `update_batch` | Actualiza varios items |
| `add_children` | Crea varios hijos; copia Area e Iteration del padre |
| `add_hours` | Suma horas a Completed Work y opcionalmente las descuenta de Remaining Work |
| `delete` | Envía a la papelera de reciclaje (los Test Cases, Plans y Suites solo se pueden borrar desde la web) |

### `wit_comment_write` — `add`, `update`

### `wit_link_write` — `link`, `unlink`
Tipos de link: `child`, `parent`, `related`, `duplicate`, `duplicate of`, `successor`, `predecessor`, `tested by`, `tests`, `affects`, `affected by`, `hyperlink` (por ejemplo, para referenciar un pull request que está en la organización en la nube).

### `testplan` (lectura)
| Acción | Descripción |
| --- | --- |
| `list_plans` / `list_suites` / `list_cases` | Navegar los Test Plans |
| `get_test_case` | Campos, pasos legibles y los work items que prueba |

### `testplan_write`
| Acción | Descripción |
| --- | --- |
| `create_plan` | Nuevo test plan |
| `create_suite` | Estática, por consulta o por requerimiento (una por User Story/Bug) |
| `add_test_cases` | Agrega test cases existentes a una suite |
| `create_test_cases` | Crea test cases con pasos, ligados al work item que prueban y opcionalmente agregados a una suite |
| `update_test_case_steps` | Reemplaza los pasos de un test case |

### Ejemplos de uso

- *"¿Qué hay en el sprint actual del equipo Equipo 1 del Proyecto B, agrupado por estado?"*
- *"Crea 3 tareas bajo la historia 4521 para backend, frontend y QA, con 4 horas restantes cada una."*
- *"Registra 2 horas en la tarea 4533 y descuéntalas del trabajo restante."*
- *"Crea una suite por requerimiento para la historia 4521 en el plan 87 y escribe test cases a partir de sus criterios de aceptación."*

---

## 🤝 Usarlo junto al MCP oficial

Si tu equipo tiene los work items en un Azure DevOps Server propio y los repositorios en Azure DevOps en la nube, puedes usar los dos servidores a la vez:

| Servidor | Dominios | Para qué |
| --- | --- | --- |
| `azdo-onprem` (este) | todos (por defecto) | Work items, sprints, capacidad y Test Plans del servidor propio |
| `azdo-cloud` ([`@azure-devops/mcp`](https://github.com/microsoft/azure-devops-mcp), oficial) | `core repositories pipelines` (opcional `wiki`) | Repositorios, pull requests, ramas y builds en la nube |

**Carga del oficial solo lo que este no cubre.** Este servidor usa los mismos nombres de herramientas que el oficial (`wit_work_item`, `wit_query`, `testplan`, `work`…). Los clientes los distinguen por el nombre del servidor (`mcp__azdo-onprem__wit_work_item` frente a `mcp__azdo-cloud__wit_work_item`), pero si cargas ambos completos la IA puede elegir el equivocado y, por ejemplo, crear una tarea en la nube. Con `-d core repositories pipelines` el oficial solo expone repos y pipelines, y el único dominio repetido es `core`.

### PAT de la nube para el servidor oficial

El oficial acepta un PAT con `-a pat`, pero la variable `PERSONAL_ACCESS_TOKEN` debe contener el **base64 de `email:pat`** (el email puede ser cualquiera). Usa un PAT creado en la organización de la nube, con permisos de Code y Build:

```bash
# macOS / Linux
export ADO_CLOUD_PAT_B64="$(printf '%s' 'tu-email@empresa.com:tu-pat-de-la-nube' | base64)"
```

```powershell
# Windows (PowerShell)
setx ADO_CLOUD_PAT_B64 ([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("tu-email@empresa.com:tu-pat-de-la-nube")))
```

### Claude Code

```bash
claude mcp add --env AZURE_DEVOPS_ORG_URL=https://your-devops-server.com/CollectionName --env AZURE_DEVOPS_PAT=$AZURE_DEVOPS_PAT --scope user --transport stdio azdo-onprem -- npx -y github:dsquintero/azure-devops-server-mcp
```

```bash
claude mcp add --env PERSONAL_ACCESS_TOKEN=$ADO_CLOUD_PAT_B64 --scope user --transport stdio azdo-cloud -- npx -y @azure-devops/mcp TU_ORG_CLOUD -a pat -d core repositories pipelines
```

O en un `.mcp.json` compartido:

```json
{
  "mcpServers": {
    "azdo-onprem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "github:dsquintero/azure-devops-server-mcp"],
      "env": {
        "AZURE_DEVOPS_ORG_URL": "https://your-devops-server.com/CollectionName",
        "AZURE_DEVOPS_PAT": "${AZURE_DEVOPS_PAT}"
      }
    },
    "azdo-cloud": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@azure-devops/mcp", "TU_ORG_CLOUD", "-a", "pat", "-d", "core", "repositories", "pipelines"],
      "env": { "PERSONAL_ACCESS_TOKEN": "${ADO_CLOUD_PAT_B64}" }
    }
  }
}
```

### OpenCode

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "azdo-onprem": {
      "type": "local",
      "command": ["npx", "-y", "github:dsquintero/azure-devops-server-mcp"],
      "enabled": true,
      "timeout": 20000,
      "environment": {
        "AZURE_DEVOPS_ORG_URL": "https://your-devops-server.com/CollectionName",
        "AZURE_DEVOPS_PAT": "{env:AZURE_DEVOPS_PAT}"
      }
    },
    "azdo-cloud": {
      "type": "local",
      "command": ["npx", "-y", "@azure-devops/mcp", "TU_ORG_CLOUD", "-a", "pat", "-d", "core", "repositories", "pipelines"],
      "enabled": true,
      "timeout": 20000,
      "environment": { "PERSONAL_ACCESS_TOKEN": "{env:ADO_CLOUD_PAT_B64}" }
    }
  }
}
```

`TU_ORG_CLOUD` es solo el nombre de la organización (la parte después de `dev.azure.com/`).

### Limitaciones entre la nube y el servidor propio

- **No hay links nativos entre un pull request de la nube y un work item del servidor propio.** Son instancias distintas, así que `link_to_pull_request` del oficial y las menciones `AB#123` en commits no funcionan. Usa `wit_link_write` con `linkType: "hyperlink"` y la URL del PR. La IA puede hacerlo en un solo flujo: *"crea el PR de la rama feature/login y agrega el enlace en la HU 4521"*.
- **Las identidades son distintas:** en el servidor propio suelen ser cuentas de dominio (`DOMINIO\usuario`) y en la nube correos de Entra ID. Cada servidor usa su propio formato al asignar personas.
- **Pide las cosas indicando dónde están** cuando haya ambigüedad: *"en el servidor propio"* o *"en el repo de la nube"*.

---

## ⬆️ Migración desde 1.x

El repositorio se llamaba `devops-mcp-adapter`. Actualiza tu configuración para usar `github:dsquintero/azure-devops-server-mcp` (GitHub redirige el nombre anterior, pero esa redirección puede dejar de funcionar si alguna vez se reutiliza el nombre viejo).

Los nombres de las herramientas cambiaron al diseño basado en acciones:

| 1.x | 2.x |
| --- | --- |
| `get_work_item` | `wit_work_item` → `get` |
| `query_work_items` | `wit_query` → `wiql` |
| `create_work_item` | `wit_work_item_write` → `create` |
| `update_work_item` | `wit_work_item_write` → `update` |
| `delete_work_item` | `wit_work_item_write` → `delete` |
| `create_child_task` | `wit_work_item_write` → `add_children` / `create` con `parentId` |
| `link_work_items` | `wit_link_write` → `link` |
| `add_hours` | `wit_work_item_write` → `add_hours` |

`title`/`assignedTo`/`tags`/`state`/`customFields` se reemplazan por un único mapa `fields`. `AZURE_DEVOPS_PROJECT` y `AZURE_DEVOPS_API_VERSION` ahora son opcionales (la versión se detecta del servidor).

## 🧪 Desarrollo

```bash
npm install
npm test
```

Para probar una copia local en Claude Code u OpenCode, reemplaza el comando `npx` por `node /ruta/absoluta/a/azure-devops-server-mcp/index.js`.

Las pruebas levantan el servidor MCP real por stdio contra un Azure DevOps Server simulado y verifican URLs, versiones de la API y el contenido de las peticiones.
