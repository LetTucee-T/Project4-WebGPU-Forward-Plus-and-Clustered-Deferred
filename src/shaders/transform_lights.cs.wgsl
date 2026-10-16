@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(0) @binding(1) var<storage, read> lightSet: LightSet;
// A vec4 per light gives an explicit 16-byte stride shared with TypeScript.
@group(0) @binding(2) var<storage, read_write> viewLightPositions: array<vec4f>;

@compute @workgroup_size(${moveLightsWorkgroupSize})
fn main(@builtin(global_invocation_id) invocation: vec3u) {
    let index = invocation.x;
    if (index >= lightSet.numLights) {
        return;
    }
    viewLightPositions[index] = camera.viewMat * vec4f(lightSet.lights[index].pos, 1);
}
