import Stats from 'stats.js';
import { GUI, GUIController } from 'dat.gui';
import { initWebGPU, Renderer, canvas, gpuTimer } from './renderer';
import { createRenderer, type RenderMode } from './renderers/factory';
import { ForwardPlusRenderer } from './renderers/forward_plus';
import type { DeferredVariant } from './renderers/clustered_deferred';
import { setupLoaders, Scene } from './stage/scene';
import { Lights } from './stage/lights';
import { Camera, cameraPresets } from './stage/camera';
import { Stage } from './stage/stage';
import { BenchmarkRunner, benchmarkCsv, type BenchmarkReport, type BenchmarkSuite } from './performance/benchmark';

await initWebGPU();
setupLoaders();
const scene = new Scene();
await scene.loadGltf('./scenes/sponza/Sponza.gltf');
const camera = new Camera();
const lights = new Lights(camera);
const stats = new Stats();
stats.showPanel(0);
document.body.appendChild(stats.dom);
const stage = new Stage(scene, lights, camera, stats);

const settings = { mode: 'naive' as RenderMode, camera: 'Atrium', resolution: 'Window', gpuTiming: gpuTimer.supported, pauseRendering: false, depthPrepass: false, depthClusterCulling: false, deferredVariant: 'raster' as DeferredVariant };
const benchmarkSettings = { suite: 'lights' as BenchmarkSuite, warmup: 20, samples: 60, rounds: 3 };
let renderer: Renderer;
let lastReport: BenchmarkReport | undefined;

const timingPanel = document.createElement('pre');
timingPanel.id = 'gpu-timings';
timingPanel.setAttribute('aria-label', 'GPU timings');
const benchmarkStatus = document.createElement('div');
benchmarkStatus.id = 'benchmark-status';
benchmarkStatus.setAttribute('role', 'status');
benchmarkStatus.textContent = 'Benchmark: ready. Fixed seed, camera and light time; keep this tab visible while measuring.';
const panels = document.createElement('div');
panels.id = 'performance-panels';
panels.append(timingPanel, benchmarkStatus);
document.body.appendChild(panels);
const runner = new BenchmarkRunner(stage, message => { benchmarkStatus.textContent = message; });

function setRenderer() {
    renderer?.stop();
    renderer = createRenderer(settings.mode, stage, settings.depthPrepass, settings.depthClusterCulling, settings.deferredVariant);
    renderer.measureGpu = settings.gpuTiming;
    if (settings.pauseRendering) {
        renderer.pause();
        void renderer.renderFrame(lights.timeMs).catch(error => console.error(error));
    }
}

function setResolution() {
    const [width, height] = settings.resolution === 'Window'
        ? [Math.max(1, Math.floor(canvas.clientWidth * devicePixelRatio)), Math.max(1, Math.floor(canvas.clientHeight * devicePixelRatio))]
        : settings.resolution.split('x').map(Number);
    canvas.width = width;
    canvas.height = height;
    camera.setViewport(width, height);
    setRenderer();
}

const gui = new GUI({ width: 320 });
const controls: GUIController[] = [];
function named(controller: GUIController, name: string) {
    controller.name(name);
    controller.domElement.querySelector('input,select')?.setAttribute('aria-label', name);
    controls.push(controller);
    return controller;
}
const refreshControls = () => controls.forEach(controller => controller.updateDisplay());
named(gui.add(lights, 'numLights', 0, Lights.maxNumLights, 1), 'Lights').onChange(() => lights.updateLightSetUniformNumLights());
named(gui.add(settings, 'mode', { naive: 'naive', forwardPlus: 'forward+', clusteredDeferred: 'clustered deferred' }), 'Renderer').onChange(setRenderer);

const sceneFolder = gui.addFolder('Scene');
named(sceneFolder.add(lights, 'paused'), 'Pause lights').onChange(() => refreshControls());
const lightTimeControl = named(sceneFolder.add(lights, 'timeMs').min(0).step(50), 'Light time (ms)').onChange(() => {
    lights.paused = true;
    refreshControls();
});
named(sceneFolder.add(lights, 'seed').min(0).step(1), 'Seed').onFinishChange(() => {
    lights.seed = lights.seed >>> 0;
    lights.populateLightsBuffer();
    refreshControls();
});
named(sceneFolder.add(settings, 'camera', Object.keys(cameraPresets)), 'Camera preset').onChange(() => camera.setPose(cameraPresets[settings.camera]));
named(sceneFolder.add(settings, 'resolution', ['Window', '960x540', '1280x720', '1920x1080']), 'Resolution').onChange(setResolution);
named(sceneFolder.add({ reset: () => {
    if (runner.running) return;
    camera.setPose(cameraPresets[settings.camera]);
    lights.timeMs = 2500;
    lights.paused = true;
    lights.populateLightsBuffer();
    refreshControls();
} }, 'reset'), 'Reset fixed scene');
sceneFolder.open();

const performanceFolder = gui.addFolder('Performance');
named(performanceFolder.add(settings, 'pauseRendering'), 'Pause rendering').onChange(() => {
    if (settings.pauseRendering) renderer.pause(); else renderer.resume();
});
named(performanceFolder.add(lights, 'precomputeViewPositions'), 'Precompute light positions');
function updateForwardOptions() {
    if (renderer instanceof ForwardPlusRenderer) {
        renderer.depthPrepass = settings.depthPrepass;
        renderer.depthClusterCulling = settings.depthClusterCulling;
        renderer.lastSample = undefined;
        if (settings.pauseRendering) void renderer.renderFrame(lights.timeMs).catch(error => console.error(error));
    }
    refreshControls();
}
named(performanceFolder.add(settings, 'depthPrepass'), 'Forward+ depth prepass').onChange(() => {
    if (!settings.depthPrepass) settings.depthClusterCulling = false;
    updateForwardOptions();
});
named(performanceFolder.add(settings, 'depthClusterCulling'), 'Depth cluster culling').onChange(() => {
    if (settings.depthClusterCulling) settings.depthPrepass = true;
    updateForwardOptions();
});
named(performanceFolder.add(settings, 'gpuTiming'), 'GPU timing').onChange(() => {
    renderer.measureGpu = settings.gpuTiming;
    renderer.lastSample = undefined;
});
named(performanceFolder.add(settings, 'deferredVariant', {
    'Raster · 32 B/pixel': 'raster', 'Compute · 32 B/pixel': 'compute', 'Compute · packed 16 B/pixel': 'compact',
    'Compute · 8 B + 4 B depth': 'compact8'
}), 'Deferred pipeline').onChange(() => {
    if (settings.mode === 'clustered deferred') setRenderer();
});
performanceFolder.open();

function downloadReport(format: 'json' | 'csv') {
    if (runner.running) return;
    if (!lastReport) {
        benchmarkStatus.textContent = 'Run a benchmark first, then export its measurements.';
        return;
    }
    const content = format === 'json' ? JSON.stringify(lastReport, null, 2) : benchmarkCsv(lastReport);
    const url = URL.createObjectURL(new Blob([content], { type: format === 'json' ? 'application/json' : 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `gpu-benchmark-${lastReport.metadata.options.suite}-${lastReport.createdAt.replace(/[:.]/g, '-')}.${format}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function runBenchmark() {
    if (runner.running) return;
    const inputs = [...gui.domElement.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select')];
    inputs.forEach(input => { input.disabled = true; });
    try {
        lastReport = await runner.run(renderer, { ...benchmarkSettings, seed: lights.seed, timeMs: lights.timeMs });
    } catch (error) {
        benchmarkStatus.textContent = String(error);
    } finally {
        inputs.forEach(input => { input.disabled = false; });
        refreshControls();
        if (settings.resolution === 'Window' && (canvas.width !== Math.max(1, Math.floor(canvas.clientWidth * devicePixelRatio))
            || canvas.height !== Math.max(1, Math.floor(canvas.clientHeight * devicePixelRatio)))) setResolution();
    }
}

const benchmarkFolder = gui.addFolder('Benchmark');
named(benchmarkFolder.add(benchmarkSettings, 'suite', ['lights', 'resolutions', 'views', 'full', 'depth prepass', 'depth culling', 'g-buffer']), 'Suite');
named(benchmarkFolder.add(benchmarkSettings, 'warmup', 1, 120, 1), 'Warmup frames');
named(benchmarkFolder.add(benchmarkSettings, 'samples', 10, 300, 1), 'Samples per round');
named(benchmarkFolder.add(benchmarkSettings, 'rounds', 1, 5, 1), 'Rounds');
const actions = { run: () => { void runBenchmark(); }, cancel: () => runner.cancel(), json: () => downloadReport('json'), csv: () => downloadReport('csv') };
named(benchmarkFolder.add(actions, 'run'), 'Run benchmark');
named(benchmarkFolder.add(actions, 'cancel'), 'Cancel benchmark');
named(benchmarkFolder.add(actions, 'json'), 'Export JSON');
named(benchmarkFolder.add(actions, 'csv'), 'Export CSV');

setRenderer();
window.addEventListener('resize', () => {
    if (!runner.running && settings.resolution === 'Window') setResolution();
});
setInterval(() => {
    if (!lightTimeControl.domElement.contains(document.activeElement)) lightTimeControl.updateDisplay();
    if (!gpuTimer.supported) {
        timingPanel.textContent = 'GPU timing unavailable (timestamp-query unsupported). Rendering is available.';
        return;
    }
    if (runner.running) {
        timingPanel.textContent = 'Benchmark running — GPU pass times are being recorded.\nUse Cancel benchmark to stop and restore the scene.';
        return;
    }
    if (settings.pauseRendering) {
        timingPanel.textContent = 'Rendering paused — GPU work stopped. Uncheck Pause rendering to resume.';
        return;
    }
    if (renderer.timingError) {
        timingPanel.textContent = renderer.timingError;
        return;
    }
    const sample = renderer.lastSample;
    if (!settings.gpuTiming || !sample) {
        timingPanel.textContent = settings.gpuTiming ? 'Waiting for GPU timing…' : 'GPU timing off';
        return;
    }
    const labels: Record<string, string> = { depth: 'Depth prepass', marking: 'Active cluster marking', transform: 'Light transform', clustering: 'Clustering', shading: 'Forward shading', geometry: 'G-buffer', lighting: 'Deferred lighting' };
    timingPanel.textContent = [`GPU span: ${sample.spanMs.toFixed(3)} ms`, `GPU pass total: ${sample.totalMs.toFixed(3)} ms`,
        ...Object.entries(sample.passMs).map(([label, value]) => `  ${labels[label]}: ${value.toFixed(3)} ms`),
        `CPU encode: ${sample.cpuEncodeMs.toFixed(3)} ms`, `${canvas.width} × ${canvas.height} | animation excluded`,
        'Live sample; 0 can mean below timer resolution.'].join('\n');
}, 500);
