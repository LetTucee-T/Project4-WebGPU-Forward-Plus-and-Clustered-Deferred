"""Validate WebGPU benchmark exports and reproduce the published figures.

python benchmarks/analyze.py
python benchmarks/analyze.py --input path/to/export.json --out output/my-run
All inputs are repository-relative or explicitly supplied. No browser is required.
"""
import argparse
import csv
import gzip
import hashlib
import json
import math
from pathlib import Path

import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
CONFIG = ['width', 'height', 'lights', 'camera', 'mode', 'precompute',
          'depthPrepass', 'depthCulling', 'deferredVariant']
COLORS = ['#2563eb', '#0f766e', '#d97706', '#9d174d', '#64748b']
LIGHTS = [100, 500, 1000, 2500, 5000]


def read(path):
    raw = path.read_bytes()
    return gzip.decompress(raw) if path.suffix == '.gz' else raw


def key(row):
    defaults = dict(depthPrepass=False, depthCulling=False, deferredVariant='raster')
    return tuple(row.get(field, defaults.get(field)) for field in CONFIG)


class Report:
    def __init__(self, path):
        self.data = json.loads(read(path))
        if self.data['status'] != 'completed':
            raise ValueError(f'{path.name}: benchmark did not complete')
        self.rows = {key(row): row for row in self.data['summary']}
        assert len(self.rows) == len(self.data['summary']), 'Duplicate configuration'
        grouped, rounds = {}, {}
        for run in self.data['runs']:
            k = key(run['configuration'])
            grouped.setdefault(k, []).extend(run['samples'])
            rounds[k] = rounds.get(k, 0) + 1
            for sample in run['samples']:
                assert all(math.isfinite(v) and v >= 0 for v in sample['passMs'].values())
                assert math.isclose(sum(sample['passMs'].values()), sample['totalMs'], abs_tol=1e-8)
                assert sample.get('spanMs', sample['totalMs']) + 1e-8 >= sample['totalMs']
        assert grouped.keys() == self.rows.keys(), 'Runs and summary differ'
        self.computed = []
        for k, samples in grouped.items():
            row = self.rows[k]
            assert len(samples) == row['samples'] and rounds[k] == row['rounds']
            result = dict(zip(CONFIG, k), samples=len(samples), rounds=rounds[k])
            for source, label in [('totalMs', 'Total'), ('spanMs', 'Span')]:
                if source not in samples[0]:
                    continue
                values = [sample[source] for sample in samples]
                for quantile, prefix in [(.5, 'median'), (.1, 'p10'), (.9, 'p90')]:
                    field = f'{prefix}{label}Ms'
                    value = float(np.quantile(values, quantile))
                    assert math.isclose(value, row[field], abs_tol=1e-8), (path.name, field)
                    result[field] = value
            for name, value in row['medianPassMs'].items():
                actual = float(np.median([sample['passMs'][name] for sample in samples]))
                assert math.isclose(actual, value, abs_tol=1e-8), (path.name, name)
                result[name + 'MedianMs'] = actual
            for field, values in [
                ('medianCpuEncodeMs', [sample['cpuEncodeMs'] for sample in samples]),
                ('medianClusterTotalMs', [sample['passMs'].get('transform', 0) + sample['passMs'].get('clustering', 0) for sample in samples]),
            ]:
                actual = float(np.median(values))
                assert math.isclose(actual, row[field], abs_tol=1e-8), (path.name, field)
                result[field] = actual
            self.computed.append(result)
        self.sample_count = sum(len(samples) for samples in grouped.values())

    def select(self, **settings):
        config = dict(width=1280, height=720, lights=1000, camera='Atrium', mode='forward+',
                      precompute=False, depthPrepass=False, depthCulling=False, deferredVariant='raster')
        config.update(settings)
        return self.rows[key(config)]

    def csv(self, path):
        fields = list(dict.fromkeys(field for row in self.computed for field in row))
        with path.open('w', encoding='utf-8', newline='') as stream:
            writer = csv.DictWriter(stream, fieldnames=fields)
            writer.writeheader()
            writer.writerows(self.computed)


def save(fig, out, name, note):
    fig.text(.06, .025, note, fontsize=9, color='#475569')
    fig.savefig(out / name, dpi=150, bbox_inches='tight')
    plt.close(fig)


def line(ax, rows, label, color, metric):
    field = 'Span' if metric == 'spanMs' else 'Total'
    ax.plot(LIGHTS, [r[f'median{field}Ms'] for r in rows], color=color, label=label, marker='o', linewidth=1.7)
    ax.fill_between(LIGHTS, [r[f'p10{field}Ms'] for r in rows], [r[f'p90{field}Ms'] for r in rows], color=color, alpha=.08)
    ax.set_xticks(LIGHTS, ['100', '500', '1k', '2.5k', '5k'])
    ax.set_xlabel('Point lights')
    ax.grid(axis='y', alpha=.15)


def light_plot(report, groups, title, out, name):
    fig, axes = plt.subplots(1, 2, figsize=(12, 5.3), sharey=True)
    for ax, pre in zip(axes, [False, True]):
        for i, (label, settings) in enumerate(groups):
            rows = [report.select(lights=n, precompute=pre, **settings) for n in LIGHTS]
            line(ax, rows, label, COLORS[i], 'spanMs')
        ax.set_title('Light precomputation ' + ('ON' if pre else 'OFF'), loc='left')
        ax.set_ylim(bottom=0)
        ax.legend(frameon=False, fontsize=8)
    axes[0].set_ylabel('GPU span (ms)')
    fig.suptitle(title, fontsize=16, fontweight='bold')
    fig.subplots_adjust(top=.82, bottom=.22)
    save(fig, out, name, '720p Atrium | median and P10-P90 | 4 rounds x 30 samples per configuration\nGPU span includes inter-pass gaps; common animation, CPU, readback and presentation excluded.')


def workloads(report, groups, title, out, name, metric='spanMs', log=False):
    field = 'Span' if metric == 'spanMs' else 'Total'
    fig, axes = plt.subplots(1, 2, figsize=(12, 5.3))
    sets = [([dict(width=960, height=540), {}, dict(width=1920, height=1080)], ['540p', '720p', '1080p'], 'Resolution (Atrium)'),
            ([dict(camera=c) for c in ['Atrium', 'Wall', 'Sky']], ['Atrium', 'Wall', 'Sky'], 'Camera view (720p)')]
    width = .8 / len(groups)
    for ax, (configs, ticks, subtitle) in zip(axes, sets):
        for i, (label, settings) in enumerate(groups):
            rows = [report.select(**settings, **config) for config in configs]
            mids = [r[f'median{field}Ms'] for r in rows]
            errors = [[r[f'median{field}Ms'] - r[f'p10{field}Ms'] for r in rows],
                      [r[f'p90{field}Ms'] - r[f'median{field}Ms'] for r in rows]]
            ax.bar(np.arange(3) + (i - (len(groups)-1)/2)*width, mids, width=width*.95,
                   color=COLORS[i], label=label, yerr=errors, error_kw=dict(elinewidth=.65, capsize=1))
        ax.set_xticks(range(3), ticks)
        ax.set_title(subtitle, loc='left')
        ax.grid(axis='y', alpha=.15, which='both')
        ax.set_axisbelow(True)
        if log: ax.set_yscale('log')
        else: ax.set_ylim(bottom=0)
    axes[0].set_ylabel('GPU ' + ('span' if field == 'Span' else 'pass sum') + ' (ms' + (', log scale)' if log else ')'))
    fig.suptitle(title, fontsize=16, fontweight='bold')
    fig.legend(*axes[0].get_legend_handles_labels(), ncol=len(groups), loc='upper center', bbox_to_anchor=(.5,.91), frameon=False, fontsize=8)
    fig.subplots_adjust(top=.73, bottom=.18, wspace=.22)
    save(fig, out, name, '1,000 lights | median and P10-P90 | same Sponza scene, different views | same-batch comparisons')


def figures(reports, out):
    plt.rcParams.update({'font.family':'DejaVu Sans', 'font.size':10, 'axes.spines.top':False,
                         'axes.spines.right':False, 'axes.titleweight':'bold', 'savefig.facecolor':'white'})
    base = reports['baselines']
    groups = [('Forward+', dict(mode='forward+')), ('Forward+ / precomputed', dict(mode='forward+', precompute=True)),
              ('Deferred raster', dict(mode='clustered deferred')), ('Deferred / precomputed', dict(mode='clustered deferred', precompute=True))]
    fig, ax = plt.subplots(figsize=(10, 5.6))
    for i, (label, settings) in enumerate([('Naive', dict(mode='naive')), *groups]):
        line(ax, [base.select(lights=n, **settings) for n in LIGHTS], label, COLORS[i], 'totalMs')
    ax.set_yscale('log'); ax.set_ylabel('GPU pass sum (ms, log scale)')
    ax.set_title('GPU rendering cost vs. light count', loc='left'); ax.legend(frameon=False, ncol=2)
    fig.subplots_adjust(bottom=.22)
    save(fig, out, 'baseline-lights.png', '720p Atrium | 3 rounds x 30 samples | median and P10-P90\nAll-lights baseline and shared clustered lighting; common light animation excluded.')
    workloads(base, groups, 'Baseline renderers across resolution and view', out, 'baseline-workloads.png', 'totalMs', True)
    fig, axes = plt.subplots(1, 2, figsize=(12, 5))
    for ax, mode in zip(axes, ['forward+', 'clustered deferred']):
        for i, pre in enumerate([False, True]):
            values = [base.select(lights=n, mode=mode, precompute=pre)['medianClusterTotalMs'] for n in LIGHTS]
            ax.plot(LIGHTS, values, marker='o', color=COLORS[i], label='Precomputed' if pre else 'Baseline')
        ax.set_title(mode, loc='left'); ax.set_xticks(LIGHTS, ['100','500','1k','2.5k','5k'])
        ax.set_xlabel('Point lights'); ax.set_ylim(bottom=0); ax.grid(axis='y', alpha=.15); ax.legend(frameon=False)
    axes[0].set_ylabel('Transform + clustering (ms)'); fig.suptitle('Precompute each light position once', fontsize=16, fontweight='bold')
    fig.subplots_adjust(top=.8, bottom=.2)
    save(fig, out, 'light-precompute.png', '720p Atrium | per-sample transform + clustering sum, then median | transform dispatch included')

    depth_groups = [('Forward+', {}), ('Depth prepass', dict(depthPrepass=True)), ('Depth + culling', dict(depthPrepass=True, depthCulling=True))]
    light_plot(reports['depth-culling'], depth_groups, 'Forward+ depth pipeline: full GPU cost', out, 'depth-lights.png')
    workloads(reports['depth-culling'], depth_groups, 'Depth optimization across resolution and view', out, 'depth-workloads.png', log=True)
    deferred = [('Raster32', 'raster'), ('Compute32', 'compute'), ('Packed16', 'compact'), ('Packed8 + depth', 'compact8')]
    deferred_groups = [(label, dict(mode='clustered deferred', deferredVariant=v)) for label, v in deferred]
    light_plot(reports['deferred-packed8'], deferred_groups, 'G-buffer compression: workload-dependent savings', out, 'gbuffer-lights.png')
    workloads(reports['deferred-packed8'], deferred_groups, 'Deferred layouts across resolution and view', out, 'gbuffer-workloads.png')

    fig, ax = plt.subplots(figsize=(9, 4.8))
    ax.bar(range(4), [32,32,16,8], color=COLORS[:4], label='Color attachments')
    ax.bar(range(4), [0,0,0,4], bottom=[32,32,16,8], color='#94a3b8', label='Sampled depth')
    ax.set_xticks(range(4), ['Raster32','Compute32','Packed16','Packed8 + depth'])
    ax.set_ylabel('Format payload (bytes/pixel)'); ax.set_ylim(0,39)
    for i, total in enumerate([32,32,16,12]): ax.text(i,total+.6,str(total),ha='center',fontweight='bold')
    ax.set_title('Deferred lighting input storage', loc='left'); ax.legend(frameon=False)
    fig.subplots_adjust(bottom=.23)
    save(fig, out, 'gbuffer-memory.png', 'The final layout uses one 8 B color output + 4 B sampled depth. Other paths discard geometry depth.\nCounts show lighting-input format payload, not physical VRAM allocation or measured memory traffic.')

    flags = json.loads((HERE/'data/active-clusters.json').read_text(encoding='utf-8'))
    fig, axes = plt.subplots(3,2,figsize=(11,8))
    for i, view in enumerate(flags['views']):
        mask = np.array(view['mask']).reshape(24,9,16)
        assert int(mask.sum()) == view['activeClusters'] and view['missingPixels'] == 0
        img = axes[i,0].imshow(mask.sum(axis=0),vmin=0,vmax=6,cmap='viridis',aspect='auto')
        axes[i,0].set_title(f"{view['camera']}: {view['activeClusters']}/3456 active",loc='left')
        axes[i,0].set_ylabel('Tile y')
        axes[i,1].bar(range(24),mask.sum(axis=(1,2)),color=COLORS[1]); axes[i,1].set_ylabel('Active tiles')
        axes[i,1].set_title('Active clusters per logarithmic depth slice',loc='left'); axes[i,1].grid(axis='y',alpha=.15)
    axes[-1,0].set_xlabel('Tile x'); axes[-1,1].set_xlabel('Depth slice (near to far)')
    fig.colorbar(img,ax=list(axes[:,0]),fraction=.025,pad=.025,label='Active slices per tile')
    fig.suptitle('Recorded GPU active-cluster flags',fontsize=16,fontweight='bold')
    fig.subplots_adjust(top=.9,bottom=.11,hspace=.65,wspace=.4)
    save(fig,out,'active-clusters.png','720p | 1,000 lights | seed 123456789 | time 2500 ms | all visible shading clusters covered')

    fig, axes = plt.subplots(1,2,figsize=(12,5))
    for ax,pre in zip(axes,[False,True]):
        for i,(identifier,label) in enumerate([('depth-culling-per-pixel','One pixel'),('depth-culling','2 x 2 block')]):
            values=[reports[identifier].select(lights=n,precompute=pre,depthPrepass=True,depthCulling=True)['medianPassMs']['marking'] for n in LIGHTS]
            ax.plot(LIGHTS,values,marker='o',color=COLORS[i],label=label)
        ax.set_xticks(LIGHTS,['100','500','1k','2.5k','5k']);ax.set_xlabel('Point lights');ax.set_ylim(bottom=0);ax.legend(frameon=False)
        ax.set_title('Light precomputation '+('ON' if pre else 'OFF'),loc='left');ax.grid(axis='y',alpha=.15)
    axes[0].set_ylabel('Marking pass (ms)');fig.suptitle('Lower marking cost while reading every depth sample',fontsize=16,fontweight='bold')
    fig.subplots_adjust(top=.8,bottom=.22)
    save(fig,out,'depth-marking.png','720p Atrium | medians from two complete benchmark batches with identical scene settings\nMarker work is independent of light count; timing variation reflects execution state and measurement.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, help='Analyze one new JSON/JSON.gz export instead of the bundled experiments')
    parser.add_argument('--out', type=Path, default=ROOT/'output/benchmark-analysis')
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    if args.input:
        report = Report(args.input)
        report.csv(args.out/'summary.csv')
        print(f'Validated {len(report.rows)} configurations and {report.sample_count} samples; wrote {args.out / "summary.csv"}')
        return
    catalog = json.loads((HERE/'experiments.json').read_text(encoding='utf-8'))
    reports, validation = {}, []
    for item in catalog:
        path = HERE/item['file']
        assert hashlib.sha256(read(path)).hexdigest() == item['sha256'], item['id']
        report = Report(path)
        assert len(report.rows) == item['configurations'] and report.sample_count == item['samples']
        reports[item['id']] = report
        report.csv(args.out/(item['id']+'.csv'))
        validation.append(dict(experiment=item['id'], configurations=len(report.rows), samples=report.sample_count))
    figures(reports, args.out)
    quality = json.loads((HERE/'data/image-quality.json').read_text(encoding='utf-8'))
    summary = dict(cases=len(quality['cases']), maxRgbDifferenceVsNaive=max(c['vsNaive']['compact8']['max'] for c in quality['cases']),
                   maxRgbDifferenceVsRaster=max(c['compact8VsRaster']['max'] for c in quality['cases']),
                   maxMeanRgbError=max(c['vsNaive']['compact8']['meanRgbError'] for c in quality['cases']),
                   maxFractionAboveOne=max(c['vsNaive']['compact8']['pixelsOverOne']/(c['framebuffer'][0]*c['framebuffer'][1]) for c in quality['cases']))
    (args.out/'validation.json').write_text(json.dumps(dict(experiments=validation,imageQuality=summary),indent=2),encoding='utf-8')
    print(json.dumps(dict(validated=validation,figures=10,imageQuality=summary),indent=2))


if __name__ == '__main__':
    main()
