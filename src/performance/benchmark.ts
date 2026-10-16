import { adapterInfo, canvas, canvasFormat, device, gpuTimer, Renderer } from '../renderer';
import { createRenderer, type RenderMode } from '../renderers/factory';
import { cameraPresets } from '../stage/camera';
import { Stage } from '../stage/stage';
import { Lights } from '../stage/lights';
import { constants } from '../shaders/shaders';
import type { GpuSample } from './gpu_timer';
import type { DeferredVariant } from '../renderers/clustered_deferred';

export type BenchmarkSuite = 'lights' | 'resolutions' | 'views' | 'full' | 'depth prepass' | 'depth culling' | 'g-buffer';
export interface BenchmarkOptions {
    suite: BenchmarkSuite;
    warmup: number;
    samples: number;
    rounds: number;
    seed: number;
    timeMs: number;
}

interface Scenario { width: number; height: number; lights: number; camera: string }
interface BenchmarkVariant { mode: RenderMode; precompute: boolean; depthPrepass: boolean; depthCulling: boolean; deferredVariant?: DeferredVariant }
interface BenchmarkCase extends Scenario, BenchmarkVariant {}
interface BenchmarkRun { configuration: BenchmarkCase; round: number; samples: GpuSample[]; testedClusters?: number }

export function percentile(values: number[], fraction: number): number {
    const sorted = [...values].sort((a, b) => a - b);
    const index = (sorted.length - 1) * fraction;
    const low = Math.floor(index), high = Math.ceil(index);
    return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

function summarize(runs: BenchmarkRun[]) {
    const groups = new Map<string, BenchmarkRun[]>();
    for (const run of runs) {
        const key = JSON.stringify(run.configuration);
        groups.set(key, [...(groups.get(key) || []), run]);
    }
    return [...groups.values()].map(group => {
        const samples = group.flatMap(run => run.samples);
        const totals = samples.map(sample => sample.totalMs);
        const spans = samples.map(sample => sample.spanMs);
        return {
            ...group[0].configuration, samples: samples.length, rounds: group.length,
            medianTotalMs: percentile(totals, 0.5), p10TotalMs: percentile(totals, 0.1), p90TotalMs: percentile(totals, 0.9),
            medianSpanMs: percentile(spans, 0.5), p10SpanMs: percentile(spans, 0.1), p90SpanMs: percentile(spans, 0.9),
            testedClusters: group[0].testedClusters,
            gBufferColorBytesPerPixel: group[0].configuration.mode === 'clustered deferred'
                ? (group[0].configuration.deferredVariant === 'compact8' ? 8 : group[0].configuration.deferredVariant === 'compact' ? 16 : 32) : 0,
            // Only compact8 uses a format with a specified depth byte size and samples it for lighting.
            gBufferSampledDepthBytesPerPixel: group[0].configuration.deferredVariant === 'compact8' ? 4 : 0,
            medianClusterTotalMs: percentile(samples.map(sample => (sample.passMs.transform || 0) + (sample.passMs.clustering || 0)), 0.5),
            medianCpuEncodeMs: percentile(samples.map(sample => sample.cpuEncodeMs), 0.5),
            medianPassMs: Object.fromEntries(Object.keys(samples[0].passMs).map(label => [label, percentile(samples.map(sample => sample.passMs[label]), 0.5)]))
        };
    });
}

function scenarios(suite: BenchmarkSuite): Scenario[] {
    if (suite === 'depth prepass' || suite === 'depth culling' || suite === 'g-buffer') return scenarios('full');
    const rows: Scenario[] = [];
    if (suite === 'lights' || suite === 'full') {
        for (const lights of [100, 500, 1000, 2500, 5000]) rows.push({ width: 1280, height: 720, lights, camera: 'Atrium' });
    }
    if (suite === 'resolutions' || suite === 'full') {
        for (const [width, height] of [[960, 540], [1280, 720], [1920, 1080]]) rows.push({ width, height, lights: 1000, camera: 'Atrium' });
    }
    if (suite === 'views' || suite === 'full') {
        for (const camera of Object.keys(cameraPresets)) rows.push({ width: 1280, height: 720, lights: 1000, camera });
    }
    return [...new Map(rows.map(row => [JSON.stringify(row), row])).values()];
}

const variants: BenchmarkVariant[] = [
    { mode: 'naive', precompute: false, depthPrepass: false, depthCulling: false },
    { mode: 'forward+', precompute: false, depthPrepass: false, depthCulling: false },
    { mode: 'forward+', precompute: true, depthPrepass: false, depthCulling: false },
    { mode: 'clustered deferred', precompute: false, depthPrepass: false, depthCulling: false },
    { mode: 'clustered deferred', precompute: true, depthPrepass: false, depthCulling: false }
];
// Isolate the depth-prepass change, both with and without the light-transform optimization.
const depthVariants: BenchmarkVariant[] = [false, true].flatMap(precompute => [false, true].map(depthPrepass => ({
    mode: 'forward+' as const, precompute, depthPrepass, depthCulling: false
})));
const cullingVariants: BenchmarkVariant[] = [false, true].flatMap(precompute => [
    { mode: 'forward+' as const, precompute, depthPrepass: false, depthCulling: false },
    { mode: 'forward+' as const, precompute, depthPrepass: true, depthCulling: false },
    { mode: 'forward+' as const, precompute, depthPrepass: true, depthCulling: true }
]);
const gBufferVariants: BenchmarkVariant[] = [false, true].flatMap(precompute =>
    (['raster', 'compute', 'compact', 'compact8'] as const).map(deferredVariant => ({
        mode: 'clustered deferred' as const, precompute, depthPrepass: false, depthCulling: false, deferredVariant
    })));

export class BenchmarkRunner {
    running = false;
    private cancelled = false;

    constructor(private stage: Stage, private progress: (message: string) => void) {}

    cancel() { this.cancelled = true; }

    async run(live: Renderer, options: BenchmarkOptions) {
        if (this.running) throw new Error('A benchmark is already running');
        if (!gpuTimer.supported) throw new Error('GPU timestamp-query is unavailable on this device');
        if (!Number.isInteger(options.warmup) || options.warmup < 1 || options.warmup > 120
            || !Number.isInteger(options.samples) || options.samples < 10 || options.samples > 300
            || !Number.isInteger(options.rounds) || options.rounds < 1 || options.rounds > 5
            || !Number.isInteger(options.seed) || options.seed < 0 || options.seed > 0xffffffff
            || !Number.isFinite(options.timeMs) || options.timeMs < 0) throw new Error('Invalid benchmark settings');
        const sceneCases = scenarios(options.suite);
        if (!sceneCases.length) throw new Error('Unknown benchmark suite');
        const selectedVariants = options.suite === 'g-buffer' ? gBufferVariants : options.suite === 'depth culling' ? cullingVariants : options.suite === 'depth prepass' ? depthVariants : variants;
        const balancedOrder = options.suite === 'depth prepass' || options.suite === 'depth culling' || options.suite === 'g-buffer';

        this.running = true;
        this.cancelled = false;
        const { camera, lights } = this.stage;
        const saved = { pose: camera.getPose(), input: camera.inputEnabled, width: canvas.width, height: canvas.height,
            numLights: lights.numLights, seed: lights.seed, timeMs: lights.timeMs, paused: lights.paused, precompute: lights.precomputeViewPositions,
            running: live.isRunning };
        live.pause();
        camera.inputEnabled = false;
        camera.keys = {};
        lights.paused = true;

        const report = {
            schemaVersion: 5, createdAt: new Date().toISOString(), status: 'running', error: '',
            metadata: { adapter: adapterInfo, userAgent: navigator.userAgent, devicePixelRatio, options: { ...options },
                cameraPresets, grid: [constants.clusterGridX, constants.clusterGridY, constants.clusterGridZ],
                maxLights: constants.maxNumLights, viewPositionBufferBytes: constants.maxNumLights * 16,
                activeClusterBufferBytes: Lights.clusterCount * 4, depthMarkingEpsilon: constants.clusterDepthEpsilon,
                depthMarkingBlockSize: constants.clusterMarkingBlockSize,
                canvasFormat, deviceFeatures: [...device.features],
                deferredWorkgroupSize: [constants.deferredWorkgroupSize, constants.deferredWorkgroupSize],
                gBufferLayouts: { raster: { formats: ['rgba32float', 'rgba16float', 'rgba16float'], colorBytesPerPixel: 32 },
                    compute: { formats: ['rgba32float', 'rgba16float', 'rgba16float'], colorBytesPerPixel: 32 },
                    compact: { formats: ['rgba32uint'], colorBytesPerPixel: 16,
                        encoding: 'linear view depth f32; oct normal 2xsnorm16; RGB 3xf16 + unused f16. World position reconstructed from pixel center, inverse projection and inverse view.' },
                    compact8: { formats: ['rg32uint'], colorBytesPerPixel: 8, depthFormat: 'depth32float', sampledDepthBytesPerPixel: 4,
                        encoding: 'oct normal 2xsnorm16; square-root-companded RGB 3xunorm10 + 2 unused bits (square on decode). Hardware depth stored and sampled for inverse-projection/inverse-view position reconstruction. Total shading data 12 B/pixel; LDR albedo only.' } },
                deferredMethod: 'Compute variants use one 8x8 lighting dispatch writing the canvas storage texture directly. No fullscreen lighting or presentation render pass. compact8 stores/samples depth32float (4 B/pixel); all other variants use depth24plus, discarded after geometry, with implementation-defined physical byte size. Byte counts describe format payload, not measured physical allocation or memory traffic.',
                depthCullingMethod: 'Fullscreen quad reads every source depth in 2x2 blocks and marks their conservative tile/depth bounds. All cluster invocations dispatch; inactive invocations reset count and return before bounds/light tests. No stream compaction.',
                maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize,
                timing: 'GPU pass sums include depth, active marking, transforms and clustering when enabled. GPU span also includes gaps/flag clears from the first pass start through the last pass end. Common light animation excluded. CPU encoding reported separately.',
                method: 'Fixed light time and local LCG seed. Depth/G-buffer suites alternate forward/reverse variant order; other suites rotate. Warmup precedes each case. Active cluster count is read once after each run, outside measurements. Each sample awaits timestamp readback; not an FPS/throughput test.',
                caveats: 'Timestamp precision and scheduling depend on the browser/driver. Zero means below timer resolution. Medians of passes need not sum to median total. Other GPU applications are not controlled.' },
            runs: [] as BenchmarkRun[], summary: [] as ReturnType<typeof summarize>
        };
        const gpuErrors: string[] = [];
        const onGpuError = (event: GPUUncapturedErrorEvent) => gpuErrors.push(event.error.message);
        device.addEventListener('uncapturederror', onGpuError);
        let current: Renderer | undefined;
        const check = () => {
            if (this.cancelled) throw new Error('Cancelled');
            if (document.hidden) throw new Error('Benchmark stopped because the tab was hidden; keep this tab visible when measuring');
            if (gpuErrors.length) throw new Error(gpuErrors.join('\n'));
        };
        try {
            await gpuTimer.drain();
            let completed = 0;
            const total = sceneCases.length * selectedVariants.length * options.rounds;
            for (let round = 0; round < options.rounds; round++) {
                // Balance A/B and B/A for depth pairs; retain rotation for the original renderer comparison.
                const order = balancedOrder
                    ? (round % 2 ? [...selectedVariants].reverse() : selectedVariants)
                    : [...selectedVariants.slice(round % selectedVariants.length), ...selectedVariants.slice(0, round % selectedVariants.length)];
                for (const scenario of sceneCases) for (const variant of order) {
                    check();
                    current?.stop();
                    current = undefined;
                    const configuration = { ...scenario, ...variant };
                    canvas.width = scenario.width;
                    canvas.height = scenario.height;
                    camera.setViewport(canvas.width, canvas.height);
                    camera.setPose(cameraPresets[scenario.camera]);
                    lights.seed = options.seed;
                    lights.populateLightsBuffer();
                    lights.numLights = scenario.lights;
                    lights.updateLightSetUniformNumLights();
                    lights.precomputeViewPositions = variant.precompute;
                    current = createRenderer(variant.mode, this.stage, variant.depthPrepass, variant.depthCulling, variant.deferredVariant);
                    current.pause();
                    this.progress(`${completed}/${total} · round ${round + 1}/${options.rounds} · ${scenario.width}×${scenario.height} · ${scenario.camera} · ${scenario.lights} lights · ${variant.mode}${variant.deferredVariant ? ' · ' + variant.deferredVariant : ''} · ${variant.precompute ? 'precomputed' : 'baseline'}${variant.depthPrepass ? ' · depth prepass' : ''}${variant.depthCulling ? ' · active clusters' : ''}`);
                    for (let i = 0; i < options.warmup; i++) {
                        check();
                        await current.renderFrame(options.timeMs);
                        await device.queue.onSubmittedWorkDone();
                    }
                    const samples: GpuSample[] = [];
                    for (let i = 0; i < options.samples; i++) {
                        check();
                        const sample = await current.renderFrame(options.timeMs, 0, true);
                        if (!sample) throw new Error('No GPU timing slot available');
                        samples.push(sample);
                    }
                    check();
                    const testedClusters = variant.mode === 'naive' ? undefined
                        : variant.depthCulling ? await lights.countActiveClusters() : Lights.clusterCount;
                    check();
                    report.runs.push({ configuration, round, samples, testedClusters });
                    completed++;
                }
            }
            report.status = 'completed';
        } catch (error) {
            report.status = this.cancelled ? 'cancelled' : 'failed';
            report.error = String(error);
        } finally {
            current?.stop();
            await gpuTimer.drain();
            device.removeEventListener('uncapturederror', onGpuError);
            canvas.width = saved.width;
            canvas.height = saved.height;
            camera.setViewport(saved.width, saved.height);
            camera.setPose(saved.pose);
            camera.inputEnabled = saved.input;
            lights.numLights = saved.numLights;
            lights.seed = saved.seed;
            lights.timeMs = saved.timeMs;
            lights.paused = saved.paused;
            lights.precomputeViewPositions = saved.precompute;
            lights.populateLightsBuffer();
            lights.updateLightSetUniformNumLights();
            live.lastSample = undefined;
            if (saved.running) live.resume();
            else await live.renderFrame(saved.timeMs);
            this.running = false;
        }
        report.summary = summarize(report.runs);
        this.progress(`${report.status === 'completed' ? 'Complete' : report.status}: ${report.runs.length} runs, ${report.summary.length} configurations. ${report.error || 'Export JSON or CSV to save the measurements.'}`);
        return report;
    }
}

export type BenchmarkReport = Awaited<ReturnType<BenchmarkRunner['run']>>;

export function benchmarkCsv(report: BenchmarkReport): string {
    const columns = ['status', 'seed', 'time_ms', 'width', 'height', 'camera', 'lights', 'mode', 'precompute', 'depth_prepass', 'depth_culling', 'tested_clusters', 'samples', 'rounds',
        'gpu_median_ms', 'gpu_p10_ms', 'gpu_p90_ms', 'preprocess_plus_cluster_median_ms', 'transform_median_ms', 'clustering_median_ms',
        'depth_prepass_median_ms', 'marking_median_ms', 'shading_median_ms', 'geometry_median_ms', 'lighting_median_ms', 'cpu_encode_median_ms',
        'gpu_span_median_ms', 'gpu_span_p10_ms', 'gpu_span_p90_ms', 'deferred_pipeline', 'gbuffer_color_bytes_per_pixel', 'gbuffer_sampled_depth_bytes_per_pixel'];
    const rows = report.summary.map(row => [report.status, report.metadata.options.seed, report.metadata.options.timeMs,
        row.width, row.height, row.camera, row.lights, row.mode, row.precompute, row.depthPrepass, row.depthCulling, row.testedClusters ?? '', row.samples, row.rounds,
        row.medianTotalMs, row.p10TotalMs, row.p90TotalMs, row.medianClusterTotalMs,
        ...['transform', 'clustering', 'depth', 'marking', 'shading', 'geometry', 'lighting'].map(label => row.medianPassMs[label] ?? ''), row.medianCpuEncodeMs,
        row.medianSpanMs, row.p10SpanMs, row.p90SpanMs, row.deferredVariant ?? (row.mode === 'clustered deferred' ? 'raster' : ''), row.gBufferColorBytesPerPixel, row.gBufferSampledDepthBytesPerPixel]);
    const cell = (value: unknown) => `"${String(value).replace(/"/g, '""')}"`;
    return [columns, ...rows].map(row => row.map(cell).join(',')).join('\n');
}
