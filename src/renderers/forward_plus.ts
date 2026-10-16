import * as renderer from '../renderer';
import * as shaders from '../shaders/shaders';
import { Stage } from '../stage/stage';

export class ForwardPlusRenderer extends renderer.Renderer {
    sceneUniformsBindGroupLayout: GPUBindGroupLayout;
    sceneUniformsBindGroup: GPUBindGroup;
    depthTexture: GPUTexture;
    depthTextureView: GPUTextureView;
    pipeline: GPURenderPipeline;
    depthPipeline: GPURenderPipeline;
    depthEqualPipeline: GPURenderPipeline;
    activeClustersBindGroup: GPUBindGroup;
    activeClustersPipeline: GPURenderPipeline;

    constructor(stage: Stage, public depthPrepass = false, public depthClusterCulling = false) {
        super(stage);

        this.sceneUniformsBindGroupLayout = renderer.device.createBindGroupLayout({
            label: "forward+ scene bind group layout",
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                    buffer: { type: "uniform" }
                },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
                { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } }
            ]
        });
        this.sceneUniformsBindGroup = renderer.device.createBindGroup({
            label: "forward+ scene bind group",
            layout: this.sceneUniformsBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.camera.uniformsBuffer } },
                { binding: 1, resource: { buffer: this.lights.lightSetStorageBuffer } },
                { binding: 2, resource: { buffer: this.lights.clusterSetStorageBuffer } }
            ]
        });

        this.depthTexture = renderer.device.createTexture({
            label: "forward+ depth",
            size: [renderer.canvas.width, renderer.canvas.height],
            format: "depth24plus-stencil8",
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
        });
        this.depthTextureView = this.depthTexture.createView();
        const activeLayout = renderer.device.createBindGroupLayout({
            label: 'active cluster marking layout',
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
                { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'storage' } }
            ]
        });
        this.activeClustersBindGroup = renderer.device.createBindGroup({
            label: 'active cluster marking bind group', layout: activeLayout,
            entries: [
                { binding: 0, resource: { buffer: this.camera.uniformsBuffer } },
                { binding: 1, resource: this.depthTexture.createView({ aspect: 'depth-only' }) },
                { binding: 2, resource: { buffer: this.lights.activeClustersBuffer } }
            ]
        });
        this.activeClustersPipeline = renderer.device.createRenderPipeline({
            label: 'active cluster fullscreen quad pipeline',
            layout: renderer.device.createPipelineLayout({ bindGroupLayouts: [activeLayout] }),
            vertex: { module: renderer.device.createShaderModule({ label: 'active cluster quad vertex shader', code: shaders.activeClustersVertSrc }) },
            fragment: { module: renderer.device.createShaderModule({ label: 'active cluster marking fragment shader', code: shaders.activeClustersFragSrc }), targets: [] },
            depthStencil: { format: 'depth24plus-stencil8', depthWriteEnabled: false, depthCompare: 'always', stencilWriteMask: 0 }
        });

        const layout = renderer.device.createPipelineLayout({
            label: "forward+ pipeline layout",
            bindGroupLayouts: [
                this.sceneUniformsBindGroupLayout,
                renderer.modelBindGroupLayout,
                renderer.materialBindGroupLayout
            ]
        });
        // The same vertex module and raster state are used by all three pipelines.
        const vertex: GPUVertexState = {
            module: renderer.device.createShaderModule({
                label: "forward+ vertex shader",
                code: shaders.naiveVertSrc
            }),
            buffers: [renderer.vertexBufferLayout]
        };
        const fragment: GPUFragmentState = {
            module: renderer.device.createShaderModule({
                label: "forward+ fragment shader",
                code: shaders.forwardPlusFragSrc
            }),
            targets: [{ format: renderer.canvasFormat }]
        };
        this.pipeline = renderer.device.createRenderPipeline({
            label: "forward+ render pipeline",
            layout, vertex, fragment,
            depthStencil: {
                depthWriteEnabled: true,
                depthCompare: "less",
                format: "depth24plus-stencil8",
                stencilWriteMask: 0
            }
        });
        this.depthPipeline = renderer.device.createRenderPipeline({
            label: "forward+ depth prepass pipeline",
            layout, vertex,
            depthStencil: { depthWriteEnabled: true, depthCompare: "less", format: "depth24plus-stencil8", stencilWriteMask: 0 },
            fragment: {
                module: renderer.device.createShaderModule({
                    label: "forward+ depth prepass fragment shader",
                    code: shaders.depthPrepassFragSrc
                }),
                targets: []
            }
        });
        this.depthEqualPipeline = renderer.device.createRenderPipeline({
            label: "forward+ shading after depth prepass pipeline",
            layout, vertex, fragment,
            depthStencil: {
                depthWriteEnabled: false, depthCompare: "equal", format: "depth24plus-stencil8",
                // Equal-depth surfaces must preserve the baseline's first-drawn winner.
                // Reference 0 accepts an unshaded pixel; increment marks it as shaded.
                stencilFront: { compare: "equal", passOp: "increment-clamp" },
                stencilBack: { compare: "equal", passOp: "increment-clamp" },
                stencilReadMask: 0xff, stencilWriteMask: 0xff
            }
        });
    }

    override draw(timing?: renderer.GpuTimingFrame) {
        const encoder = renderer.device.createCommandEncoder({ label: "forward+ frame" });
        const useDepthPrepass = this.depthPrepass || this.depthClusterCulling;
        if (useDepthPrepass) {
            const depthPass = encoder.beginRenderPass({
                label: "forward+ depth prepass",
                timestampWrites: timing?.writes('depth'),
                colorAttachments: [],
                depthStencilAttachment: {
                    view: this.depthTextureView,
                    depthClearValue: 1,
                    depthLoadOp: "clear",
                    depthStoreOp: "store",
                    stencilReadOnly: true
                }
            });
            depthPass.setPipeline(this.depthPipeline);
            this.drawScene(depthPass);
            depthPass.end();
        }
        if (this.depthClusterCulling) {
            // Clear on the GPU each frame so previous views cannot leave stale flags.
            // This command is between the first/last timestamps, included in GPU span.
            encoder.clearBuffer(this.lights.activeClustersBuffer);
            const mark = encoder.beginRenderPass({
                label: 'active cluster marking pass', timestampWrites: timing?.writes('marking'),
                colorAttachments: [],
                // Read-only depth can be sampled in this pass and also supplies its size.
                depthStencilAttachment: { view: this.depthTextureView, depthReadOnly: true, stencilReadOnly: true }
            });
            mark.setPipeline(this.activeClustersPipeline);
            mark.setBindGroup(0, this.activeClustersBindGroup);
            mark.setViewport(0, 0, Math.ceil(renderer.canvas.width / shaders.constants.clusterMarkingBlockSize),
                Math.ceil(renderer.canvas.height / shaders.constants.clusterMarkingBlockSize), 0, 1);
            mark.draw(6);
            mark.end();
        }
        this.lights.doLightClustering(encoder, timing, this.depthClusterCulling);

        const pass = encoder.beginRenderPass({
            label: "forward+ render pass",
            timestampWrites: timing?.writes('shading'),
            colorAttachments: [{
                view: renderer.context.getCurrentTexture().createView(),
                clearValue: [0, 0, 0, 0],
                loadOp: "clear",
                storeOp: "store"
            }],
            depthStencilAttachment: useDepthPrepass ? {
                view: this.depthTextureView,
                depthReadOnly: true,
                stencilClearValue: 0,
                stencilLoadOp: "clear",
                stencilStoreOp: "discard"
            } : {
                view: this.depthTextureView,
                depthClearValue: 1,
                depthLoadOp: "clear",
                depthStoreOp: "store",
                stencilReadOnly: true
            }
        });
        pass.setPipeline(useDepthPrepass ? this.depthEqualPipeline : this.pipeline);
        pass.setStencilReference(0);
        this.drawScene(pass);
        pass.end();
        this.submit(encoder, timing);
    }

    private drawScene(pass: GPURenderPassEncoder) {
        pass.setBindGroup(shaders.constants.bindGroup_scene, this.sceneUniformsBindGroup);
        this.scene.iterate(node => {
            pass.setBindGroup(shaders.constants.bindGroup_model, node.modelBindGroup);
        }, material => {
            pass.setBindGroup(shaders.constants.bindGroup_material, material.materialBindGroup);
        }, primitive => {
            pass.setVertexBuffer(0, primitive.vertexBuffer);
            pass.setIndexBuffer(primitive.indexBuffer, 'uint32');
            pass.drawIndexed(primitive.numIndices);
        });
    }

    override stop() {
        super.stop();
        this.depthTexture.destroy();
    }
}
