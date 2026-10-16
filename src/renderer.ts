import { Scene } from './stage/scene';
import { Lights } from './stage/lights';
import { Camera } from './stage/camera';
import { Stage } from './stage/stage';
import { GpuTimer, type GpuSample, type GpuTimingFrame } from './performance/gpu_timer';
export type { GpuTimingFrame } from './performance/gpu_timer';

export var canvas: HTMLCanvasElement;
export var canvasFormat: GPUTextureFormat;
export var context: GPUCanvasContext;
export var device: GPUDevice;
export var canvasTextureView: GPUTextureView;

export var aspectRatio: number;
export var gpuTimer: GpuTimer;
export var adapterInfo: { vendor: string; architecture: string; device: string; description: string };
export const fovYDegrees = 45;

export var modelBindGroupLayout: GPUBindGroupLayout;
export var materialBindGroupLayout: GPUBindGroupLayout;

// CHECKITOUT: this function initializes WebGPU and also creates some bind group layouts shared by all the renderers
export async function initWebGPU() {
    canvas = document.getElementById("mainCanvas") as HTMLCanvasElement;

    const devicePixelRatio = window.devicePixelRatio;
    canvas.width = canvas.clientWidth * devicePixelRatio;
    canvas.height = canvas.clientHeight * devicePixelRatio;

    aspectRatio = canvas.width / canvas.height;

    if (!navigator.gpu)
    {
        let errorMessageElement = document.createElement("h1");
        errorMessageElement.textContent = "This browser doesn't support WebGPU! Try using Google Chrome.";
        errorMessageElement.style.paddingLeft = '0.4em';
        document.body.innerHTML = '';
        document.body.appendChild(errorMessageElement);
        throw new Error("WebGPU not supported on this browser");
    }

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter)
    {
        throw new Error("no appropriate GPUAdapter found");
    }

    const requiredFeatures: GPUFeatureName[] = adapter.features.has('timestamp-query') ? ['timestamp-query'] : [];
    const preferredFormat = navigator.gpu.getPreferredCanvasFormat();
    const bgraStorage = preferredFormat === 'bgra8unorm' && adapter.features.has('bgra8unorm-storage');
    if (bgraStorage) requiredFeatures.push('bgra8unorm-storage');
    device = await adapter.requestDevice({ requiredFeatures });
    gpuTimer = new GpuTimer(device);
    adapterInfo = { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device, description: adapter.info.description };

    context = canvas.getContext("webgpu")!;
    // Compute writes presentation directly. RGBA storage is core; BGRA is optional.
    canvasFormat = preferredFormat === 'bgra8unorm' && !bgraStorage ? 'rgba8unorm' : preferredFormat;
    context.configure({
        device: device,
        format: canvasFormat,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.STORAGE_BINDING,
    });

    console.log("WebGPU init successsful");

    modelBindGroupLayout = device.createBindGroupLayout({
        label: "model bind group layout",
        entries: [
            { // modelMat
                binding: 0,
                visibility: GPUShaderStage.VERTEX,
                buffer: { type: "uniform" }
            }
        ]
    });

    materialBindGroupLayout = device.createBindGroupLayout({
        label: "material bind group layout",
        entries: [
            { // diffuseTex
                binding: 0,
                visibility: GPUShaderStage.FRAGMENT,
                texture: {}
            },
            { // diffuseTexSampler
                binding: 1,
                visibility: GPUShaderStage.FRAGMENT,
                sampler: {}
            }
        ]
    });
}

export const vertexBufferLayout: GPUVertexBufferLayout = {
    arrayStride: 32,
    attributes: [
        { // pos
            format: "float32x3",
            offset: 0,
            shaderLocation: 0
        },
        { // nor
            format: "float32x3",
            offset: 12,
            shaderLocation: 1
        },
        { // uv
            format: "float32x2",
            offset: 24,
            shaderLocation: 2
        }
    ]
};

export abstract class Renderer {
    protected scene: Scene;
    protected lights: Lights;
    protected camera: Camera;

    protected stats: Stats;

    private prevTime: number | undefined;
    private frameRequestId: number | undefined;
    measureGpu = true;
    lastSample: GpuSample | undefined;
    timingError = '';

    constructor(stage: Stage) {
        this.scene = stage.scene;
        this.lights = stage.lights;
        this.camera = stage.camera;
        this.stats = stage.stats;

        this.resume();
    }

    stop(): void {
        this.pause();
    }

    pause(): void {
        if (this.frameRequestId !== undefined) cancelAnimationFrame(this.frameRequestId);
        this.frameRequestId = undefined;
        this.prevTime = undefined;
    }

    get isRunning(): boolean {
        return this.frameRequestId !== undefined;
    }

    resume(): void {
        if (this.frameRequestId === undefined) this.frameRequestId = requestAnimationFrame(t => this.onFrame(t));
    }

    protected abstract draw(timing?: GpuTimingFrame): void;

    protected submit(encoder: GPUCommandEncoder, timing?: GpuTimingFrame) {
        timing?.resolve(encoder);
        device.queue.submit([encoder.finish()]);
    }

    // Benchmarks drive this directly while RAF is paused; live timing never blocks RAF.
    async renderFrame(timeMs: number, deltaTime = 0, measure = false): Promise<GpuSample | undefined> {
        this.camera.onFrame(deltaTime);
        this.lights.onFrame(timeMs);
        const timing = measure ? gpuTimer.beginFrame() : undefined;
        const start = performance.now();
        this.draw(timing);
        const cpuEncodeMs = performance.now() - start;
        if (!timing) return undefined;
        const sample = await timing.read(cpuEncodeMs);
        this.lastSample = sample;
        return sample;
    }

    // CHECKITOUT: this is the main rendering loop
    private onFrame(time: number) {
        const deltaTime = this.prevTime === undefined ? 0 : Math.min(time - this.prevTime, 100);
        if (!this.lights.paused) this.lights.timeMs += deltaTime;

        this.stats.begin();

        void this.renderFrame(this.lights.timeMs, deltaTime, this.measureGpu).catch(error => {
            this.timingError = String(error);
            this.measureGpu = false;
            console.error(error);
        });

        this.stats.end();

        this.prevTime = time;
        this.frameRequestId = requestAnimationFrame((t) => this.onFrame(t));
    }
}
