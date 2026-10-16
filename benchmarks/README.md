# Benchmark data and reproduction

This directory contains the raw measurements used in the [project analysis](../README.md), CSV summaries, and a portable Python analysis script. Rendering and new measurements run in the browser; analyzing the bundled data requires only Python.

## Regenerate the published analysis

Use Python 3.10–3.12. From the repository root:

```sh
python -m pip install -r benchmarks/requirements.txt
python benchmarks/analyze.py
```

For an isolated environment, first run `python -m venv .venv`, then activate it using `.venv\Scripts\Activate.ps1` in PowerShell or `source .venv/bin/activate` in a POSIX shell. If PowerShell activation is restricted, use `.venv\Scripts\python.exe` in place of `python` in the commands above.

The analyzer verifies all six archives and writes ten PNG charts, six CSV summaries, and `validation.json` to `output/benchmark-analysis/`. Choose another destination with `--out output/my-analysis`. Inputs are resolved relative to the script, so analysis does not depend on a particular clone location. The output directory is ignored by Git; selected charts are published in `docs/images/`.

Verification checks the SHA-256 hash of each uncompressed JSON export, configuration and sample counts, nonnegative finite pass times, pass sums, GPU spans, P10/median/P90 values, per-pass medians, and CPU/cluster medians. It recomputes these statistics from 36,450 samples rather than trusting the exported summary. The script also summarizes recorded image errors and checks active-cluster flag counts.

## Capture and analyze new measurements

1. Run `npm ci` and `npm run dev` from the repository root. Use a WebGPU adapter supporting timestamp queries.
2. Set **Seed = 123456789**, then click **Reset fixed scene**. This sets light time to 2,500 ms and pauses light animation.
3. Open **Benchmark** and set **Warmup frames = 12**, **Samples per round = 30**. Select a suite from the table below and its round count.
4. Keep the measuring page visible and pause rendering in other project tabs. Click **Run benchmark**, wait for completion, then **Export JSON**. CSV export is also available for the browser's summary.
5. Analyze the downloaded file, replacing the example path with its actual location:

```sh
python benchmarks/analyze.py --input path/to/export.json --out output/my-run
```

The single-file command validates the samples and writes `summary.csv`. The default command generates the published chart matrix from the complete bundled experiment set. It does not assume a new export contains every historical experiment.

| Browser suite | Rounds used | Compared configurations |
| --- | ---: | --- |
| `full` | 3 | Naive, Forward+, deferred raster; light precomputation off/on for clustered paths. |
| `depth prepass` | 4 | Forward+ with prepass off/on; both light-precomputation settings. |
| `depth culling` | 4 | Forward+, prepass, prepass plus active-cluster culling; both precomputation settings. |
| `g-buffer` | 4 | Raster32, Compute32, Packed16, Packed8 plus depth; both precomputation settings. |

Each suite chooses its own light-count, resolution, and camera configurations. It uses the selected seed/time and restores the previous scene afterward. The current marker reads all depths in a 2 × 2 block. The one-pixel marker archive records the earlier optimization comparison; the supplied analyzer reproduces its chart directly from those samples. The current G-buffer suite measures all four layouts together.

## Experiments and timing

[experiments.json](experiments.json) lists each archive, UTC capture time, metric, counts, and checksum. Gzip preserves the original JSON fields and every sample. The `data/` archives and `summaries/` tables share the same experiment identifiers.

All experiments use Sponza, a 16 × 9 × 24 cluster grid, seed 123456789, fixed light time 2,500 ms, and DPR 1. Light-count tests use 100, 500, 1,000, 2,500, and 5,000 lights at 720p. Resolution tests use 540p, 720p, and 1080p at 1,000 lights. View tests use Atrium, Wall, and Sky at 720p/1,000 lights. Each archive includes browser/adapter metadata, camera poses, benchmark options, run order, individual samples, and aggregate results.

| Field | Meaning |
| --- | --- |
| `passMs` | Duration of each timed GPU pass. |
| `totalMs` | Sum of the timed pass durations. Used for the baseline and isolated prepass analysis. |
| `spanMs` | First timed pass start through last timed pass end, including intervening gaps/clears. Used for culling and G-buffer comparisons. |
| `cpuEncodeMs` | CPU command-encoding time, recorded separately. |
| `medianClusterTotalMs` | Median of each sample's transform-plus-clustering sum. |
| P10 / median / P90 | Linear-interpolated percentiles across all samples for one configuration. |

Common light animation, presentation, CPU encoding, and readback waits are outside GPU timing. Samples await timestamp readback, so these are GPU cost measurements rather than end-to-end FPS. The approximately 0.065536 ms timestamp step limits conclusions from small differences. Compare variants within one batch; new hardware/browser runs need not reproduce the archived absolute times.

## Correctness evidence

- [image-quality.json](data/image-quality.json) contains the 19 final image comparisons, per-variant differences, precision thresholds, and sampled G-buffer reconstruction diagnostics.
- [active-clusters.json](data/active-clusters.json) contains GPU cluster flags for three camera views, visible-cluster counts, conservative extras, and missed-coverage counts. These flags generate the cluster debug figure.

The analyzer regenerates numerical figures from this evidence. Scene screenshots and the walkthrough are recorded media in `docs/`; they can be viewed without running a GPU benchmark.
