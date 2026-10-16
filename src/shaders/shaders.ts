// CHECKITOUT: this file loads all the shaders and preprocesses them with some common code

import commonRaw from './common.wgsl?raw';

import naiveVertRaw from './naive.vs.wgsl?raw';
import naiveFragRaw from './naive.fs.wgsl?raw';

import forwardPlusFragRaw from './forward_plus.fs.wgsl?raw';
import depthPrepassFragRaw from './depth_prepass.fs.wgsl?raw';
import activeClustersVertRaw from './active_clusters.vs.wgsl?raw';
import activeClustersFragRaw from './active_clusters.fs.wgsl?raw';

import clusteredDeferredFragRaw from './clustered_deferred.fs.wgsl?raw';
import clusteredDeferredFullscreenVertRaw from './clustered_deferred_fullscreen.vs.wgsl?raw';
import clusteredDeferredFullscreenFragRaw from './clustered_deferred_fullscreen.fs.wgsl?raw';
import deferredLightingRaw from './deferred_lighting.wgsl?raw';
import deferredGBufferRaw from './deferred_gbuffer.wgsl?raw';
import deferredCompactBufferRaw from './deferred_compact_buffer.wgsl?raw';
import deferredCompact8BufferRaw from './deferred_compact8_buffer.wgsl?raw';
import gBufferPackingRaw from './gbuffer_packing.wgsl?raw';
import clusteredDeferredCompactFragRaw from './clustered_deferred_compact.fs.wgsl?raw';
import clusteredDeferredCompact8FragRaw from './clustered_deferred_compact8.fs.wgsl?raw';
import clusteredDeferredLightingComputeRaw from './clustered_deferred_lighting.cs.wgsl?raw';

import moveLightsComputeRaw from './move_lights.cs.wgsl?raw';
import clusteringComputeRaw from './clustering.cs.wgsl?raw';
import transformLightsComputeRaw from './transform_lights.cs.wgsl?raw';

// CONSTANTS (for use in shaders)
// =================================

// CHECKITOUT: feel free to add more constants here and to refer to them in your shader code

// The preprocessor reads these by name so bundling preserves constants used only in WGSL.
export const constants = {
    bindGroup_scene: 0,
    bindGroup_model: 1,
    bindGroup_material: 2,
    bindGroup_gBuffer: 1, // fullscreen pipeline only

    moveLightsWorkgroupSize: 128,

    maxNumLights: 5000,
    clusterGridX: 16,
    clusterGridY: 9,
    clusterGridZ: 24,
    clusteringWorkgroupSize: 64,
    clusterDepthEpsilon: 0.000002,
    clusterMarkingBlockSize: 2,
    deferredWorkgroupSize: 8,

    lightRadius: 2
};

// =================================

function substituteShaderConstants(raw: string) {
    return raw.replace(/\$\{(\w+)\}/g, (_, name: string) => {
        if (!Object.prototype.hasOwnProperty.call(constants, name)) {
            throw new Error(`Unknown shader constant: ${name}`);
        }
        return String(constants[name as keyof typeof constants]);
    });
}

const commonSrc: string = substituteShaderConstants(commonRaw);

function processShaderRaw(raw: string) {
    return commonSrc + substituteShaderConstants(raw);
}

export const naiveVertSrc: string = processShaderRaw(naiveVertRaw);
export const naiveFragSrc: string = processShaderRaw(naiveFragRaw);

export const forwardPlusFragSrc: string = processShaderRaw(forwardPlusFragRaw);
export const depthPrepassFragSrc: string = processShaderRaw(depthPrepassFragRaw);
export const activeClustersVertSrc: string = processShaderRaw(activeClustersVertRaw);
export const activeClustersFragSrc: string = processShaderRaw(activeClustersFragRaw);

export const clusteredDeferredFragSrc: string = processShaderRaw(clusteredDeferredFragRaw);
export const clusteredDeferredFullscreenVertSrc: string = processShaderRaw(clusteredDeferredFullscreenVertRaw);
export const clusteredDeferredFullscreenFragSrc: string = processShaderRaw(deferredLightingRaw + deferredGBufferRaw + clusteredDeferredFullscreenFragRaw);
export const clusteredDeferredComputeSrc: string = processShaderRaw(deferredLightingRaw + deferredGBufferRaw + clusteredDeferredLightingComputeRaw);
export const clusteredDeferredCompactFragSrc: string = processShaderRaw(gBufferPackingRaw + clusteredDeferredCompactFragRaw);
export const clusteredDeferredCompactComputeSrc: string = processShaderRaw(gBufferPackingRaw + deferredLightingRaw + deferredCompactBufferRaw + clusteredDeferredLightingComputeRaw);
export const clusteredDeferredCompact8FragSrc: string = processShaderRaw(gBufferPackingRaw + clusteredDeferredCompact8FragRaw);
export const clusteredDeferredCompact8ComputeSrc: string = processShaderRaw(gBufferPackingRaw + deferredLightingRaw + deferredCompact8BufferRaw + clusteredDeferredLightingComputeRaw);

export const moveLightsComputeSrc: string = processShaderRaw(moveLightsComputeRaw);
export const clusteringComputeSrc: string = processShaderRaw(clusteringComputeRaw);
export const transformLightsComputeSrc: string = processShaderRaw(transformLightsComputeRaw);
