import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

export const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87CEEB); 

export const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, 10, 20);

export const renderer = new THREE.WebGLRenderer({ antialias: true, precision: "highp" });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

// GUI Layer
export const gameUIContainer = document.createElement('div');
gameUIContainer.id = 'game-ui-container';
gameUIContainer.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 10; overflow: hidden;';
document.body.appendChild(gameUIContainer);

// Post-Processing Setup
export const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));

// Screen Space Reflection Shader
const ssrShader = {
    uniforms: {
        tDiffuse: { value: null },
        tNormalDepth: { value: null },
        tColor: { value: null },
        tDepth: { value: null },
        tReflectivenessMask: { value: null },
        cameraNear: { value: camera.near },
        cameraFar: { value: camera.far },
        resolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
        cameraProjectionMatrix: { value: camera.projectionMatrix },
        cameraViewMatrix: { value: camera.matrixWorldInverse },
        cameraInverseViewProjectionMatrix: { value: (() => { const m = new THREE.Matrix4(); m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse); return m.invert(); })() },
        cameraWorldPosition: { value: camera.position },
        maxDistance: { value: 1000.0 },
        maxSteps: { value: 256 },
        thickness: { value: 0.1 },
        stride: { value: 0.5 }
    },
    vertexShader: `
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `,
    fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform sampler2D tNormalDepth;
        uniform sampler2D tColor;
        uniform sampler2D tDepth;
        uniform sampler2D tReflectivenessMask;
        uniform float cameraNear;
        uniform float cameraFar;
        uniform vec2 resolution;
        uniform mat4 cameraProjectionMatrix;
        uniform mat4 cameraViewMatrix;
        uniform mat4 cameraInverseViewProjectionMatrix;
        uniform vec3 cameraWorldPosition;
        uniform float maxDistance;
        uniform float maxSteps;
        uniform float thickness;
        uniform float stride;

        varying vec2 vUv;

        // Convert depth to linear depth
        float linearDepth(float depth) {
            float z = depth * 2.0 - 1.0;
            return (2.0 * cameraNear * cameraFar) / (cameraFar + cameraNear - z * (cameraFar - cameraNear));
        }

        // Convert screen position to world position
        vec3 screenToWorld(vec2 screenPos, float depth) {
            vec4 clipPos = vec4(screenPos * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
            vec4 worldPos = cameraInverseViewProjectionMatrix * clipPos;
            worldPos /= worldPos.w;
            return worldPos.xyz;
        }

        // Convert world position to screen position
        vec2 worldToScreen(vec3 worldPos) {
            vec4 clipPos = cameraProjectionMatrix * cameraViewMatrix * vec4(worldPos, 1.0);
            return (clipPos.xy / clipPos.w) * 0.5 + 0.5;
        }

        void main() {
            vec4 diffuseColor = texture2D(tDiffuse, vUv);
            vec4 normalDepth = texture2D(tNormalDepth, vUv);
        float reflectiveness = clamp(texture2D(tReflectivenessMask, vUv).r, 0.0, 1.0);
            vec3 normal = -normalize(normalDepth.xyz * 2.0 - 1.0);
            float depth = normalDepth.w;
            
            // Skip if not reflective or no valid depth
            if (depth >= 1.0 || reflectiveness <= 0.0) {
                gl_FragColor = diffuseColor;
                return;
            }
            
            // Get current world position
            vec3 worldPos = screenToWorld(vUv, depth);
            
            // Calculate view direction
            vec3 viewDir = normalize(worldPos - cameraWorldPosition);
            
            // Calculate reflection vector
            vec3 reflectDir = reflect(viewDir, normal);
            
            // March along reflection ray
            vec3 currentPos = worldPos;
            vec2 currentScreenPos = vUv;
            
            vec3 reflectionColor = vec3(0.0);
            bool hit = false;
            
            for (float i = 1.0; i <= maxSteps; i += stride) {
                // Step along reflection ray
                currentPos += reflectDir * (maxDistance / maxSteps);
                
                // Convert back to screen space
                currentScreenPos = worldToScreen(currentPos);
                
                // Check bounds
                if (currentScreenPos.x < 0.0 || currentScreenPos.x > 1.0 || 
                    currentScreenPos.y < 0.0 || currentScreenPos.y > 1.0) {
                    break;
                }
                
                // Sample depth at this position
                float sampleDepth = texture2D(tDepth, currentScreenPos).r;
                float sampleLinearDepth = linearDepth(sampleDepth);
                float currentLinearDepth = length(currentPos - cameraWorldPosition);

                // Check if we hit a surface
                if (sampleDepth < 1.0 && sampleLinearDepth < currentLinearDepth - thickness) {
                    reflectionColor = texture2D(tColor, currentScreenPos).rgb;
                    hit = true;
                    break;
                }
            }
            
            // Blend reflection with original color
            if (hit) {
                gl_FragColor = vec4(mix(diffuseColor.rgb, reflectionColor, reflectiveness), diffuseColor.a);
            } else {
                gl_FragColor = diffuseColor;
            }
        }
    `
};

export const ssrPass = new ShaderPass(ssrShader);

export const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0, 0, 0 // Start at 0 strength
);
composer.addPass(ssrPass);
composer.addPass(bloomPass);

// Screen Space Reflection Setup (cheap SSR)
// Used only for capturing a depth buffer for SSR ray intersection.
export const reflectionRenderTarget = new THREE.WebGLRenderTarget(
    window.innerWidth, window.innerHeight, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        depthBuffer: true,
        stencilBuffer: false
    }
);

// Raw scene color for SSR sampling.
// Important: this MUST NOT include the SSR/composer result, otherwise you get "reflection of reflection" feedback.
export const ssrColorRenderTarget = new THREE.WebGLRenderTarget(
    window.innerWidth,
    window.innerHeight,
    {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        depthBuffer: false,
        stencilBuffer: false
    }
);

ssrColorRenderTarget.texture.generateMipmaps = false;


reflectionRenderTarget.texture.generateMipmaps = false;

if (!reflectionRenderTarget.depthTexture) {
    reflectionRenderTarget.depthTexture = new THREE.DepthTexture(window.innerWidth, window.innerHeight);
    reflectionRenderTarget.depthTexture.type = THREE.UnsignedShortType;
}

// Normal-Depth Render Target for SSR
export const normalDepthRenderTarget = new THREE.WebGLRenderTarget(
    window.innerWidth, window.innerHeight, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.FloatType,
        depthBuffer: true,
        stencilBuffer: false
    }
);

normalDepthRenderTarget.texture.generateMipmaps = false;

// Reflectiveness Mask Render Target
export const reflectivenessMaskRenderTarget = new THREE.WebGLRenderTarget(
    window.innerWidth, window.innerHeight, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType
    }
);

reflectivenessMaskRenderTarget.texture.generateMipmaps = false;

// We keep reflectionMaterial for legacy imports, but it is no longer used for the SSR shader.
export const reflectionMaterial = new THREE.MeshBasicMaterial({ visible: false });

// Normal-Depth Material for SSR
export const normalDepthMaterial = new THREE.ShaderMaterial({
    vertexShader: `
        varying vec3 vNormal;
        varying vec4 vPosition;
        
        void main() {
            vNormal = normalize(mat3(modelMatrix) * normal);
            vPosition = modelViewMatrix * vec4(position, 1.0);
            gl_Position = projectionMatrix * vPosition;
        }
    `,
    fragmentShader: `
        varying vec3 vNormal;
        varying vec4 vPosition;
        
        void main() {
            // Pack world-space normal into RGB (0-1 range)
            vec3 packedNormal = normalize(vNormal) * 0.5 + 0.5;
            
            // Use the actual depth buffer value so screen-space reconstruction is accurate
            float depth = gl_FragCoord.z;
            
            gl_FragColor = vec4(packedNormal, depth);
        }
    `,
    uniforms: {},
    side: THREE.DoubleSide
});

// Reflectiveness Mask Material
export const reflectivenessMaskMaterial = new THREE.ShaderMaterial({
    vertexShader: `
        void main() {
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `,
    fragmentShader: `
        uniform float reflectiveness;
        
        void main() {
            gl_FragColor = vec4(vec3(reflectiveness), 1.0);
        }
    `,
    uniforms: {
        reflectiveness: { value: 0.0 }
    },
    side: THREE.DoubleSide
});

// Lighting
export const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
scene.add(ambientLight);
export const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(50, 100, 50);
sun.castShadow = true;
sun.shadow.camera.left = -100;
sun.shadow.camera.right = 100;
sun.shadow.camera.top = 100;
sun.shadow.camera.bottom = -100;
sun.shadow.mapSize.width = 5000; // Optimized from 5000
sun.shadow.mapSize.height = 5000;
scene.add(sun);

export const raycaster = new THREE.Raycaster();
export const mouse = new THREE.Vector2();
export const keys = {};

export const baseplate = new THREE.Mesh(
    new THREE.BoxGeometry(100, 1, 100),
    new THREE.MeshStandardMaterial({ color: 0x888888 })
);
baseplate.position.y = -0.5;
baseplate.receiveShadow = true;
baseplate.name = "Baseplate";
scene.add(baseplate);

// Shared variables that change often
export const state = {
    selectableObjects: [baseplate],
    selectedObjects: [],
    currentSelectedItem: null, // Can be a folder or model from the explorer hierarchy
    currentMode: 'select',
    isDraggingObject: false,
    snapAmount: 1,
    activeHandle: null,
    initialDragPoint: new THREE.Vector3(),
    initialScale: new THREE.Vector3(),
    initialPosition: new THREE.Vector3(),
    initialSize: new THREE.Vector3(),
    yaw: 0,
    pitch: 0,
    isPlayTesting: false,
    playerGroup: null,
    isGrounded: false,
    cameraZoom: 10,
    isFirstPerson: false,
    editorCameraTransform: { position: new THREE.Vector3(), rotation: new THREE.Euler() }
};