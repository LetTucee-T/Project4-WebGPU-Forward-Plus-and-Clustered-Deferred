@group(2) @binding(0) var outputImage: texture_storage_2d<__CANVAS_STORAGE_FORMAT__, write>;

@compute @workgroup_size(${deferredWorkgroupSize}, ${deferredWorkgroupSize})
fn main(@builtin(global_invocation_id) invocation: vec3u) {
    let pixel = invocation.xy;
    if (any(pixel >= textureDimensions(outputImage))) { return; }
    // Write every in-bounds pixel, including transparent black for background.
    textureStore(outputImage, vec2i(pixel), readDeferredPixel(pixel));
}
