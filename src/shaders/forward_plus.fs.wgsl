@group(${bindGroup_scene}) @binding(0) var<uniform> camera: CameraUniforms;
@group(${bindGroup_scene}) @binding(1) var<storage, read> lightSet: LightSet;
@group(${bindGroup_scene}) @binding(2) var<storage, read> clusterSet: ClusterSet;

@group(${bindGroup_material}) @binding(0) var diffuseTex: texture_2d<f32>;
@group(${bindGroup_material}) @binding(1) var diffuseTexSampler: sampler;

struct FragmentInput {
    @builtin(position) fragPos: vec4f,
    @location(0) pos: vec3f,
    @location(1) nor: vec3f,
    @location(2) uv: vec2f
}

@fragment
fn main(in: FragmentInput) -> @location(0) vec4f {
    let diffuseColor = textureSample(diffuseTex, diffuseTexSampler, in.uv);
    if (diffuseColor.a < 0.5f) {
        discard;
    }

    let viewPos = camera.viewMat * vec4f(in.pos, 1);
    let index = fragmentClusterIndex(in.fragPos.xy, -viewPos.z,
        camera.screenSize, camera.nearPlane, camera.farPlane);
    let count = clusterSet.clusters[index].count;
    let normal = normalize(in.nor);
    var totalLightContrib = vec3f(0);
    for (var i = 0u; i < count; i++) {
        let lightIndex = clusterSet.clusters[index].lightIndices[i];
        totalLightContrib += calculateLightContrib(lightSet.lights[lightIndex], in.pos, normal);
    }
    return vec4f(diffuseColor.rgb * totalLightContrib, 1);
}
