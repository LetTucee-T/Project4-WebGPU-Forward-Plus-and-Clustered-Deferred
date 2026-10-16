@group(${bindGroup_material}) @binding(0) var diffuseTex: texture_2d<f32>;
@group(${bindGroup_material}) @binding(1) var diffuseTexSampler: sampler;

struct FragmentInput {
    @location(0) pos: vec3f,
    @location(1) nor: vec3f,
    @location(2) uv: vec2f
}
@fragment
fn main(in: FragmentInput) -> @location(0) vec2u {
    let diffuseColor = textureSample(diffuseTex, diffuseTexSampler, in.uv);
    if (diffuseColor.a < 0.5f) { discard; }
    // Single rg32uint attachment: oct normal (4 B) + square-root RGB10 (4 B).
    // Alpha testing happens before quantization; surviving surfaces are opaque.
    // This LDR layout assumes material albedo in [0, 1].
    return vec2u(packNormal(in.nor), packAlbedo10(diffuseColor.rgb));
}
