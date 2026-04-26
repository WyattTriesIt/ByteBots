import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
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

export const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0, 0, 0 // Start at 0 strength
);
composer.addPass(bloomPass);

// Lighting
scene.add(new THREE.AmbientLight(0xffffff, 0.4));
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
