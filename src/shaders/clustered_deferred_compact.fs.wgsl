@group(${bindGroup_scene}) @binding(0) var<uniform> camera: CameraUniforms;
@group(${bindGroup_material}) @binding(0) var diffuseTex: texture_2d<f32>;
@group(${bindGroup_material}) @binding(1) var diffuseTexSampler: sampler;

struct FragmentInput {
    @location(0) pos: vec3f,
    @location(1) nor: vec3f,
    @location(2) uv: vec2f
}
@fragment
fn main(in: FragmentInput) -> @location(0) vec4u {
    let diffuseColor = textureSample(diffuseTex, diffuseTexSampler, in.uv);
    if (diffuseColor.a < 0.5f) { discard; }
    // 16 bytes: linear depth f32, oct normal 2xsnorm16, RGB 3xf16, unused f16.
    // Linear depth avoids far-plane NDC precision loss.
    let depth = -(camera.viewMat * vec4f(in.pos, 1)).z;
    return vec4u(bitcast<u32>(depth), packNormal(in.nor),
        pack2x16float(diffuseColor.rg), pack2x16float(vec2f(diffuseColor.b, 0)));
}
