@vertex
fn main(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4f {
    // A separate fullscreen quad, as required by the depth-culling extra credit.
    let positions = array<vec2f, 6>(
        vec2f(-1, -1), vec2f(1, -1), vec2f(-1, 1),
        vec2f(-1, 1), vec2f(1, -1), vec2f(1, 1));
    return vec4f(positions[vertexIndex], 0, 1);
}
