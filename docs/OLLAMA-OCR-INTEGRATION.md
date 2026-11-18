---
title: Caelestia-Ink — Integración OCR con Ollama
status: en curso
date: 2026-11-17
cssclasses: [daily, oceano, medium-font]
---

# Integración OCR con Ollama

## Estado

La integración funcional está implementada y cubierta por pruebas automatizadas en el worktree
experimental. La primera validación interactiva detectó que la API OpenAI-compatible limitaba la
solicitud a 4096 tokens; el transporte ya fue corregido y validado con la API nativa y contexto
8192. Falta repetir el flujo interactivo con el build corregido.

| Área | Estado |
| --- | --- |
| Worktree y rama aislada | Verificado |
| Fork local de PDF-to-MD | Verificado |
| Captura de superficie sin interfaz | Verificado automáticamente |
| Comunicación local con Ollama | Verificado automáticamente y contra el servidor real |
| Vista previa editable | Verificada automáticamente y manualmente |
| Destino asociado a la superficie | Verificado automáticamente |
| Inserción concurrente y deshacer | Verificado automáticamente |
| Cancelación lógica | Verificado automáticamente |
| Build de producción | Verificado |
| Carga del build en vault experimental | Verificada |
| Flujo lápiz → Convertir → vista previa → insertar | Verificado manualmente |
| Instalación en vault principal | Verificada tras reiniciar Obsidian |

## Entornos aislados

### Caelestia-Ink

- Worktree: `/mnt/Files/Dev/obsidian-develops/Caelestia-Ink-Ollama-OCR`
- Rama local: `feature/ollama-ocr-integration`
- Base: `faa160d`
- El worktree recibió una copia de todos los cambios sin commit que ya existían en el árbol
  principal. El árbol original no se modificó durante esta integración.

### PDF-to-MD

- Clon: `/mnt/Files/Dev/obsidian-develops/Caelestia-PDF-to-MD`
- Rama local: `feature/caelestia-ocr`
- Versión: `0.2.5`
- Commit: `b0de7794a6158ca483a2cd2373fd1c1bdcd7b2aa`
- Remoto conservado solo como origen; no se realizó push ni se creó otro remoto.
- Licencia: MIT, copyright 2026 Jack Li.

No se modificó el clon de PDF-to-MD. Se utilizó para revisar y atribuir los módulos fuente.

### Node.js

`fnm` no estaba instalado. Se conservó sin tocar perfiles de shell:

- fnm 1.39.0: `/mnt/Files/Dev/obsidian-develops/Caelestia-Ink-tools/bin/fnm`
- Node.js: 24.22.3
- npm: 11.19.1
- Node.js administrado por fnm: `/home/ky-caelestia/.local/share/fnm/node-versions/v24.22.3`
- SHA-256 del script: `8431644b1c205ad25d4b09cfe10e0688944d1d2cd542f38d7b3b10e954db8ad9`

Comandos usados en cada validación:

```bash
eval "$(/mnt/Files/Dev/obsidian-develops/Caelestia-Ink-tools/bin/fnm env --shell bash)"
/mnt/Files/Dev/obsidian-develops/Caelestia-Ink-tools/bin/fnm use 24
npm run check
```

No se cambió la versión global de Node.js ni archivos de inicio de Bash o Fish.

## Componentes reutilizados de PDF-to-MD

Se adaptaron únicamente estos conceptos:

1. Prompt multimodal de transcripción a Markdown y LaTeX.
2. Límite de salida de 2000 tokens.
3. Política acotada de hasta tres intentos con espera incremental.
4. Timeout alrededor de la solicitud.

La atribución aparece en `src/infrastructure/recognition/ollama-ocr-engine.ts` con el commit de
origen y la licencia MIT.

No se copiaron:

- conversión de PDF;
- PDF.js ni su worker remoto;
- compresión de imágenes del plugin externo;
- menús, ajustes o escritor del vault de PDF-to-MD;
- bundle compilado del plugin.

Caelestia-Ink ya tenía un renderizador vectorial apropiado y una arquitectura de conversión más
segura para superficies y ventanas múltiples.

## Arquitectura implementada

```text
toolbar de la ventana
        │ superficie explícita
        ▼
SurfaceManager → ConversionTarget
        │ archivo Blackboard + nota propietaria
        ▼
snapshot inmutable + huella SHA-256
        ▼
región única de página completa
        ▼
CanvasReferenceRenderer
        │ PNG, tinta oscura, fondo blanco, sin toolbar
        ▼
OllamaOcrEngine
        │ GET /api/tags
        │ POST /api/chat
        │ options.num_ctx = 8192
        ▼
Markdown de página completa
        ▼
MarkdownPreviewModal editable
        │ confirmación
        ▼
ObsidianConversionWriter
        │ editor exacto o vault.process
        ▼
nota Markdown propietaria
```

### Asociación superficie-destino

El clic de la toolbar entrega su objeto `DrawingSurface` a `ConversionController.start(surface)`.
El controlador no consulta una superficie global si recibió esa referencia. `SurfaceManager`
resuelve el `ConversionTarget` registrado para esa superficie exacta.

Los embeds Markdown registran además un getter de nota propietaria. La nota se busca por el leaf
que contiene físicamente el embed, no mediante `workspace.getActiveFile()`. Esto evita insertar
en otra nota cuando hay varias pestañas o ventanas.

Una vista `.blackboard` independiente o una superficie de Canvas no presupone un destino. En
ese caso se abre un selector de notas Markdown. Cancelarlo no modifica nada.

Obsidian cierra internamente `FuzzySuggestModal` antes de ejecutar `onChooseItem`. La
implementación anterior resolvía `null` desde `onClose` y descartaba la ruta elegida. La
cancelación ahora se difiere un microtask y la resolución es idempotente: la selección explícita
gana la carrera y se conserva aunque la nota esté en otra pestaña.

La toolbar global se oculta en vistas Markdown, incluso cuando contienen un embed Blackboard.
El embed y sus trazos permanecen montados; solo se desactiva la vinculación visual de la toolbar.

### Captura

Se reutiliza `CanvasReferenceRenderer`:

- consume el snapshot de trazos, no el canvas visible;
- excluye toolbar, botones, zoom y desplazamiento de la interfaz;
- conserva proporciones y orientación;
- añade 20 unidades de margen por lado;
- renderiza hasta 2× cuando hay resolución disponible;
- limita el lado mayor a 2048 px sin recortar;
- normaliza pluma a negro sobre blanco;
- mantiene el color, presión y geometría originales solo en el snapshot;
- no modifica ni borra los trazos.

GLM-OCR recibe una región única con todos los trazos. La segmentación heurística por regiones se
mantiene para MathNote, pero no divide una página antes de enviarla al modelo multimodal.

## Comunicación con Ollama

Motor: `src/infrastructure/recognition/ollama-ocr-engine.ts`.

Configuración efectiva:

| Campo | Valor |
| --- | --- |
| Endpoint base | `http://127.0.0.1:11434` |
| Ruta de reconocimiento | `/api/chat` |
| Modelo | `glm-ocr:q8_0` |
| Timeout | 180 s |
| Intentos máximos | 3 |
| Contexto por solicitud | 8192 tokens |
| Salida máxima | 2000 tokens |
| Temperatura | 0 |
| Servicios externos | Ninguno |

Controles de seguridad:

1. Solo se acepta `http:` con host `127.0.0.1` o `localhost`.
2. Solo se acepta el puerto 11434.
3. La ruta guardada solo puede estar vacía o ser `/v1`; esta última se acepta para migrar la
   configuración anterior y se normaliza al origen local.
4. El motor rechaza cualquier modelo distinto de `glm-ocr:q8_0`.
5. Antes de renderizar consulta `/api/tags` y comprueba que el modelo exista.
6. No descarga modelos ni cambia la configuración del servicio.
7. Respuestas vacías, mal formadas o excesivas se rechazan.
8. Un bloque cercado exterior se elimina; el contenido interno no se reescribe.

Prompt inicial:

```text
Transcribe only the visible content of this handwritten page as Markdown.
Requirements:
1. Preserve the reading order and the original text; do not solve, correct, or explain exercises.
2. Convert mathematical expressions to Obsidian-compatible LaTeX using $...$ or $$...$$.
3. Preserve tables as Markdown when their structure is clear.
4. Do not invent illegible content. Use [ilegible] only where content cannot be read.
5. Output only Markdown, without commentary or code fences.
```

La primera prueba de este prompt sobre `/tmp/opencode/real-board.png`, mediante la API
OpenAI-compatible, produjo tras un arranque frío de 62,17 s:

```markdown
Depende como realizamos el proyecto
$$\frac{2}{3}=x-y=f$$
```

Respuesta completa: `/tmp/opencode/ollama-integration-prompt-response.json`.

### Fallo de contexto y corrección

La primera prueba manual del build `926691e4...` falló antes de abrir la vista previa:

```text
request (4161 tokens) exceeds the available context size (4096 tokens)
```

La ruta `/v1/chat/completions` no permite fijar `num_ctx` por solicitud. No se creó otro modelo,
porque el alcance exige conservar exclusivamente `glm-ocr:q8_0`. El motor se migró a la API
nativa de Ollama:

```json
{
  "model": "glm-ocr:q8_0",
  "messages": [{
    "role": "user",
    "content": "<prompt>",
    "images": ["<PNG en base64>"]
  }],
  "stream": false,
  "options": {
    "num_ctx": 8192,
    "num_predict": 2000,
    "temperature": 0
  }
}
```

El 2026-11-17 la misma imagen fue aceptada por `/api/chat` en 3,939 s y devolvió exactamente el
mismo Markdown. `ollama ps` confirmó `CONTEXT 8192`, ejecución 100 % GPU y el único modelo
`glm-ocr:q8_0`. Respuesta completa:
`/tmp/opencode/ollama-native-8192-response.json`.

### Cancelación

Cerrar el modal o pulsar Cancelar aborta el pipeline y descarta cualquier respuesta posterior.
`requestUrl` no expone un `AbortSignal`, por lo que la solicitud HTTP ya iniciada puede terminar
en segundo plano; su resultado nunca llega a la vista previa ni a la nota después de cancelar.
Esta es una limitación conocida de la API usada, no una pérdida de protección de datos.

## Vista previa

La vista previa existente se reutiliza sin rediseño:

- render Markdown y LaTeX;
- textarea editable;
- diagnóstico separado que no se guarda;
- botones Insertar en nota y Cancelar;
- el botón de inserción se deshabilita durante la escritura;
- cancelar no modifica la nota ni la superficie.

Para GLM-OCR la página aparece como una región de texto que puede contener Markdown y bloques
LaTeX. Las reglas avanzadas de formato quedan fuera de esta entrega.

## Inserción en Markdown

El destino se conserva desde el clic inicial. Al confirmar:

1. Se vuelve a comprobar que la ruta siga siendo una nota Markdown existente.
2. Si esa nota tiene un editor abierto, se usa su editor exacto aunque otra pestaña esté activa.
3. `replaceRange` inserta al final del contenido actual y conserva deshacer.
4. Si no hay editor abierto, `vault.process` transforma atómicamente la versión más reciente.
5. Nunca se usa una posición de cursor guardada antes del OCR.
6. Nunca se reemplaza contenido ni se eliminan trazos.
7. Se añade un comentario HTML con la huella del snapshot para impedir una inserción duplicada:
   `<!-- caelestia-ocr:<sha256> -->`.
8. Si la nota fue movida o eliminada, la operación se detiene.

## Archivos creados

- `src/infrastructure/recognition/ollama-ocr-engine.ts`
- `test/ollama-ocr-engine.test.ts`
- `test/conversion-controller.test.ts`
- `docs/OLLAMA-OCR-INTEGRATION.md`

## Archivos modificados para la integración

- `src/domain/entities.ts`
- `src/domain/recognition.ts`
- `src/application/recognition/convert-blackboard.ts`
- `src/application/recognition/segmentation.ts`
- `src/application/recognition/markdown-assembler.ts`
- `src/infrastructure/recognition/obsidian-output-writer.ts`
- `src/presentation/embed.ts`
- `src/presentation/conversion-modals.ts`
- `src/presentation/settings.ts`
- `src/main.ts`
- `test/embed.test.ts`
- `test/main.test.ts`
- `test/settings.test.ts`
- `test/types.test.ts`
- `test/validate-settings.test.ts`
- `test/recognition-pipeline.test.ts`
- `test/reference-renderer.test.ts`
- `test/conversion-writer.test.ts`

El worktree contiene otros archivos modificados y no rastreados que ya existían antes de esta
segunda entrega. No se descartaron ni sobrescribieron en el árbol original.

## Pruebas automatizadas

Comando:

```bash
eval "$(/mnt/Files/Dev/obsidian-develops/Caelestia-Ink-tools/bin/fnm env --shell bash)"
/mnt/Files/Dev/obsidian-develops/Caelestia-Ink-tools/bin/fnm use 24
cd /mnt/Files/Dev/obsidian-develops/Caelestia-Ink-Ollama-OCR
npm run check
```

Resultado del 2026-11-17:

- TypeScript: aprobado.
- ESLint: sin errores; 12 advertencias de estilo/deprecación no bloqueantes.
- Vitest: 759 pruebas aprobadas en 33 archivos.
- Build de producción: aprobado, `main.js` de 153,0 kB.
- SHA-256 de `main.js`: `ec1515b9ec5e820ea62742abd7bce1cd479f3cf2d623ab2f9c87a2879013194b`.

Cobertura funcional añadida:

- payload y prompt de Ollama;
- API nativa, imagen en `messages[].images` y contexto 8192;
- servidor desconectado;
- modelo ausente;
- endpoint externo rechazado;
- modelo distinto rechazado;
- reintento ante HTTP 500;
- cancelación antes y durante una solicitud;
- respuesta Markdown mal cercada normalizada;
- página completa como una región sin frontmatter;
- rechazo de superficie vacía;
- captura con margen, proporción y límite de 2048 px;
- routing por superficie y nota propietaria;
- bloqueo inmediato de clics repetidos;
- inserción sobre contenido concurrente;
- inserción en la pestaña original aunque otra esté activa;
- marcador contra duplicados;
- error si la nota destino desaparece;
- conservación del archivo Blackboard original.

`npm ci` informó 60 vulnerabilidades transitivas del árbol existente. No se ejecutó
`npm audit fix` porque implicaría cambios generales de dependencias fuera del alcance.

## Instalación experimental

Vault del primer intento manual, conservado como evidencia del fallo de contexto:

`/tmp/opencode/caelestia-ocr-test-vault-20261117-1415`

El nuevo vault corregido se documenta tras su preparación y no sobrescribe el anterior.

Vault corregido con API nativa y contexto 8192:

`/tmp/opencode/caelestia-ocr-test-vault-20261117-1435-native8192`

Contiene:

- build experimental bajo `.obsidian/plugins/blackboard`;
- configuración local de Ollama;
- una copia de una pizarra real, sin modificar el original;
- `Prueba OCR.md` con el embed correspondiente.

No comparte directorio con el vault principal. Solo contiene un plugin con ID `blackboard`, por
lo que no hay dos plugins con el mismo ID en ese vault.

El build corregido se instaló en `/mnt/shared/OBSIDIAN/.obsidian/plugins/blackboard`. Solo se
reemplazó `main.js`; `styles.css`, `manifest.json` y los ajustes existentes se conservaron.
Hashes:

- `main.js`: `ec1515b9ec5e820ea62742abd7bce1cd479f3cf2d623ab2f9c87a2879013194b`
- `styles.css`: `69adf9ed144bb73aa681ef0310faaad810ff91074d829cdf95791607b94b0e0d`

Respaldo previo:

`/mnt/Files/Dev/obsidian-develops/Caelestia-Ink-backups/20261117-145710-before-markdown-selector-fix`

PDF-to-MD estable conserva su `main.js` con SHA-256
`752f851e2bfecf2fffa0b6cb1dbbe2583c21c1845b1a5be08dc507841037ce6d`.

## Validación manual

El 2026-11-18 el usuario confirmó en el vault principal:

- conversión de una pizarra independiente;
- selección de una nota ubicada en otra pestaña;
- reconocimiento matemático;
- conservación de trazos;
- protección contra duplicados;
- conversión de imagen dentro de Markdown;
- toolbar y Blackboard incrustado;
- persistencia después de reiniciar Obsidian.

## Limitaciones y pendientes

1. La solicitud HTTP subyacente no puede cancelarse físicamente mediante `requestUrl`; solo se
   cancela su consumo y la operación de UI.
2. El prompt usa una página completa; pizarras extremadamente densas pueden superar el límite de
   2000 tokens o perder detalle al reducirse a 2048 px.
3. GLM-OCR no aporta una confianza por palabra; la revisión humana sigue siendo obligatoria.
4. Una vista independiente o Canvas requiere selección explícita de nota destino.
5. La integración de Ollama es de escritorio; no se ofrece como función móvil.
6. Las reglas avanzadas de Markdown y convenciones matemáticas quedan para otra etapa.
7. Las 12 advertencias de lint deben evaluarse por separado; no bloquean build ni pruebas.

## Cambios para la siguiente etapa

1. Añadir una prueba E2E real de Obsidian si se incorpora un arnés de escritorio al repositorio.
2. Decidir si se reemplaza `requestUrl` por un transporte cancelable compatible con Obsidian.
3. Medir páginas grandes y, si hace falta, implementar mosaicos sin alterar el orden de lectura.
4. Evaluar prompts personalizados solo después de validar la integración base.
5. Revisar las dependencias vulnerables en una tarea independiente.

No se realizó commit ni push.
