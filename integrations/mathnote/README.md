# mathnote-ocr integration probe

Prepared and executed on 2026-11-17 in an isolated CPython 3.12.16 environment. The global
Python installation was not modified.

## Why this engine

- Input is stroke data, the same representation Caelestia-Ink already stores.
- The repository, package metadata and bundled weights ship under Apache-2.0.
- About 1.2 M parameters; the project states it runs on CPU.
- Incremental detection and pinned subtrees, useful for interactive correction.
- No network access after installation.

## Compatibility checks

| Item | Result |
| --- | --- |
| License | Apache-2.0, repository and PyPI package; weights inside the wheel |
| Python | `>=3.10` declared; PyTorch wheels available for 3.11–3.13, not 3.14 |
| Runtime | Python 3.10+, PyTorch 2.4+, torchvision, NumPy, Pillow, PyYAML, ziamath |
| Wheel | `mathnote_ocr-0.2.1-py3-none-any.whl`, ~8 MB including default weights |
| Disk | CPU-only PyTorch keeps the environment around 500 MB–1 GB, not the CUDA multi-GB set |
| GPU | Not required |
| Network | Not required during inference |
| Mobile | Not viable: Python sidecar cannot run inside Obsidian mobile |

## Persistent environment

```bash
/mnt/Files/Dev/obsidian-develops/Caelestia-Ink-tools/bin/uv python install 3.12.16 --install-dir /mnt/Files/Dev/obsidian-develops/Caelestia-Ink-tools/python --no-bin
/mnt/Files/Dev/obsidian-develops/Caelestia-Ink-tools/bin/uv venv --python /mnt/Files/Dev/obsidian-develops/Caelestia-Ink-tools/python/cpython-3.12.16-linux-x86_64-gnu/bin/python3.12 /mnt/Files/Dev/obsidian-develops/Caelestia-Ink-tools/venvs/mathnote-ocr-0.2.1
/mnt/Files/Dev/obsidian-develops/Caelestia-Ink-tools/bin/uv pip install --python /mnt/Files/Dev/obsidian-develops/Caelestia-Ink-tools/venvs/mathnote-ocr-0.2.1/bin/python torch==2.15.0+cpu torchvision==0.29.2+cpu --index-url https://download.pytorch.org/whl/cpu
/mnt/Files/Dev/obsidian-develops/Caelestia-Ink-tools/bin/uv pip install --python /mnt/Files/Dev/obsidian-develops/Caelestia-Ink-tools/venvs/mathnote-ocr-0.2.1/bin/python mathnote-ocr==0.2.1
```

`requirements.lock` records the complete verified environment. The CPU PyTorch packages use
their own index, so installation remains split into the two explicit commands above.

Verified persistent environment:

```text
/mnt/Files/Dev/obsidian-develops/Caelestia-Ink-tools/venvs/mathnote-ocr-0.2.1
Python 3.12.16
torch 2.15.0+cpu
torchvision 0.29.2+cpu
mathnote-ocr 0.2.1
probe: {"latex":"+","confidence":0.85,"engine":"mathnote-ocr"}
```

## Probe

```bash
printf '%s' '{"strokes":[[[10,40],[40,40],[70,40]],[[40,10],[40,40],[40,70]]]}' \
  | python integrations/mathnote/probe.py
```

Expected shape:

```json
{"latex": "...", "confidence": 0.0, "engine": "mathnote-ocr"}
```

The probe deliberately prints failures as JSON; it never modifies a `.blackboard` file and
does not start a persistent server.

## Benchmark acceptance criteria

- 50 expressions taken from real Caelestia-Ink boards, strokes only.
- Exact normalized LaTeX match and render-equivalent rate reported separately.
- p95 latency per region below 1 s on this machine.
- Peak RSS below 1.5 GB.
- No network requests during detection.
- Cancellation leaves no zombie process.
- Low-confidence results keep the SVG fallback instead of writing guessed LaTeX.

## Integrated sidecar

A desktop-only sidecar is launched on demand, one JSON request per region:

```text
Obsidian (TypeScript) → stdin JSON → Python probe → stdout JSON → RegionContent
```

The adapter maps `SnapshotStroke[]` to `(x, y)` pairs without reordering, rounds coordinates
to two decimals and applies no origin/scale transformation. Regions below confidence 0.75 or
above 15 % unexplained strokes stay `unknown` and keep SVG. The user can edit LaTeX per
region before saving. The child is killed after success, error, timeout or cancellation.

Regenerate the embedded source after editing `sidecar.py`:

```bash
npm run sidecar:embed
```

## Measured results

- Real Blackboard formula: `\\frac{2}{3} = x - - W -` for `2/3 = x − y = f`; confidence
  1.0, one of 13 strokes unexplained, first detection about 1.1 s.
- Same process, subsequent real text region: about 76 ms, but rejected at confidence 0.436.
- External human corpus `run_001`, 81 samples: 40.7 % canonical exact match, mean CER 0.277,
  median 48 ms, maximum 2256 ms.
- Final sidecar smoke test: peak child RSS approximately 355,904 KB; process exited and no
  sidecar remained.

These numbers show that confidence alone is not a correctness guarantee. Keep the provider
experimental and inspect/edit every equation in the preview.
