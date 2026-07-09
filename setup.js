import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SAOPass } from 'three/addons/postprocessing/SAOPass.js';

export const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87CEEB); 

export const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, 10, 20);
scene.add(camera);

export const audioListener = new THREE.AudioListener();
camera.add(audioListener);

export const uiScene = new THREE.Scene();
export const uiCamera = new THREE.OrthographicCamera(0, window.innerWidth, 0, window.innerHeight, -10, 10);

export const renderer = new THREE.WebGLRenderer({ antialias: true, precision: "highp", alpha: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

window.addEventListener('resize', () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    uiCamera.right = w;
    uiCamera.bottom = h;
    uiCamera.updateProjectionMatrix();
    renderer.setSize(w, h);
    composer.setSize(w, h);
    if (normalDepthTarget) normalDepthTarget.setSize(w, h);
    if (maskTarget) maskTarget.setSize(w, h);
});

export const tabContainer = document.createElement('div');
tabContainer.id = 'workspace-tabs';
tabContainer.style.cssText = 'position: absolute; top: 70px; left: 0; width: 100%; height: 30px; background: #222; border-bottom: 1px solid #444; display: flex; align-items: flex-end; z-index: 100; overflow-x: auto;';
document.body.appendChild(tabContainer);

export const imageEditorWorkspace = document.createElement('div');
imageEditorWorkspace.id = 'image-editor-workspace';
imageEditorWorkspace.style.cssText = 'position: absolute; top: 100px; left: 0; width: 100%; height: calc(100% - 100px); background: #1a1a1a; display: none; z-index: 90; flex-direction: column; align-items: stretch;';
document.body.appendChild(imageEditorWorkspace);

export const soundEditorWorkspace = document.createElement('div');
soundEditorWorkspace.id = 'sound-editor-workspace';
soundEditorWorkspace.style.cssText = 'position: absolute; top: 100px; left: 0; width: 100%; height: calc(100% - 100px); background: #1a1a1a; display: none; z-index: 90; flex-direction: column; align-items: stretch;';
document.body.appendChild(soundEditorWorkspace);

tabContainer.addEventListener('mousedown', e => e.stopPropagation());
imageEditorWorkspace.addEventListener('mousedown', e => e.stopPropagation());
soundEditorWorkspace.addEventListener('mousedown', e => e.stopPropagation());
soundEditorWorkspace.addEventListener('wheel', e => e.stopPropagation());
imageEditorWorkspace.addEventListener('wheel', e => e.stopPropagation());

export const gameUIContainer = document.createElement('div');
gameUIContainer.id = 'game-ui-container';
gameUIContainer.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 10; overflow: hidden;';
document.body.appendChild(gameUIContainer);

export const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));

export const saoPass = new SAOPass(scene, camera);
saoPass.enabled = false;
saoPass.params.saoBias = 0.05;
saoPass.params.saoIntensity = 0.001;
saoPass.params.saoKernelRadius = 10;
saoPass.params.saoBlurDepthCutoff = 0.001; 
composer.addPass(saoPass);

export const normalDepthTarget = new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, { format: THREE.RGBAFormat, type: THREE.FloatType });
export const maskTarget = new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, { format: THREE.RGBAFormat });

const normalDepthMaterial = new THREE.ShaderMaterial({
    vertexShader: `
        varying vec3 vNormal;
        varying float vViewZ;
        void main() {
            vec3 n = (length(normal) < 0.1) ? vec3(0.0, 0.0, 1.0) : normal;
            vNormal = normalize(normalMatrix * n);
            vec4 vp = modelViewMatrix * vec4(position, 1.0);
            vViewZ = vp.z;
            gl_Position = projectionMatrix * vp;
            gl_PointSize = 4.0;
        }
    `,
    fragmentShader: `
        varying vec3 vNormal;
        varying float vViewZ;
        void main() { gl_FragColor = vec4(vNormal * 0.5 + 0.5, vViewZ); }
    `,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1
});

const maskMaterial = new THREE.ShaderMaterial({
    uniforms: { reflectiveness: { value: 0 } },
    vertexShader: `void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_PointSize = 4.0; }`,
    fragmentShader: `uniform float reflectiveness; void main() { gl_FragColor = vec4(vec3(reflectiveness), 1.0); }`,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1
});

const ssrShader = {
    uniforms: {
        tDiffuse: { value: null },
        tNormalDepth: { value: null },
        tMask: { value: null },
        resolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
        cameraProjectionMatrix: { value: new THREE.Matrix4() },
        cameraInverseProjectionMatrix: { value: new THREE.Matrix4() },
        maxDistance: { value: 100.0 },
        thickness: { value: 0.8 },
        bias: { value: 0.02 },
        tCube: { value: null },
        viewMatrixInverse: { value: new THREE.Matrix4() }
    },
    vertexShader: `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform sampler2D tNormalDepth;
        uniform sampler2D tMask;
        uniform vec2 resolution;
        uniform mat4 cameraProjectionMatrix;
        uniform mat4 cameraInverseProjectionMatrix;
        uniform float maxDistance;
        uniform float thickness;
        uniform float bias;
        uniform samplerCube tCube;
        uniform mat4 viewMatrixInverse;
        varying vec2 vUv;

        float hash(vec2 p) {
            return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
        }

        void main() {
            vec4 baseColor = texture2D(tDiffuse, vUv);
            float reflectiveness = texture2D(tMask, vUv).r;
            vec4 nd = texture2D(tNormalDepth, vUv);
            
            if (reflectiveness <= 0.0 || nd.a >= 0.0) { gl_FragColor = baseColor; return; }

            vec3 viewNormal = normalize(nd.rgb * 2.0 - 1.0);
            float viewZ = nd.a;
            
            vec4 clipPos = vec4(vUv * 2.0 - 1.0, -1.0, 1.0);
            vec4 viewRay = cameraInverseProjectionMatrix * clipPos;
            vec3 viewPos = (viewRay.xyz / viewRay.w) * (viewZ / (viewRay.z / viewRay.w));
            vec3 viewDir = normalize(viewPos);
            
            vec3 reflectDir = reflect(viewDir, viewNormal);
            
            vec3 worldReflectDir = (viewMatrixInverse * vec4(reflectDir, 0.0)).xyz;
            vec3 skyColor = textureCube(tCube, worldReflectDir).rgb;

            vec3 hitColor = vec3(0.0);
            bool hit = false;
            float occlusionFactor = 1.0;
            float steps = 160.0;
            float stepSize = maxDistance / steps;
            
            float jitter = hash(vUv);
            vec3 currentPos = viewPos + (viewNormal * 0.01) + (reflectDir * (bias + stepSize * jitter));

            for(int i = 0; i < 120; i++) {
                currentPos += reflectDir * stepSize;
                
                vec4 proj = cameraProjectionMatrix * vec4(currentPos, 1.0);
                vec2 uv = (proj.xy / proj.w) * 0.5 + 0.5;
                
                if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;
                
                if (distance(uv, vUv) < 0.005) continue;

                float sampledViewZ = texture2D(tNormalDepth, uv).a;
                
                if (sampledViewZ < 0.0 && currentPos.z < sampledViewZ) {
                    if (currentPos.z > sampledViewZ + 0.05) continue; 

                    if (currentPos.z < sampledViewZ - thickness) {
                        occlusionFactor = 0.0;
                        break; 
                    }

                    vec3 lastPos = currentPos - reflectDir * stepSize;
                    for(int j = 0; j < 8; j++) {
                        vec3 midPos = mix(lastPos, currentPos, 0.5);
                        vec4 midProj = cameraProjectionMatrix * vec4(midPos, 1.0);
                        vec2 midUv = (midProj.xy / midProj.w) * 0.5 + 0.5;
                        float midViewZ = texture2D(tNormalDepth, midUv).a;
                        if (midPos.z < midViewZ) currentPos = midPos;
                        else lastPos = midPos;
                    }
                    
                    vec4 finalProj = cameraProjectionMatrix * vec4(currentPos, 1.0);
                    vec2 finalUv = (finalProj.xy / finalProj.w) * 0.5 + 0.5;
                    
                    float edgeFade = smoothstep(1.0, 0.95, max(abs(finalUv.x - 0.5), abs(finalUv.y - 0.5)) * 2.0);
                    hitColor = texture2D(tDiffuse, finalUv).rgb * edgeFade;
                    hit = true; break;
                }
            }

            vec3 reflectionResult = hit ? hitColor : skyColor;
            float finalReflectiveness = reflectiveness * occlusionFactor;
            gl_FragColor = vec4(mix(baseColor.rgb, reflectionResult, finalReflectiveness), baseColor.a);
        }
    `
};

const godRaysShader = {
    uniforms: {
        tDiffuse: { value: null },
        sunPosition: { value: new THREE.Vector2(0.5, 0.5) },
        weight: { value: 0.01 },
        decay: { value: 0.95 },
        density: { value: 1.0 },
        exposure: { value: 0.2 },
        sunColor: { value: new THREE.Color(0xffffff) }
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
        uniform vec2 sunPosition;
        uniform float weight;
        uniform float decay;
        uniform float density;
        uniform float exposure;
        uniform vec3 sunColor;
        varying vec2 vUv;
        const int SAMPLES = 64;

        float getLuminance(vec3 color) {
            return dot(color, vec3(0.2126, 0.7152, 0.0722));
        }

        void main() {
            vec4 baseColor = texture2D(tDiffuse, vUv);
            vec2 texCoord = vUv;
            vec2 delta = (texCoord - sunPosition) * (1.0 / float(SAMPLES) * density);
            
            vec3 rays = vec3(0.0);
            float illuminationDecay = 1.0;

            float edgeFade = smoothstep(0.0, 0.2, sunPosition.x) * smoothstep(1.0, 0.8, sunPosition.x) *
                             smoothstep(0.0, 0.2, sunPosition.y) * smoothstep(1.0, 0.8, sunPosition.y);

            for(int i = 0; i < SAMPLES; i++) {
                texCoord -= delta;
                vec3 col = texture2D(tDiffuse, clamp(texCoord, 0.0, 1.0)).rgb;
                
                float l = getLuminance(col);
                float threshold = 0.75;
                float weightFactor = smoothstep(threshold, 1.0, l);
                
                rays += col * weightFactor * illuminationDecay * weight;
                illuminationDecay *= decay;
            }

            gl_FragColor = vec4(baseColor.rgb + (rays * exposure * edgeFade * sunColor), baseColor.a);
        }
    `
};

export const ssrPass = new ShaderPass(ssrShader);
composer.addPass(ssrPass);

export const godRaysPass = new ShaderPass(godRaysShader);
godRaysPass.enabled = false;
godRaysPass.uniforms.weight.value = 0.1;
composer.addPass(godRaysPass);

function isEditorObject(obj) {
    let curr = obj;
    while (curr) {
        if (curr.userData && curr.userData.isEditor) {
            if (state.selectableObjects.includes(curr)) return false;
            return true;
        }
        if (curr.isTransformControls) return true;
        curr = curr.parent;
    }
    return false;
}

const invProj = new THREE.Matrix4();
export function renderSSRPrepass() {
    const prev = renderer.getRenderTarget();
    const hiddenObjects = [];
    scene.traverse(obj => {
        if (isEditorObject(obj) && obj.visible) {
            hiddenObjects.push(obj);
            obj.visible = false;
        }
        const isTransparent = obj.material && obj.material.transparent;
        if (obj.isMesh && isTransparent && obj.visible && !obj.userData.isSurfaceOverlay) {
            hiddenObjects.push(obj);
            obj.visible = false;
        }
    });

    renderer.setRenderTarget(normalDepthTarget);
    renderer.clear();
    scene.overrideMaterial = normalDepthMaterial;
    renderer.render(scene, camera);
    scene.overrideMaterial = null;

    renderer.setRenderTarget(maskTarget);
    renderer.clear();
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    scene.traverse(obj => {
        if ((obj.isMesh || obj.isPoints) && obj.visible && !isEditorObject(obj)) {
            const r = obj.userData.reflectiveness ?? 0;
            const originalMat = obj.material;
            maskMaterial.uniforms.reflectiveness.value = r / 10.0;
            obj.material = maskMaterial;
            renderer.render(obj, camera);
            obj.material = originalMat;
        }
    });
    renderer.autoClear = autoClear;
    hiddenObjects.forEach(obj => obj.visible = true);
    renderer.setRenderTarget(prev);

    ssrPass.uniforms.tNormalDepth.value = normalDepthTarget.texture;
    ssrPass.uniforms.tMask.value = maskTarget.texture;
    ssrPass.uniforms.cameraProjectionMatrix.value.copy(camera.projectionMatrix);
    ssrPass.uniforms.cameraInverseProjectionMatrix.value.copy(invProj.copy(camera.projectionMatrix).invert());
    ssrPass.uniforms.resolution.value.set(window.innerWidth, window.innerHeight);
    
    ssrPass.uniforms.viewMatrixInverse.value.copy(camera.matrixWorld);
    ssrPass.uniforms.tCube.value = (scene.background instanceof THREE.CubeTexture) ? scene.background : null;
}

export const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0, 0, 0
);
composer.addPass(bloomPass);

bloomPass.strength = 2.4;
bloomPass.radius = 0.9;
bloomPass.threshold = 0.2;

export const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
scene.add(ambientLight);
export const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(50, 100, 50);
sun.castShadow = true;
sun.shadow.autoUpdate = true;
sun.shadow.camera.left = -50;
sun.shadow.camera.right = 50;
sun.shadow.camera.top = 50;
sun.shadow.camera.bottom = -50;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 500;

sun.shadow.radius = 1;
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.005;

sun.shadow.mapSize.width = 4096;
sun.shadow.mapSize.height = 4096;
scene.add(sun);
scene.add(sun.target);

export const moon = new THREE.DirectionalLight(0xccccff, 0.3);
moon.castShadow = true;
moon.shadow.camera.copy(sun.shadow.camera);
moon.shadow.mapSize.copy(sun.shadow.mapSize);
moon.shadow.bias = sun.shadow.bias;
moon.shadow.normalBias = sun.shadow.normalBias;
scene.add(moon);
scene.add(moon.target);

export const sunDisk = new THREE.Mesh(
    new THREE.SphereGeometry(15, 32, 32),
    new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false })
);
sunDisk.visible = false;
scene.add(sunDisk);

export const raycaster = new THREE.Raycaster();
export const mouse = new THREE.Vector2();
export const keys = {};

const logo = document.createElement('img');
logo.src = 'ByteBots Logo.png';
logo.style.cssText = 'height: 60px; width: auto; margin: 0 10px 0 5px; flex-shrink: 0; pointer-events: auto;';
const topBar = document.getElementById('top-bar');
if (topBar) {
    topBar.style.display = 'flex';
    topBar.style.alignItems = 'center';
    topBar.prepend(logo);
}

const style = document.createElement('style');
style.textContent = `
    #right-sidebar, #explorer-list-parent, #property-controls-parent, .sidebar {
        top: 100px !important;
        height: calc(100% - 100px) !important;
    }
    #explorer-menu, #right-click-menu {
        z-index: 10000 !important;
    }
`;
document.head.appendChild(style);

export const baseplate = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0x888888, transparent: false })
);
baseplate.scale.set(100, 1, 100);
baseplate.position.y = -0.5;
baseplate.receiveShadow = true;
baseplate.userData.partColor = '#888888';
baseplate.name = "Baseplate";
scene.add(baseplate);

export const state = {
    selectableObjects: [baseplate],
    uiObjects: [],
    selectedObjects: [], 
    selectedItems: new Set(),
    currentSelectedItem: null,
    currentMode: 'select',
    isDraggingObject: false,
    snapAmount: 1,
    rotationSnapAmount: 10,
    rotationSnapDegrees: 10,
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
    editorCameraTransform: { position: new THREE.Vector3(), rotation: new THREE.Euler() },
    gravityStrength: 60,
    gravityDirection: new THREE.Vector3(0, -1, 0),
    sunLightOffset: new THREE.Vector3(50, 100, 50),
    imageAssets: {},
    soundAssets: {},
    openTabs: [{ id: 'game-editor', name: 'Game Editor', persistent: true }],
    activeTabId: 'game-editor',
    activeEmitters: new Set(),
    allLights: [],
    lightVisibilityRange: 3000,
    lightShadowRange: 120,
    diffuseRange: 350,
    shadowUpdateIndex: 0,
    lastClickTime: 0,
    lastSkyboxKey: null,
    selectionContainerMode: 'container',
    maxShadowLights: 8,
    maxVisibleLights: 32
};
