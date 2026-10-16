@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(0) @binding(1) var sceneDepth: texture_depth_2d;
@group(0) @binding(2) var<storage, read_write> activeClusters: array<atomic<u32>>;

fn viewDepth(depth: f32) -> f32 {
    // This camera uses a standard perspective projection; view z does not depend on x/y.
    let view = camera.invProjMat * vec4f(0, 0, depth, 1);
    return -view.z / view.w;
}

@fragment
fn main(@builtin(position) pixel: vec4f) {
    // The quad's viewport has one fragment per 2x2 source block. Read EVERY
    // source sample; thin geometry is preserved. Odd framebuffer edges are clipped.
    let blockSize = u32(${clusterMarkingBlockSize});
    let origin = vec2u(pixel.xy) * blockSize;
    let size = textureDimensions(sceneDepth);
    var minDepth = 1.f;
    var maxDepth = 0.f;
    for (var y = 0u; y < blockSize; y++) {
        for (var x = 0u; x < blockSize; x++) {
            let source = origin + vec2u(x, y);
            if (all(source < size)) {
                let depth = textureLoad(sceneDepth, vec2i(source), 0);
                if (depth < 1.f) {
                    minDepth = min(minDepth, depth);
                    maxDepth = max(maxDepth, depth);
                }
            }
        }
    }
    if (minDepth >= 1.f) {
        return; // Clear depth is background, including holes left by alpha clipping.
    }
    // Depth-buffer quantization and f32 reconstruction can straddle a logarithmic
    // slice boundary. Conservatively mark the interval, using the shading pass's
    // same pixel-to-tile and view-depth-to-slice mapping. This may add false positives.
    let epsilon = f32(${clusterDepthEpsilon});
    let first = fragmentClusterIndex(vec2f(origin) + vec2f(0.5), viewDepth(max(minDepth - epsilon, 0.f)),
        camera.screenSize, camera.nearPlane, camera.farPlane);
    let end = min(origin + vec2u(blockSize - 1u), size - vec2u(1));
    let last = fragmentClusterIndex(vec2f(end) + vec2f(0.5), viewDepth(min(maxDepth + epsilon, 1.f)),
        camera.screenSize, camera.nearPlane, camera.farPlane);
    // A block can straddle tile or depth boundaries. Mark its bounding range;
    // this can include extra clusters, but cannot drop any sampled surface.
    let firstXY = vec2u(first % CLUSTER_GRID.x, (first / CLUSTER_GRID.x) % CLUSTER_GRID.y);
    let lastXY = vec2u(last % CLUSTER_GRID.x, (last / CLUSTER_GRID.x) % CLUSTER_GRID.y);
    for (var z = first / (CLUSTER_GRID.x * CLUSTER_GRID.y); z <= last / (CLUSTER_GRID.x * CLUSTER_GRID.y); z++) {
        for (var y = firstXY.y; y <= lastXY.y; y++) {
            for (var x = firstXY.x; x <= lastXY.x; x++) {
                let index = clusterIndex(vec3u(x, y, z));
                // All writers store 1. A preliminary read avoids redundant writes.
                if (atomicLoad(&activeClusters[index]) == 0u) {
                    atomicStore(&activeClusters[index], 1u);
                }
            }
        }
    }
}
