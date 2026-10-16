@vertex
fn main(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4f {
    // One oversized triangle covers the viewport without a shared diagonal edge.
    let positions = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
    return vec4f(positions[vertexIndex], 0, 1);
}
