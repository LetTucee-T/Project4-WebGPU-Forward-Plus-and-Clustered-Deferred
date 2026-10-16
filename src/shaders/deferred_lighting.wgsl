@group(${bindGroup_scene}) @binding(0) var<uniform> camera: CameraUniforms;
@group(${bindGroup_scene}) @binding(1) var<storage, read> lightSet: LightSet;
@group(${bindGroup_scene}) @binding(2) var<storage, read> clusterSet: ClusterSet;

// Shared by the raster, compute and packed-compute paths.
fn shadeDeferred(position: vec3f, normal: vec3f, albedo: vec3f, pixel: vec2f, viewDepth: f32) -> vec4f {
    let index = fragmentClusterIndex(pixel, viewDepth, camera.screenSize, camera.nearPlane, camera.farPlane);
    let count = clusterSet.clusters[index].count;
    var totalLightContrib = vec3f(0);
    for (var i = 0u; i < count; i++) {
        let lightIndex = clusterSet.clusters[index].lightIndices[i];
        totalLightContrib += calculateLightContrib(lightSet.lights[lightIndex], position, normal);
    }
    return vec4f(albedo * totalLightContrib, 1);
}
