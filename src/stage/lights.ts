import { vec3 } from "wgpu-matrix";
import { device } from "../renderer";

import * as shaders from '../shaders/shaders';
import { Camera } from "./camera";
import type { GpuTimingFrame } from '../performance/gpu_timer';

// h in [0, 1]
function hueToRgb(h: number) {
    let f = (n: number, k = (n + h * 6) % 6) => 1 - Math.max(Math.min(k, 4 - k, 1), 0);
    return vec3.lerp(vec3.create(1, 1, 1), vec3.create(f(5), f(3), f(1)), 0.8);
}

export class Lights {
    private camera: Camera;

    numLights = 500;
    seed = 123456789;
    paused = false;
    timeMs = 2500;
    precomputeViewPositions = false;
    static readonly maxNumLights = shaders.constants.maxNumLights;
    static readonly numFloatsPerLight = 8; // vec3f is aligned at 16 byte boundaries
    static readonly clusterCount = shaders.constants.clusterGridX
        * shaders.constants.clusterGridY * shaders.constants.clusterGridZ;
    // Cluster is one u32 count followed by maxNumLights u32 indices (alignment 4).
    static readonly clusterStride = (1 + Lights.maxNumLights) * 4;

    static readonly lightIntensity = 0.1;

    lightsArray = new Float32Array(Lights.maxNumLights * Lights.numFloatsPerLight);
    lightSetStorageBuffer: GPUBuffer;

    timeUniformBuffer: GPUBuffer;

    moveLightsComputeBindGroupLayout: GPUBindGroupLayout;
    moveLightsComputeBindGroup: GPUBindGroup;
    moveLightsComputePipeline: GPUComputePipeline;

    clusterSetStorageBuffer: GPUBuffer;
    clusteringComputeBindGroupLayout: GPUBindGroupLayout;
    clusteringComputeBindGroup: GPUBindGroup;
    clusteringComputePipeline: GPUComputePipeline;
    precomputedClusteringPipeline: GPUComputePipeline;
    culledClusteringPipeline: GPUComputePipeline;
    culledPrecomputedClusteringPipeline: GPUComputePipeline;
    activeClustersBuffer: GPUBuffer;
    viewLightPositionsBuffer: GPUBuffer;
    transformLightsBindGroup: GPUBindGroup;
    transformLightsPipeline: GPUComputePipeline;

    constructor(camera: Camera) {
        this.camera = camera;

        this.lightSetStorageBuffer = device.createBuffer({
            label: "lights",
            size: 16 + this.lightsArray.byteLength, // 16 for numLights + padding
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
        });
        this.populateLightsBuffer();
        this.updateLightSetUniformNumLights();

        this.timeUniformBuffer = device.createBuffer({
            label: "time uniform",
            size: 4,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });

        this.moveLightsComputeBindGroupLayout = device.createBindGroupLayout({
            label: "move lights compute bind group layout",
            entries: [
                { // lightSet
                    binding: 0,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: "storage" }
                },
                { // time
                    binding: 1,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: "uniform" }
                }
            ]
        });

        this.moveLightsComputeBindGroup = device.createBindGroup({
            label: "move lights compute bind group",
            layout: this.moveLightsComputeBindGroupLayout,
            entries: [
                {
                    binding: 0,
                    resource: { buffer: this.lightSetStorageBuffer }
                },
                {
                    binding: 1,
                    resource: { buffer: this.timeUniformBuffer }
                }
            ]
        });

        this.moveLightsComputePipeline = device.createComputePipeline({
            label: "move lights compute pipeline",
            layout: device.createPipelineLayout({
                label: "move lights compute pipeline layout",
                bindGroupLayouts: [ this.moveLightsComputeBindGroupLayout ]
            }),
            compute: {
                module: device.createShaderModule({
                    label: "move lights compute shader",
                    code: shaders.moveLightsComputeSrc
                }),
                entryPoint: "main"
            }
        });

        const clusterBufferSize = Lights.clusterCount * Lights.clusterStride;
        if (clusterBufferSize > device.limits.maxStorageBufferBindingSize
            || clusterBufferSize > device.limits.maxBufferSize) {
            throw new Error(`Cluster lists require ${clusterBufferSize} bytes, exceeding this device's buffer limits.`);
        }
        this.clusterSetStorageBuffer = device.createBuffer({
            label: "cluster light lists",
            size: clusterBufferSize,
            // COPY_SRC also allows inspecting lists during correctness checks.
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
        });
        this.viewLightPositionsBuffer = device.createBuffer({
            label: 'view-space light positions',
            size: Lights.maxNumLights * 16,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
        });
        this.activeClustersBuffer = device.createBuffer({
            label: 'active cluster flags',
            size: Lights.clusterCount * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
        });
        const transformLayout = device.createBindGroupLayout({
            label: 'light transform layout',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }
            ]
        });
        this.transformLightsBindGroup = device.createBindGroup({
            layout: transformLayout,
            entries: [
                { binding: 0, resource: { buffer: this.camera.uniformsBuffer } },
                { binding: 1, resource: { buffer: this.lightSetStorageBuffer } },
                { binding: 2, resource: { buffer: this.viewLightPositionsBuffer } }
            ]
        });
        this.transformLightsPipeline = device.createComputePipeline({
            label: 'light view transform pipeline',
            layout: device.createPipelineLayout({ bindGroupLayouts: [transformLayout] }),
            compute: { module: device.createShaderModule({ label: 'light view transform shader', code: shaders.transformLightsComputeSrc }), entryPoint: 'main' }
        });
        this.clusteringComputeBindGroupLayout = device.createBindGroupLayout({
            label: "light clustering bind group layout",
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
                { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } }
            ]
        });
        this.clusteringComputeBindGroup = device.createBindGroup({
            label: "light clustering bind group",
            layout: this.clusteringComputeBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.camera.uniformsBuffer } },
                { binding: 1, resource: { buffer: this.lightSetStorageBuffer } },
                { binding: 2, resource: { buffer: this.clusterSetStorageBuffer } },
                { binding: 3, resource: { buffer: this.viewLightPositionsBuffer } },
                { binding: 4, resource: { buffer: this.activeClustersBuffer } }
            ]
        });
        const clusteringLayout = device.createPipelineLayout({ bindGroupLayouts: [this.clusteringComputeBindGroupLayout] });
        const clusteringModule = device.createShaderModule({ label: 'light clustering shader', code: shaders.clusteringComputeSrc });
        this.clusteringComputePipeline = device.createComputePipeline({
            label: "light clustering pipeline",
            layout: clusteringLayout,
            compute: {
                module: clusteringModule,
                entryPoint: "main",
                constants: { precomputeViewPositions: 0 }
            }
        });
        this.precomputedClusteringPipeline = device.createComputePipeline({
            label: 'precomputed light clustering pipeline',
            layout: clusteringLayout,
            compute: { module: clusteringModule, entryPoint: 'main', constants: { precomputeViewPositions: 1 } }
        });
        this.culledClusteringPipeline = device.createComputePipeline({
            label: 'active-only light clustering pipeline',
            layout: clusteringLayout,
            compute: { module: clusteringModule, entryPoint: 'main', constants: { precomputeViewPositions: 0, skipInactiveClusters: 1 } }
        });
        this.culledPrecomputedClusteringPipeline = device.createComputePipeline({
            label: 'active-only precomputed light clustering pipeline',
            layout: clusteringLayout,
            compute: { module: clusteringModule, entryPoint: 'main', constants: { precomputeViewPositions: 1, skipInactiveClusters: 1 } }
        });
    }

    populateLightsBuffer() {
        // A local PRNG makes scene comparisons reproducible without replacing Math.random.
        let randomState = this.seed >>> 0;
        const random = () => ((randomState = (Math.imul(1664525, randomState) + 1013904223) >>> 0) / 4294967296);
        for (let lightIdx = 0; lightIdx < Lights.maxNumLights; ++lightIdx) {
            // light pos is set by compute shader so no need to set it here
            const lightColor = vec3.scale(hueToRgb(random()), Lights.lightIntensity);
            this.lightsArray.set(lightColor, (lightIdx * Lights.numFloatsPerLight) + 4);
        }

        device.queue.writeBuffer(this.lightSetStorageBuffer, 16, this.lightsArray);
    }

    updateLightSetUniformNumLights() {
        if (!Number.isInteger(this.numLights) || this.numLights < 0 || this.numLights > Lights.maxNumLights) {
            throw new RangeError(`Light count must be an integer between 0 and ${Lights.maxNumLights}.`);
        }
        device.queue.writeBuffer(this.lightSetStorageBuffer, 0, new Uint32Array([this.numLights]));
    }

    doLightClustering(encoder: GPUCommandEncoder, timing?: GpuTimingFrame, depthCulling = false) {
        // Recompute on every rendered frame, including when only the camera moves.
        // This pass is part of the measured rendering cost, not hidden in light animation.
        if (this.precomputeViewPositions) {
            const transform = encoder.beginComputePass({ label: 'light view transform pass', timestampWrites: timing?.writes('transform') });
            transform.setPipeline(this.transformLightsPipeline);
            transform.setBindGroup(0, this.transformLightsBindGroup);
            transform.dispatchWorkgroups(Math.ceil(this.numLights / shaders.constants.moveLightsWorkgroupSize));
            transform.end();
        }
        const pass = encoder.beginComputePass({ label: "light clustering pass", timestampWrites: timing?.writes('clustering') });
        pass.setPipeline(depthCulling
            ? (this.precomputeViewPositions ? this.culledPrecomputedClusteringPipeline : this.culledClusteringPipeline)
            : (this.precomputeViewPositions ? this.precomputedClusteringPipeline : this.clusteringComputePipeline));
        pass.setBindGroup(0, this.clusteringComputeBindGroup);
        pass.dispatchWorkgroups(Math.ceil(Lights.clusterCount / shaders.constants.clusteringWorkgroupSize));
        pass.end();
    }

    // Called once per benchmark run, outside measured frames; never in the live loop.
    async countActiveClusters(): Promise<number> {
        const read = device.createBuffer({
            label: 'active clusters readback', size: Lights.clusterCount * 4,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
        });
        try {
            const encoder = device.createCommandEncoder();
            encoder.copyBufferToBuffer(this.activeClustersBuffer, 0, read, 0, read.size);
            device.queue.submit([encoder.finish()]);
            await read.mapAsync(GPUMapMode.READ);
            return new Uint32Array(read.getMappedRange()).reduce((sum, active) => sum + (active ? 1 : 0), 0);
        } finally {
            if (read.mapState === 'mapped') read.unmap();
            read.destroy();
        }
    }

    // CHECKITOUT: this is where the light movement compute shader is dispatched from the host
    onFrame(time: number) {
        device.queue.writeBuffer(this.timeUniformBuffer, 0, new Float32Array([time]));

        // not using same encoder as render pass so this doesn't interfere with measuring actual rendering performance
        const encoder = device.createCommandEncoder();

        const computePass = encoder.beginComputePass();
        computePass.setPipeline(this.moveLightsComputePipeline);

        computePass.setBindGroup(0, this.moveLightsComputeBindGroup);

        const workgroupCount = Math.ceil(this.numLights / shaders.constants.moveLightsWorkgroupSize);
        computePass.dispatchWorkgroups(workgroupCount);

        computePass.end();

        device.queue.submit([encoder.finish()]);
    }
}
