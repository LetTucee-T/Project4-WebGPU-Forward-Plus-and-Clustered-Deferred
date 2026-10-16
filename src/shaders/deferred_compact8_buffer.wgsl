@group(${bindGroup_gBuffer}) @binding(0) var packedTex: texture_2d<u32>;
@group(${bindGroup_gBuffer}) @binding(1) var depthTex: texture_depth_2d;

fn readDeferredPixel(pixel: vec2u) -> vec4f {
    let depth = textureLoad(depthTex, vec2i(pixel), 0);
    // Depth clear=1. Geometry uses less, so background has no stored attributes.
    if (depth >= 1.f) { return vec4f(0); }
    let center = vec2f(pixel) + vec2f(0.5);
    let uv = center / camera.screenSize;
    let ndc = vec2f(uv.x * 2.f - 1.f, 1.f - uv.y * 2.f);
    // WebGPU NDC depth is [0, 1]; do not remap it to [-1, 1].
    let homogeneous = camera.invProjMat * vec4f(ndc, depth, 1);
    let viewPosition = homogeneous.xyz / homogeneous.w;
    let worldPosition = (camera.invViewMat * vec4f(viewPosition, 1)).xyz;
    let packed = textureLoad(packedTex, vec2i(pixel), 0);
    return shadeDeferred(worldPosition, unpackNormal(packed.x), unpackAlbedo10(packed.y),
        center, -viewPosition.z);
}
