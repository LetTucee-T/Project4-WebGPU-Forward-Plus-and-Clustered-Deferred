@group(${bindGroup_material}) @binding(0) var diffuseTex: texture_2d<f32>;
@group(${bindGroup_material}) @binding(1) var diffuseTexSampler: sampler;

// Match the lighting pass's alpha test so cutouts do not occlude the scene.
// There is no color output or lighting work in this pass.
@fragment
fn main(@location(2) uv: vec2f) {
    let diffuseColor = textureSample(diffuseTex, diffuseTexSampler, uv);
    if (diffuseColor.a < 0.5f) {
        discard;
    }
}
