// CHECKITOUT: code that you add here will be prepended to all shaders

struct Light {
    pos: vec3f,
    color: vec3f
}

struct LightSet {
    numLights: u32,
    lights: array<Light>
}

const CLUSTER_GRID = vec3u(${clusterGridX}, ${clusterGridY}, ${clusterGridZ});

// Each cluster has its own fixed slice. Capacity equals the supported light
// count, so even the worst case (all lights overlap) cannot drop a light.
struct Cluster {
    count: u32,
    lightIndices: array<u32, ${maxNumLights}>
}

struct ClusterSet {
    clusters: array<Cluster>
}

struct CameraUniforms {
    viewProjMat: mat4x4f,
    viewMat: mat4x4f,
    invProjMat: mat4x4f,
    screenSize: vec2f,
    nearPlane: f32,
    farPlane: f32,
    invViewMat: mat4x4f
}

fn clusterIndex(coords: vec3u) -> u32 {
    return (coords.z * CLUSTER_GRID.y + coords.y) * CLUSTER_GRID.x + coords.x;
}

fn clusterDepthBoundary(slice: u32, near: f32, far: f32) -> f32 {
    return near * pow(far / near, f32(slice) / f32(CLUSTER_GRID.z));
}

// Fragment position uses physical framebuffer pixels with a top-left origin.
// Depth is positive view-space depth (-viewPos.z), not the depth-buffer value.
fn fragmentClusterIndex(pixel: vec2f, depth: f32, screenSize: vec2f, near: f32, far: f32) -> u32 {
    let xy = vec2u(clamp(floor(pixel / screenSize * vec2f(CLUSTER_GRID.xy)),
        vec2f(0), vec2f(CLUSTER_GRID.xy - vec2u(1))));
    let z = u32(clamp(floor(log(clamp(depth, near, far) / near) / log(far / near)
        * f32(CLUSTER_GRID.z)), 0.f, f32(CLUSTER_GRID.z - 1u)));
    return clusterIndex(vec3u(xy, z));
}

// CHECKITOUT: this special attenuation function ensures lights don't affect geometry outside the maximum light radius
fn rangeAttenuation(distance: f32) -> f32 {
    return clamp(1.f - pow(distance / ${lightRadius}, 4.f), 0.f, 1.f) / (distance * distance);
}

fn calculateLightContrib(light: Light, posWorld: vec3f, nor: vec3f) -> vec3f {
    let vecToLight = light.pos - posWorld;
    let distToLight = length(vecToLight);

    let lambert = max(dot(nor, normalize(vecToLight)), 0.f);
    return light.color * lambert * rangeAttenuation(distToLight);
}
