// Octahedral encoding covers both hemispheres, including negative Z.
// Nonzero signs preserve the fold on an axis (WGSL sign(0) would lose it).
fn octSigns(v: vec2f) -> vec2f {
    return select(vec2f(-1), vec2f(1), v >= vec2f(0));
}
fn packNormal(normal: vec3f) -> u32 {
    let n = normalize(normal);
    var p = n.xy / (abs(n.x) + abs(n.y) + abs(n.z));
    if (n.z < 0.f) { p = (vec2f(1) - abs(p.yx)) * octSigns(p); }
    return pack2x16snorm(p);
}
fn unpackNormal(packed: u32) -> vec3f {
    let p = unpack2x16snorm(packed);
    var n = vec3f(p, 1.f - abs(p.x) - abs(p.y));
    if (n.z < 0.f) { n = vec3f((vec2f(1) - abs(n.yx)) * octSigns(n.xy), n.z); }
    return normalize(n);
}

// Alpha-tested surfaces are opaque, so use 30 of the color word's 32 bits for RGB.
// Square-root companding preserves dark albedo more accurately near bright lights.
// This is a storage encoding: square on decode restores the original color space.
fn packAlbedo10(color: vec3f) -> u32 {
    let rgb = vec3u(round(sqrt(clamp(color, vec3f(0), vec3f(1))) * 1023.f));
    return rgb.x | (rgb.y << 10u) | (rgb.z << 20u);
}
fn unpackAlbedo10(packed: u32) -> vec3f {
    let rgb = vec3f(vec3u(packed, packed >> 10u, packed >> 20u) & vec3u(1023u)) / 1023.f;
    return rgb * rgb;
}
