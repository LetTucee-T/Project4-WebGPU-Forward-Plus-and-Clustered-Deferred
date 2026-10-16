@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(0) @binding(1) var<storage, read> lightSet: LightSet;
@group(0) @binding(2) var<storage, read_write> clusterSet: ClusterSet;
@group(0) @binding(3) var<storage, read> viewLightPositions: array<vec4f>;
@group(0) @binding(4) var<storage, read> activeClusters: array<u32>;

// Specialized pipelines share the exact same culling and list-writing code.
override precomputeViewPositions: bool = false;
override skipInactiveClusters: bool = false;

// One invocation owns one cluster and its output list; no atomics are needed.
@compute @workgroup_size(${clusteringWorkgroupSize})
fn main(@builtin(global_invocation_id) invocation: vec3u) {
    let index = invocation.x;
    if (index >= CLUSTER_GRID.x * CLUSTER_GRID.y * CLUSTER_GRID.z) {
        return;
    }
    if (skipInactiveClusters && activeClusters[index] == 0u) {
        // Old list entries may remain, but their count must never survive a camera move.
        clusterSet.clusters[index].count = 0u;
        return;
    }
    let coords = vec3u(index % CLUSTER_GRID.x,
        (index / CLUSTER_GRID.x) % CLUSTER_GRID.y,
        index / (CLUSTER_GRID.x * CLUSTER_GRID.y));
    let nearDepth = clusterDepthBoundary(coords.z, camera.nearPlane, camera.farPlane);
    let farDepth = clusterDepthBoundary(coords.z + 1u, camera.nearPlane, camera.farPlane);

    var boundsMin = vec3f(1e30);
    var boundsMax = vec3f(-1e30);
    for (var y = 0u; y < 2u; y++) {
        for (var x = 0u; x < 2u; x++) {
            let screenCorner = vec2f(coords.xy + vec2u(x, y)) / vec2f(CLUSTER_GRID.xy);
            let ndc = vec2f(screenCorner.x * 2.f - 1.f, 1.f - screenCorner.y * 2.f);
            // WebGPU's near plane is at NDC z = 0. Unproject a point on each
            // corner ray, then intersect the ray with both view-depth planes.
            let homogeneous = camera.invProjMat * vec4f(ndc, 0, 1);
            let ray = homogeneous.xyz / homogeneous.w;
            let nearPoint = ray * (nearDepth / -ray.z);
            let farPoint = ray * (farDepth / -ray.z);
            boundsMin = min(boundsMin, min(nearPoint, farPoint));
            boundsMax = max(boundsMax, max(nearPoint, farPoint));
        }
    }

    // Keep culling conservative at slice/tile boundaries despite f32 rounding.
    let padding = vec3f(0.0001) + max(abs(boundsMin), abs(boundsMax)) * 0.00001;
    boundsMin -= padding;
    boundsMax += padding;

    var count = 0u;
    for (var lightIndex = 0u; lightIndex < lightSet.numLights; lightIndex++) {
        var center: vec3f;
        if (precomputeViewPositions) {
            center = viewLightPositions[lightIndex].xyz;
        } else {
            center = (camera.viewMat * vec4f(lightSet.lights[lightIndex].pos, 1)).xyz;
        }
        let closest = clamp(center, boundsMin, boundsMax);
        let delta = center - closest;
        if (dot(delta, delta) <= f32(${lightRadius} * ${lightRadius})) {
            // Access storage directly; never copy the large Cluster struct.
            clusterSet.clusters[index].lightIndices[count] = lightIndex;
            count++;
        }
    }
    // Always overwrite, including empty clusters after lights/camera move.
    clusterSet.clusters[index].count = count;
}
