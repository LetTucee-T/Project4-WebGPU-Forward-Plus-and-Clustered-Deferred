@fragment
fn main(@builtin(position) fragPos: vec4f) -> @location(0) vec4f {
    return readDeferredPixel(vec2u(fragPos.xy));
}
