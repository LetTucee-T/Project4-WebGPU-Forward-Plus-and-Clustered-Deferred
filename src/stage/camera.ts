import { Mat4, mat4, Vec3, vec3 } from "wgpu-matrix";
import { toRadians } from "../math_util";
import { device, canvas, fovYDegrees } from "../renderer";

export interface CameraPose {
    position: [number, number, number];
    yaw: number;
    pitch: number;
}

export const cameraPresets: Record<string, CameraPose> = {
    Atrium: { position: [-7, 2, 0], yaw: 0, pitch: 0 },
    Wall: { position: [-3, 2, 2], yaw: 90, pitch: 0 },
    Sky: { position: [-5, 8, 0], yaw: 0, pitch: 35 }
};

class CameraUniforms {
    // Three matrices, vec2f + two f32 values, then inverse view at byte 208.
    // Keep these offsets in sync with CameraUniforms in common.wgsl.
    readonly buffer = new ArrayBuffer(272);
    private readonly floatView = new Float32Array(this.buffer);

    set viewProjMat(mat: Float32Array) {
        this.floatView.set(mat, 0);
    }

    set viewMat(mat: Float32Array) {
        this.floatView.set(mat, 16);
    }

    set invProjMat(mat: Float32Array) {
        this.floatView.set(mat, 32);
    }

    set invViewMat(mat: Float32Array) {
        this.floatView.set(mat, 52);
    }

    setProjectionInfo(width: number, height: number, near: number, far: number) {
        this.floatView.set([width, height, near, far], 48);
    }
}

export class Camera {
    uniforms: CameraUniforms = new CameraUniforms();
    uniformsBuffer: GPUBuffer;

    projMat: Mat4 = mat4.create();
    cameraPos: Vec3 = vec3.create(-7, 2, 0);
    cameraFront: Vec3 = vec3.create(0, 0, -1);
    cameraUp: Vec3 = vec3.create(0, 1, 0);
    cameraRight: Vec3 = vec3.create(1, 0, 0);
    yaw: number = 0;
    pitch: number = 0;
    moveSpeed: number = 0.004;
    sensitivity: number = 0.15;
    inputEnabled = true;

    static readonly nearPlane = 0.1;
    static readonly farPlane = 1000;

    keys: { [key: string]: boolean } = {};

    constructor () {
        this.uniformsBuffer = device.createBuffer({
            label: "camera uniforms",
            size: this.uniforms.buffer.byteLength,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });

        this.setViewport(canvas.width, canvas.height);

        this.rotateCamera(0, 0); // set initial camera vectors

        window.addEventListener('keydown', (event) => this.onKeyEvent(event, true));
        window.addEventListener('keyup', (event) => this.onKeyEvent(event, false));
        window.onblur = () => this.keys = {}; // reset keys on page exit so they don't get stuck (e.g. on alt + tab)

        canvas.addEventListener('mousedown', () => { if (this.inputEnabled) void canvas.requestPointerLock(); });
        canvas.addEventListener('mouseup', () => document.exitPointerLock());
        canvas.addEventListener('mousemove', (event) => this.onMouseMove(event));
    }

    private onKeyEvent(event: KeyboardEvent, down: boolean) {
        if (!down) {
            this.keys[event.key.toLowerCase()] = false;
            return;
        }
        if (!this.inputEnabled || (event.target instanceof HTMLElement && ['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target.tagName))) return;
        this.keys[event.key.toLowerCase()] = down;
        if (this.keys['alt']) { // prevent issues from alt shortcuts
            event.preventDefault();
        }
    }

    private rotateCamera(dx: number, dy: number) {
        this.yaw += dx;
        this.pitch -= dy;

        if (this.pitch > 89) {
            this.pitch = 89;
        }
        if (this.pitch < -89) {
            this.pitch = -89;
        }

        const front = mat4.create();
        front[0] = Math.cos(toRadians(this.yaw)) * Math.cos(toRadians(this.pitch));
        front[1] = Math.sin(toRadians(this.pitch));
        front[2] = Math.sin(toRadians(this.yaw)) * Math.cos(toRadians(this.pitch));

        this.cameraFront = vec3.normalize(front);
        this.cameraRight = vec3.normalize(vec3.cross(this.cameraFront, [0, 1, 0]));
        this.cameraUp = vec3.normalize(vec3.cross(this.cameraRight, this.cameraFront));
    }

    private onMouseMove(event: MouseEvent) {
        if (this.inputEnabled && document.pointerLockElement === canvas) {
            this.rotateCamera(event.movementX * this.sensitivity, event.movementY * this.sensitivity);
        }
    }

    private processInput(deltaTime: number) {
        let moveDir = vec3.create(0, 0, 0);
        if (this.keys['w']) {
            moveDir = vec3.add(moveDir, this.cameraFront);
        }
        if (this.keys['s']) {
            moveDir = vec3.sub(moveDir, this.cameraFront);
        }
        if (this.keys['a']) {
            moveDir = vec3.sub(moveDir, this.cameraRight);
        }
        if (this.keys['d']) {
            moveDir = vec3.add(moveDir, this.cameraRight);
        }
        if (this.keys['q']) {
            moveDir = vec3.sub(moveDir, this.cameraUp);
        }
        if (this.keys['e']) {
            moveDir = vec3.add(moveDir, this.cameraUp);
        }

        let moveSpeed = this.moveSpeed * deltaTime;
        const moveSpeedMultiplier = 3;
        if (this.keys['shift']) {
            moveSpeed *= moveSpeedMultiplier;
        }
        if (this.keys['alt']) {
            moveSpeed /= moveSpeedMultiplier;
        }

        if (vec3.length(moveDir) > 0) {
            const moveAmount = vec3.scale(vec3.normalize(moveDir), moveSpeed);
            this.cameraPos = vec3.add(this.cameraPos, moveAmount);
        }
    }

    onFrame(deltaTime: number) {
        if (this.inputEnabled) this.processInput(deltaTime);

        const lookPos = vec3.add(this.cameraPos, vec3.scale(this.cameraFront, 1));
        const viewMat = mat4.lookAt(this.cameraPos, lookPos, [0, 1, 0]);
        const viewProjMat = mat4.mul(this.projMat, viewMat);
        this.uniforms.viewProjMat = viewProjMat;
        this.uniforms.viewMat = viewMat;
        this.uniforms.invViewMat = mat4.inverse(viewMat);

        device.queue.writeBuffer(this.uniformsBuffer, 0, this.uniforms.buffer);
    }

    setViewport(width: number, height: number) {
        this.projMat = mat4.perspective(toRadians(fovYDegrees), width / height, Camera.nearPlane, Camera.farPlane);
        this.uniforms.invProjMat = mat4.inverse(this.projMat);
        this.uniforms.setProjectionInfo(width, height, Camera.nearPlane, Camera.farPlane);
    }

    getPose(): CameraPose {
        return { position: [this.cameraPos[0], this.cameraPos[1], this.cameraPos[2]], yaw: this.yaw, pitch: this.pitch };
    }

    setPose(pose: CameraPose) {
        this.keys = {};
        this.cameraPos = vec3.create(...pose.position);
        this.yaw = pose.yaw;
        this.pitch = pose.pitch;
        this.rotateCamera(0, 0);
    }
}
