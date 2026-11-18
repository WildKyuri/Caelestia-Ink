---
title: Caelestia-Ink — Evaluación de PDF-to-MD con Ollama
status: en curso
date: 2026-11-17
cssclasses: [daily, oceano, medium-font]
---

# Evaluación de PDF-to-MD con Ollama

## Resultado

La primera entrega quedó funcional y verificada el 2026-11-17. PDF-to-MD 0.2.5 convierte
imágenes y PDF desde Obsidian mediante GLM-OCR Q8 en Ollama local. Blackboard permanece
habilitado y su instalación no fue modificada.

No se creó todavía un clon de PDF-to-MD ni se integró código en Caelestia-Ink. La integración
es una segunda etapa y requiere aprobación.

## Estado de tareas

| Tarea | Estado | Evidencia |
| --- | --- | --- |
| Diagnóstico de equipo y software | Verificado | Datos de las secciones siguientes |
| Ollama instalado como servicio | Verificado | `ollama.service` activo y habilitado |
| Servicio limitado a localhost | Verificado | `127.0.0.1:11434`; no escucha en interfaces externas |
| GLM-OCR Q8 instalado | Verificado | Digest y metadatos registrados abajo |
| Visión mediante API nativa | Verificado | Imagen real manuscrita y fórmula |
| API compatible con OpenAI | Verificado | `/v1/chat/completions` con el prompt real del plugin |
| PDF-to-MD 0.2.5 instalado | Verificado | Hashes iguales a la release oficial |
| Plugin cargado en Obsidian | Verificado | Instancia activa junto con `blackboard` |
| Imagen manuscrita | Verificado | Transcripción exacta en la muestra real |
| Fórmulas | Verificado con errores conocidos | Hoja sintética correcta; recorte real confundió `f` con `0` |
| Documento mixto | Verificado | Texto y fórmula exactos en la imagen original |
| PDF de dos páginas | Verificado con error conocido | Orden y separador correctos; una palabra incorrecta |
| Imagen incrustada | Verificado | Markdown insertado debajo del embed en una nota temporal |
| Caelestia-Ink intacto | Verificado | Plugin cargado y hashes del build instalado coincidentes |
| Repetir `npm run check` | Bloqueado en esta sesión | Shell actual: Node 22.23.5; el proyecto exige Node `>=24` |
| Prueba manual de dibujo con lápiz | Pendiente | Requiere interacción física en la interfaz |
| Clon y rama de PDF-to-MD | Pendiente por aprobación | No iniciar durante la primera entrega |
| Integración con Caelestia-Ink | Pendiente por aprobación | Solo se propone arquitectura |

## Diagnóstico del equipo

| Componente | Valor |
| --- | --- |
| Sistema | Arch Linux x86_64, kernel `7.2.15-arch1-1` |
| CPU | AMD Ryzen 5 5600G, 6 núcleos y 12 hilos |
| RAM | 31 GiB |
| GPU | NVIDIA GeForce RTX 2060, 6 GiB VRAM |
| Driver | NVIDIA 615.78.08; CUDA 13.4 detectada por Ollama |
| Espacio libre inicial | 254 GiB en `/`; 1,6 TiB en `/mnt/Files`; 131 GiB en `/mnt/shared` |
| Node.js de la shell | 22.23.5 |
| npm | 12.2.2 |
| fnm | No disponible en `PATH` |
| Vault | `/mnt/shared/OBSIDIAN` |
| Repositorio | `/mnt/Files/Dev/obsidian-develops/Caelestia-Ink` |

El repositorio estaba y continúa en `main`, con cambios locales sin commit. No se realizó
commit, push, reset ni descarte de archivos.

## Componentes instalados

### Ollama

| Campo | Valor |
| --- | --- |
| Versión | 0.40.16 |
| Binario | `/usr/local/bin/ollama` |
| Servicio | `/etc/systemd/system/ollama.service` |
| Estado | Activo y habilitado |
| Endpoint | `http://127.0.0.1:11434` |
| Modelo | `glm-ocr:q8_0` |
| Digest | `6e5935a916fc8d6878a67c60c2b99648f54e10b4a4af4cbbfb2c308953000e5f` |
| Descarga | 1,8 GB |
| Cuantización | Q8_0 |
| Parámetros | 891,14 M; proyector visual de 434,12 M |
| Contexto declarado | 131072 tokens |
| Capacidades | Completion, visión y tools |

Se eligió Q8 en lugar de BF16 porque la RTX 2060 tenía aproximadamente 3,5–3,7 GiB de VRAM
libres con el escritorio abierto. PDF-to-MD declara Q8 como variante probada y el modelo quedó
completamente en GPU. No se descargaron otros modelos.

El instalador oficial revisado quedó en `/tmp/opencode/ollama-install.sh`, con SHA-256
`25f64b810b947145095956533e1bdf56eacea2673c55a7e586be4515fc882c9f`.

### PDF-to-MD

| Campo | Valor |
| --- | --- |
| Versión | 0.2.5 |
| Origen | Release oficial de `kkbin505/pdf-to-md` |
| Instalación | `/mnt/shared/OBSIDIAN/.obsidian/plugins/pdf-to-md` |
| `main.js` SHA-256 | `752f851e2bfecf2fffa0b6cb1dbbe2583c21c1845b1a5be08dc507841037ce6d` |
| `manifest.json` SHA-256 | `be4dec554afc800f720147f05974c824aa63f062f8848b9477cb5bf06620487b` |
| Respaldo de plugins | `.obsidian/community-plugins.json.bak-20261117-131918` |

No se modificó el código de la release. Se añadió `pdf-to-md` a la lista de plugins comunitarios
sin deshabilitar Blackboard ni eliminar MathNote.

## Configuración efectiva

Archivo: `/mnt/shared/OBSIDIAN/.obsidian/plugins/pdf-to-md/data.json`.

```json
{
  "provider": "local",
  "selectedModelId": "local-openai",
  "localBaseUrl": "http://127.0.0.1:11434/v1",
  "localModel": "glm-ocr:q8_0",
  "dpi": 150,
  "timeout": 180,
  "conflictResolution": "timestamp"
}
```

PDF-to-MD fija internamente `maxRetries: 3`; no hay un ajuste visible adicional. El modo
`timestamp` crea un nombre nuevo para cada resultado y evita sobrescribir una nota previa.
No se configuró ninguna clave ni API comercial.

## Pruebas y calidad

Los artefactos conservados para revisión están en:

`/mnt/shared/OBSIDIAN/99 Meta/Temporary PDF-to-MD Tests/20261117-132126`

### API de Ollama

| Prueba | Resultado | Tiempo observado |
| --- | --- | --- |
| API nativa, imagen mixta, arranque frío | Texto y fórmula exactos | 63,98 s totales; 27,39 s de carga |
| API nativa, manuscrito, modelo caliente | Texto exacto | 0,50 s |
| API nativa, recorte de fórmula real | `f` final reconocida como `0` | 0,29 s |
| API `/v1`, prompt exacto de PDF-to-MD | Texto y fórmula exactos | 0,23 s |

La prueba fría produjo:

```markdown
Depende como realizamos el proyecto
$$\frac{2}{3}=x-y=f$$
```

Durante la inferencia el modelo estuvo al 100 % en GPU. La diferencia de VRAM total fue de
aproximadamente 2,4 GiB con el modelo cargado. El timeout de 180 s deja margen suficiente para
el primer arranque.

### Plugin oficial dentro de Obsidian

| Archivo | Resultado | Tiempo de llamada |
| --- | --- | --- |
| `01 Escritura manuscrita.png` | `Depende como realizamos el proyecto` | 0,41 s |
| `02 Fórmulas.png` | Fracción, potencia, raíz, integral y matriz correctas | 3,14 s |
| `03 Documento mixto.png` | Texto y `$$\frac{2}{3}=x-y=f$$` exactos | 0,93 s |
| `04 Documento multipágina.pdf` | Dos páginas ordenadas y separadas por `---` | 5,94 s |
| Imagen incrustada en `05 Imagen incrustada.md` | Texto insertado debajo del embed | 0,15 s |

La salida matemática de la hoja preparada fue:

```markdown
$$\frac{2}{3} + x^2 = 7$$
$$\sqrt{(x+1)} = 4$$
$$\int_{0}^{1} x^2 dx = 1/3$$
$$A = \begin{bmatrix} 1 & 2 \\ 3 & 4 \end{bmatrix}$$
```

Errores encontrados:

1. Un recorte estrecho de la fórmula real produjo `$$\frac{2}{3}=x-y=0$$`; la imagen mixta
   completa reconoció correctamente la `f`.
2. La segunda página del PDF produjo «Depende como realizarnos el proyecto» en lugar de
   «realizamos». El mismo PNG convertido directamente fue exacto.
3. Una respuesta HTTP correcta no garantiza transcripción correcta; se mantiene obligatoria
   la revisión visual antes de usar el resultado para estudiar.

## Uso inmediato

1. Asegurar que el servicio esté activo:

   ```bash
   systemctl is-active ollama
   ```

2. En el explorador de archivos de Obsidian, abrir el menú contextual de un PDF o una imagen.
3. Elegir **Convert to Markdown** o **Convert Image to Markdown**.
4. Esperar el aviso de finalización. El resultado aparece junto al original con timestamp UTC.
5. Revisar texto y LaTeX visualmente, en especial caracteres cortos como `f`, `0`, `l` y `1`.
6. Para un embed, usar **Convert Image to Markdown** desde su menú contextual; el texto se
   inserta debajo de la línea de imagen en la nota activa.

Si el primer uso tarda cerca de un minuto, corresponde a la carga fría. Los usos siguientes
suelen tardar segundos mientras Ollama conserva el modelo cargado.

## Arquitectura de PDF-to-MD 0.2.5

El plugin oficial separa estas responsabilidades:

- `main.ts`: registro de menús, selección de proveedor, lectura y escritura en el vault;
- `src/settings.ts`: modelos, proveedor local, DPI, timeout y política de conflictos;
- `src/providers/openai-compat.ts`: solicitud multimodal a `/chat/completions` y prompt;
- `src/providers/base.ts`: contrato del proveedor;
- `src/converter.ts`: conversión secuencial, timeout, tres reintentos y unión de páginas;
- `src/image.ts`: render de páginas PDF a imágenes;
- `src/utils/image-compress.ts`: compresión previa de imágenes.

La instalación oficial contiene el bundle compilado. Cualquier reutilización futura debe partir
del repositorio fuente, conservar MIT y avisos de copyright, y hacerse en un clon independiente.

## Propuesta de integración con Caelestia-Ink

No implementada.

1. `SurfaceManager` resuelve el `ConversionTarget` de la superficie activa en la ventana que
   originó la acción.
2. El pipeline existente crea un snapshot inmutable; la pizarra original permanece editable.
3. `ReferenceRenderer` rasteriza solo el contenido de esa superficie con fondo y resolución
   adecuados, sin capturar otras ventanas ni usar una miniatura.
4. Un adaptador nuevo, por ejemplo `OllamaGlmOcrEngine`, envía la imagen a
   `http://127.0.0.1:11434/v1/chat/completions` bajo demanda.
5. El adaptador devuelve un candidato estructurado al pipeline; no escribe archivos ni modifica
   trazos.
6. `MarkdownPreviewModal` muestra Markdown y LaTeX editables junto con advertencias.
7. Solo tras confirmación, `ObsidianConversionWriter` crea el resultado con un nombre único.
8. Cancelación, timeout y diagnóstico permanecen asociados a la conversión concreta y no a una
   instancia global, para respetar superficies y ventanas múltiples.

El OCR debe seguir siendo manual. No se propone inferencia continua ni sustitución automática
de la escritura.

### Piezas reutilizables

De Caelestia-Ink:

- `src/presentation/surface-manager.ts`: superficie y destino activos por ventana;
- `src/domain/recognition.ts`: contratos de snapshot, motor, borrador y progreso;
- `src/infrastructure/recognition/reference-renderer.ts`: imagen de referencia;
- `src/application/recognition/convert-blackboard.ts`: orquestación;
- `src/presentation/conversion-modals.ts`: progreso, edición y confirmación;
- `src/infrastructure/recognition/obsidian-output-writer.ts`: escritura no destructiva.

De PDF-to-MD, como conceptos o código fuente MIT revisado:

- payload multimodal compatible con OpenAI;
- prompt de Markdown y LaTeX;
- timeout y política de tres reintentos;
- configuración de endpoint y modelo local.

La conversión PDF y PDF.js no son necesarias para capturar una superficie de Blackboard. No
debe incorporarse el bundle completo ni acoplar `SurfaceManager` a la clase del plugin externo.

## Riesgos

1. **Dependencia de red para PDF:** PDF-to-MD 0.2.5 fija el worker en
   `https://unpkg.com/pdfjs-dist@5.7.284/legacy/build/pdf.worker.min.mjs`. El OCR es local, pero
   la conversión PDF oficial no es completamente offline.
2. **Errores OCR plausibles:** el modelo puede cambiar una palabra o símbolo sin advertirlo.
3. **Sin puntuación de confianza útil:** la salida del endpoint no permite decidir por sí sola si
   una transcripción debe aceptarse.
4. **VRAM compartida:** otras aplicaciones ya consumen cerca de 2 GiB; BF16 puede forzar
   descarga parcial a CPU. Mantener Q8 como valor predeterminado en este equipo.
5. **Arranque frío:** puede rondar un minuto; no reducir el timeout de 180 s sin repetir medidas.
6. **Salida limitada:** PDF-to-MD usa `max_completion_tokens: 2000`; páginas densas podrían
   truncarse y requieren prueba específica.
7. **Escritura en conflicto:** aunque `timestamp` reduce colisiones, el formato solo tiene
   precisión de minutos. Conversiones simultáneas del mismo archivo podrían coincidir.
8. **Móvil:** Ollama local no está disponible de forma uniforme para Obsidian móvil.
9. **Licencias y procedencia:** revisar la licencia de GLM-OCR, sus pesos y datasets antes de
   redistribuir artefactos; esta prueba local no concede derechos de redistribución.

## Pendientes para una segunda etapa

1. Obtener aprobación explícita para clonar PDF-to-MD y crear
   `feature/caelestia-ocr-integration`.
2. Fijar el origen y la licencia de cada fragmento reutilizado.
3. Diseñar ajustes de endpoint, modelo, prompt, timeout y validación estricta de localhost.
4. Implementar un adaptador aislado y pruebas con un servidor Ollama simulado.
5. Evaluar un corpus mayor de apuntes reales en español y fórmulas de examen.
6. Probar cancelación, modelo descargado, Ollama detenido, timeout y respuestas truncadas.
7. Ejecutar `npm run check` con Node 24 o superior antes de instalar cualquier build nuevo.
8. Validar manualmente Blackboard con lápiz en vista normal, embed y ventana desprendida.
9. Resolver el worker PDF remoto en el futuro fork si se exige operación completamente offline.
