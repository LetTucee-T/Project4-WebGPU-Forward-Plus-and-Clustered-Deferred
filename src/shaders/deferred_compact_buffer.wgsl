@group(${bindGroup_gBuffer}) @binding(0) var packedTex: texture_2d<u32>;

fn readDeferredPixel(pixel: vec2u) -> vec4f {
    let packed = textureLoad(packedTex, vec2i(pixel), 0);
    // Positive linear depth also distinguishes geometry from clear zero.
    let depth = bitcast<f32>(packed.x);
    if (depth == 0.f) { return vec4f(0); }
    let center = vec2f(pixel) + vec2f(0.5);
    let uv = center / camera.screenSize;
    let ndc = vec2f(uv.x * 2.f - 1.f, 1.f - uv.y * 2.f);
    let homogeneous = camera.invProjMat * vec4f(ndc, 0, 1);
    let ray = homogeneous.xyz / homogeneous.w;
    let viewPosition = ray * (depth / -ray.z);
    let worldPosition = (camera.invViewMat * vec4f(viewPosition, 1)).xyz;
    let albedo = vec3f(unpack2x16float(packed.z), unpack2x16float(packed.w).x);
    return shadeDeferred(worldPosition, unpackNormal(packed.y), albedo, center, depth);
}
