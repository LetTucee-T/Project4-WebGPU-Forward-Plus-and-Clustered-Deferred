import * as renderer from '../renderer';
import * as shaders from '../shaders/shaders';
import { Stage } from '../stage/stage';

export type DeferredVariant = 'raster' | 'compute' | 'compact' | 'compact8';

export class ClusteredDeferredRenderer extends renderer.Renderer {
    geometryBindGroup: GPUBindGroup;
    lightingBindGroup: GPUBindGroup;
    gBufferBindGroup: GPUBindGroup;
    gBufferTextures: GPUTexture[];
    gBufferViews: GPUTextureView[];
    depthTexture: GPUTexture;
    depthTextureView: GPUTextureView;
    geometryPipeline: GPURenderPipeline;
    lightingPipeline?: GPURenderPipeline;
    computePipeline?: GPUComputePipeline;
    outputLayout?: GPUBindGroupLayout;

    constructor(stage: Stage, readonly variant: DeferredVariant = 'raster') {
        super(stage);
        const compact8 = variant === 'compact8';
        const compact = variant === 'compact' || compact8;
        const depthFormat: GPUTextureFormat = compact8 ? 'depth32float' : 'depth24plus';
        const lightingStage = variant === 'raster' ? GPUShaderStage.FRAGMENT : GPUShaderStage.COMPUTE;

        const geometryBindGroupLayout = renderer.device.createBindGroupLayout({
            label: "deferred geometry scene layout",
            entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }]
        });
        this.geometryBindGroup = renderer.device.createBindGroup({
            label: "deferred geometry scene bind group",
            layout: geometryBindGroupLayout,
            entries: [{ binding: 0, resource: { buffer: this.camera.uniformsBuffer } }]
        });

        const lightingBindGroupLayout = renderer.device.createBindGroupLayout({
            label: "deferred lighting scene layout",
            entries: [
                { binding: 0, visibility: lightingStage, buffer: { type: "uniform" } },
                { binding: 1, visibility: lightingStage, buffer: { type: "read-only-storage" } },
                { binding: 2, visibility: lightingStage, buffer: { type: "read-only-storage" } }
            ]
        });
        this.lightingBindGroup = renderer.device.createBindGroup({
            label: "deferred lighting scene bind group",
            layout: lightingBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.camera.uniformsBuffer } },
                { binding: 1, resource: { buffer: this.lights.lightSetStorageBuffer } },
                { binding: 2, resource: { buffer: this.lights.clusterSetStorageBuffer } }
            ]
        });

        // 16 + 8 + 8 = 32 color bytes per sample, within the default WebGPU limit.
        // Keep position at full precision; normal and albedo can use half floats.
        const formats: GPUTextureFormat[] = compact8 ? ['rg32uint'] : compact ? ['rgba32uint'] : ["rgba32float", "rgba16float", "rgba16float"];
        const names = compact ? ['packed'] : ["position", "normal", "albedo"];
        this.gBufferTextures = formats.map((format, i) => renderer.device.createTexture({
            label: `deferred G-buffer ${names[i]}`,
            size: [renderer.canvas.width, renderer.canvas.height],
            format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
        }));
        this.gBufferViews = this.gBufferTextures.map(texture => texture.createView());
        this.depthTexture = renderer.device.createTexture({
            label: "deferred depth",
            size: [renderer.canvas.width, renderer.canvas.height],
            format: depthFormat,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | (compact8 ? GPUTextureUsage.TEXTURE_BINDING : 0)
        });
        this.depthTextureView = this.depthTexture.createView();

        // Textures are read only after the geometry pass has finished.
        // rgba32float needs an explicit unfilterable binding; textureLoad needs no sampler.
        const gBufferBindGroupLayout = renderer.device.createBindGroupLayout({
            label: "deferred G-buffer layout",
            entries: compact8 ? [
                { binding: 0, visibility: lightingStage, texture: { sampleType: 'uint' } },
                { binding: 1, visibility: lightingStage, texture: { sampleType: 'depth' } }
            ] : compact ? [{ binding: 0, visibility: lightingStage, texture: { sampleType: 'uint' } }] : [
                { binding: 0, visibility: lightingStage, texture: { sampleType: "unfilterable-float" } },
                { binding: 1, visibility: lightingStage, texture: { sampleType: "float" } },
                { binding: 2, visibility: lightingStage, texture: { sampleType: "float" } }
            ]
        });
        this.gBufferBindGroup = renderer.device.createBindGroup({
            label: "deferred G-buffer bind group",
            layout: gBufferBindGroupLayout,
            entries: [...this.gBufferViews, ...(compact8 ? [this.depthTextureView] : [])]
                .map((view, binding) => ({ binding, resource: view }))
        });

        this.geometryPipeline = renderer.device.createRenderPipeline({
            label: "deferred G-buffer pipeline",
            layout: renderer.device.createPipelineLayout({
                bindGroupLayouts: [geometryBindGroupLayout, renderer.modelBindGroupLayout, renderer.materialBindGroupLayout]
            }),
            depthStencil: { depthWriteEnabled: true, depthCompare: "less", format: depthFormat },
            vertex: {
                module: renderer.device.createShaderModule({ label: "deferred geometry vertex shader", code: shaders.naiveVertSrc }),
                buffers: [renderer.vertexBufferLayout]
            },
            fragment: {
                module: renderer.device.createShaderModule({ label: `deferred ${variant} G-buffer fragment shader`,
                    code: compact8 ? shaders.clusteredDeferredCompact8FragSrc : compact ? shaders.clusteredDeferredCompactFragSrc : shaders.clusteredDeferredFragSrc }),
                targets: formats.map(format => ({ format }))
            }
        });
        if (variant === 'raster') this.lightingPipeline = renderer.device.createRenderPipeline({
            label: "deferred fullscreen pipeline",
            layout: renderer.device.createPipelineLayout({ bindGroupLayouts: [lightingBindGroupLayout, gBufferBindGroupLayout] }),
            vertex: {
                module: renderer.device.createShaderModule({ label: "deferred fullscreen vertex shader", code: shaders.clusteredDeferredFullscreenVertSrc })
            },
            fragment: {
                module: renderer.device.createShaderModule({ label: "deferred fullscreen fragment shader", code: shaders.clusteredDeferredFullscreenFragSrc }),
                targets: [{ format: renderer.canvasFormat }]
            }
        });
        else {
            this.outputLayout = renderer.device.createBindGroupLayout({
                label: 'deferred compute output layout',
                entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE,
                    storageTexture: { access: 'write-only', format: renderer.canvasFormat } }]
            });
            this.computePipeline = renderer.device.createComputePipeline({
                label: `deferred ${variant} lighting pipeline`,
                layout: renderer.device.createPipelineLayout({ bindGroupLayouts: [lightingBindGroupLayout, gBufferBindGroupLayout, this.outputLayout] }),
                compute: { module: renderer.device.createShaderModule({
                    label: `deferred ${variant} lighting compute shader`,
                    code: (compact8 ? shaders.clusteredDeferredCompact8ComputeSrc : compact ? shaders.clusteredDeferredCompactComputeSrc : shaders.clusteredDeferredComputeSrc)
                        .replace('__CANVAS_STORAGE_FORMAT__', renderer.canvasFormat)
                }) }
            });
        }
    }

    override draw(timing?: renderer.GpuTimingFrame) {
        const encoder = renderer.device.createCommandEncoder({ label: "clustered deferred frame" });
        this.lights.doLightClustering(encoder, timing);

        const geometryPass = encoder.beginRenderPass({
            label: "deferred G-buffer pass",
            timestampWrites: timing?.writes('geometry'),
            colorAttachments: this.gBufferViews.map(view => ({
                view,
                clearValue: [0, 0, 0, 0],
                loadOp: "clear",
                storeOp: "store"
            })),
            depthStencilAttachment: {
                view: this.depthTextureView,
                depthClearValue: 1,
                depthLoadOp: "clear",
                // The 8 B path reconstructs position from hardware depth after this pass.
                depthStoreOp: this.variant === 'compact8' ? 'store' : 'discard'
            }
        });
        geometryPass.setPipeline(this.geometryPipeline);
        geometryPass.setBindGroup(shaders.constants.bindGroup_scene, this.geometryBindGroup);
        this.scene.iterate(node => {
            geometryPass.setBindGroup(shaders.constants.bindGroup_model, node.modelBindGroup);
        }, material => {
            geometryPass.setBindGroup(shaders.constants.bindGroup_material, material.materialBindGroup);
        }, primitive => {
            geometryPass.setVertexBuffer(0, primitive.vertexBuffer);
            geometryPass.setIndexBuffer(primitive.indexBuffer, 'uint32');
            geometryPass.drawIndexed(primitive.numIndices);
        });
        geometryPass.end();

        if (this.computePipeline) {
            // The swapchain texture changes; create only its small bind group per frame.
            const output = renderer.device.createBindGroup({
                label: 'deferred compute output', layout: this.outputLayout!,
                entries: [{ binding: 0, resource: renderer.context.getCurrentTexture().createView() }]
            });
            const lighting = encoder.beginComputePass({ label: 'deferred compute lighting pass', timestampWrites: timing?.writes('lighting') });
            lighting.setPipeline(this.computePipeline);
            lighting.setBindGroup(shaders.constants.bindGroup_scene, this.lightingBindGroup);
            lighting.setBindGroup(shaders.constants.bindGroup_gBuffer, this.gBufferBindGroup);
            lighting.setBindGroup(2, output);
            const size = shaders.constants.deferredWorkgroupSize;
            lighting.dispatchWorkgroups(Math.ceil(renderer.canvas.width / size), Math.ceil(renderer.canvas.height / size));
            lighting.end();
        } else {
            const lightingPass = encoder.beginRenderPass({
                label: "deferred fullscreen pass",
                timestampWrites: timing?.writes('lighting'),
                colorAttachments: [{
                    view: renderer.context.getCurrentTexture().createView(),
                    clearValue: [0, 0, 0, 0],
                    loadOp: "clear",
                    storeOp: "store"
                }]
            });
            lightingPass.setPipeline(this.lightingPipeline!);
            lightingPass.setBindGroup(shaders.constants.bindGroup_scene, this.lightingBindGroup);
            lightingPass.setBindGroup(shaders.constants.bindGroup_gBuffer, this.gBufferBindGroup);
            lightingPass.draw(3);
            lightingPass.end();
        }
        this.submit(encoder, timing);
    }

    override stop() {
        super.stop();
        this.gBufferTextures.forEach(texture => texture.destroy());
        this.depthTexture.destroy();
    }
}
