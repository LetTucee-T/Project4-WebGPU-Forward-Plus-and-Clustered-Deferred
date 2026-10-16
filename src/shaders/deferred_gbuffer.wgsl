@group(${bindGroup_gBuffer}) @binding(0) var positionTex: texture_2d<f32>;
@group(${bindGroup_gBuffer}) @binding(1) var normalTex: texture_2d<f32>;
@group(${bindGroup_gBuffer}) @binding(2) var albedoTex: texture_2d<f32>;

fn readDeferredPixel(pixel: vec2u) -> vec4f {
    let position = textureLoad(positionTex, vec2i(pixel), 0);
    if (position.w == 0.f) { return vec4f(0); }
    let normal = normalize(textureLoad(normalTex, vec2i(pixel), 0).xyz);
    let albedo = textureLoad(albedoTex, vec2i(pixel), 0).rgb;
    let viewPos = camera.viewMat * vec4f(position.xyz, 1);
    return shadeDeferred(position.xyz, normal, albedo, vec2f(pixel) + vec2f(0.5), -viewPos.z);
}
