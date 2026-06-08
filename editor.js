import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { scene, camera, renderer, baseplate, state, raycaster, composer, bloomPass, godRaysPass, saoPass, sun, moon, ambientLight, gameUIContainer, tabContainer, imageEditorWorkspace, soundEditorWorkspace, audioListener, sunDisk } from './setup.js';

export const transformControls = new TransformControls(camera, renderer.domElement);

const FACE_MAP = { 'Right': 0, 'Left': 1, 'Top': 2, 'Bottom': 3, 'Front': 4, 'Back': 5 };

/**
 * Slices a Cross-Layout Cubemap (4x3 grid) into 6 individual textures.
 */
function sliceCubemap(dataUrl, callback) {
    const img = new Image();
    img.onload = () => {
        const tileW = img.width / 4;
        const tileH = img.height / 3;
        const canvas = document.createElement('canvas');
        canvas.width = tileW; canvas.height = tileH;
        const ctx = canvas.getContext('2d');

        // Three.js CubeTexture order: px, nx, py, ny, pz, nz
        const coords = [
            { x: 2, y: 1 }, { x: 0, y: 1 }, { x: 1, y: 0 },
            { x: 1, y: 2 }, { x: 1, y: 1 }, { x: 3, y: 1 }
        ];

        const sides = coords.map(c => {
            ctx.clearRect(0, 0, tileW, tileH);
            ctx.drawImage(img, c.x * tileW, c.y * tileH, tileW, tileH, 0, 0, tileW, tileH);
            return canvas.toDataURL();
        });
        callback(sides);
    };
    img.src = dataUrl;
}

const FACE_CONFIG = {
    'Front':  { pos: [0, 0, 0.5],   rot: [0, 0, 0],   normal: [0, 0, 1] },
    'Back':   { pos: [0, 0, -0.5],  rot: [0, Math.PI, 0], normal: [0, 0, -1] },
    'Top':    { pos: [0, 0.5, 0],   rot: [-Math.PI / 2, 0, 0], normal: [0, 1, 0] },
    'Bottom': { pos: [0, -0.5, 0],  rot: [Math.PI / 2, 0, 0], normal: [0, -1, 0] },
    'Right':  { pos: [0.5, 0, 0],   rot: [0, Math.PI / 2, 0], normal: [1, 0, 0] },
    'Left':   { pos: [-0.5, 0, 0],  rot: [0, -Math.PI / 2, 0], normal: [-1, 0, 0] }
};

const textureCache = new Map();
/**
 * Returns a cached Three.js texture for a given image URL.
 * Provides clones to allow unique tiling (repeat) settings per instance.
 */
function getTextureFromCache(url) {
    if (!textureCache.has(url)) {
        const tex = new THREE.TextureLoader().load(url);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.anisotropy = renderer.capabilities?.getMaxAnisotropy?.() || 1;
        textureCache.set(url, tex);
    }
    const cached = textureCache.get(url);
    const clone = cached.clone();
    return clone;
}

const surfaceTypes = ['texture', 'textlabel', 'frame', 'text', 'image'];

const getSurfaceDescendants = (item) => {
    let results = [];
    if (!item.children) return results;
    for (const child of item.children) {
        if (surfaceTypes.includes(child.type)) results.push(child);
        else if (!child.objectRef) results.push(...getSurfaceDescendants(child));
    }
    return results;
};

transformControls.userData.isEditor = true;
scene.add(transformControls); 

const surfaceCanvases = new Map();
const surfaceTextures = new Map();

export const selectionGroup = new THREE.Group(); 
scene.add(selectionGroup);

export const selectionBox = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), 
    new THREE.LineBasicMaterial({ color: 0x00ff88, depthTest: false, transparent: true, opacity: 0.8 })
);
selectionBox.visible = false;
selectionBox.renderOrder = 1000;
selectionBox.userData.isEditor = true;
selectionGroup.add(selectionBox); 

export const scaleHandles = new THREE.Group();
selectionGroup.add(scaleHandles); 

const pRaycaster = new THREE.Raycaster(); // Private raycaster to prevent breaking editor selection

const handleData = [
    { dir: new THREE.Vector3(1, 0, 0), color: 0xff0000 }, { dir: new THREE.Vector3(-1, 0, 0), color: 0xff0000 },
    { dir: new THREE.Vector3(0, 1, 0), color: 0x00ff00 }, { dir: new THREE.Vector3(0, -1, 0), color: 0x00ff00 },
    { dir: new THREE.Vector3(0, 0, 1), color: 0x0000ff }, { dir: new THREE.Vector3(0, 0, -1), color: 0x0000ff }
];

handleData.forEach(data => {
    const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(0.35, 16, 16),
        new THREE.MeshBasicMaterial({ color: data.color, depthTest: false, transparent: true, opacity: 0.8 })
    );
    sphere.userData.isEditor = true;
    sphere.renderOrder = 1000;
    sphere.userData.direction = data.dir;
    sphere.name = "EditorScaleHandle"; // Add a name for identification
    scaleHandles.add(sphere);
});
scaleHandles.visible = false;

/**
 * Updates all active particle emitters.
 * Handles spawning, physics integration, and geometry synchronization.
 */
export function updateParticles(dt) {
    state.activeEmitters.forEach(item => {
        if (!item.objectRef || !item.properties.enabled) return;

        // Sync emitter position to parent object in world space
        // We look for the nearest physical parent (Part/Spawn) to emit from
        let parentObj = null;
        let currentId = item.id;
        while (currentId) {
            const pItem = findParentItem(currentId);
            if (!pItem) break;
            if (pItem.objectRef && (pItem.type === 'object' || pItem.type === 'spawn')) {
                parentObj = pItem.objectRef;
                break;
            }
            currentId = pItem.id;
        }

        // Emitter container stays at world origin so particles can move in world space
        item.objectRef.position.set(0, 0, 0);
        item.objectRef.quaternion.set(0, 0, 0, 1);

        const spawnWorldPos = new THREE.Vector3();
        const spawnWorldQuat = new THREE.Quaternion();
        if (parentObj) {
            parentObj.getWorldPosition(spawnWorldPos);
            parentObj.getWorldQuaternion(spawnWorldQuat);
        }

        const p = item.properties;
        const data = item.particleData || [];
        
        const baseDir = new THREE.Vector3(p.directionX ?? 0, p.directionY ?? 1, p.directionZ ?? 0);
        const gravX = (p.gravityX ?? 0) * dt;
        const gravY = (p.gravityY ?? 0) * dt;
        const gravZ = (p.gravityZ ?? 0) * dt;
        const colorBase = new THREE.Color(p.color || '#ffffff');

        const rate = (p.enabled !== false) ? (p.rate || 0) : 0;
        item._spawnTimer = (item._spawnTimer || 0) + dt;
        const spawnCount = Math.min(50, Math.floor(item._spawnTimer * rate)); 
        item._spawnTimer -= spawnCount / rate;

        for (let i = 0; i < spawnCount; i++) {
            // Population cap removed to allow creator-controlled limits

            const life = (p.lifeMin ?? 1) + Math.random() * ((p.lifeMax ?? 3) - (p.lifeMin ?? 1));
            const speed = (p.speedMin ?? 2) + Math.random() * ((p.speedMax ?? 5) - (p.speedMin ?? 2));
            const size = (p.sizeMin ?? 0.5) + Math.random() * ((p.sizeMax ?? 1) - (p.sizeMin ?? 0.5));
            
            const offset = new THREE.Vector3();
            if (p.shape === 'Sphere') {
                const r = Math.random();
                const theta = Math.random() * Math.PI * 2;
                const phi = Math.acos(2 * Math.random() - 1);
                offset.set(r * Math.sin(phi) * Math.cos(theta), r * Math.sin(phi) * Math.sin(theta), r * Math.cos(phi));
            } else if (p.shape === 'Disc') {
                const r = Math.sqrt(Math.random());
                const theta = Math.random() * Math.PI * 2;
                offset.set(r * Math.cos(theta), 0, r * Math.sin(theta));
            } else if (p.shape === 'Cylinder') {
                const r = Math.sqrt(Math.random());
                const theta = Math.random() * Math.PI * 2;
                offset.set(r * Math.cos(theta), Math.random() * 2 - 1, r * Math.sin(theta));
            }

            let velocityDir;
            if (p.shape === 'Sphere') {
                // Radial velocity: go outwards from center to offset position
                velocityDir = offset.clone().normalize();
                // Fallback if offset is zero
                if (velocityDir.lengthSq() < 0.001) velocityDir.copy(baseDir);
            } else {
                const spread = p.spread || 0;
                velocityDir = baseDir.clone();
                velocityDir.x += (Math.random() - 0.5) * spread * 2;
                velocityDir.y += (Math.random() - 0.5) * spread * 2;
                velocityDir.z += (Math.random() - 0.5) * spread * 2;
            }
            
            const worldVel = velocityDir.normalize().applyQuaternion(spawnWorldQuat).multiplyScalar(speed);
            
            const worldStartPos = offset.applyQuaternion(spawnWorldQuat).add(spawnWorldPos);
            data.push({ pos: worldStartPos, vel: worldVel, life: life, maxLife: life, size: size });
        }

        const positions = [];
        const colors = [];
        for (let i = data.length - 1; i >= 0; i--) {
            const pt = data[i];
            pt.life -= dt;
            if (pt.life <= 0) { data.splice(i, 1); continue; }

            pt.vel.x += gravX; pt.vel.y += gravY; pt.vel.z += gravZ;

            // Very subtle air resistance
            pt.vel.multiplyScalar(0.998);

            // Environment Collision
            if (p.environmentCollision) {
                const stepVel = pt.vel.clone().multiplyScalar(dt);
                const stepLen = stepVel.length();
                if (stepLen > 0.001) {
                    pRaycaster.set(pt.pos, stepVel.clone().normalize());
                    const radius = pt.size * 0.45; // Synced closer to image sprite bounds
                    pRaycaster.far = stepLen + radius;
                    const hits = pRaycaster.intersectObjects(state.selectableObjects, true);
                    if (hits.length > 0) {
                        const hit = hits[0];
                        const normal = hit.face.normal.clone();
                        
                        const vDotN = pt.vel.dot(normal);
                        const vNormal = normal.clone().multiplyScalar(vDotN);
                        const vTangent = pt.vel.clone().sub(vNormal);

                        // Rolling/Sliding: Use lower friction (0.98) to allow sliding down hills
                        const friction = 0.98; 
                        const restitution = 0.15; // Lower bounce for better stacking/piling

                        if (vDotN < 0) {
                            pt.vel.copy(vTangent.multiplyScalar(friction)).sub(vNormal.multiplyScalar(restitution));
                        }

                        pt.pos.copy(hit.point).add(normal.multiplyScalar(radius + 0.005));
                    } else {
                        pt.pos.add(stepVel);
                    }
                }
            } else {
                pt.pos.x += pt.vel.x * dt;
                pt.pos.y += pt.vel.y * dt;
                pt.pos.z += pt.vel.z * dt;
            }

            // Particle-to-Particle Collision (Piling and Rolling logic)
            // Cap increased to 2500 to allow for larger ball pits/stacking effects
            if (p.particleCollision && data.length < 2500) { 
                for (let j = i - 1; j >= 0; j--) {
                    const other = data[j];
                    const dx = pt.pos.x - other.pos.x;
                    const dy = pt.pos.y - other.pos.y;
                    const dz = pt.pos.z - other.pos.z;
                    const distSq = dx*dx + dy*dy + dz*dz;
                    const minDist = (pt.size + other.size) * 0.45; // Synced with visual radius

                    if (distSq < minDist * minDist) {
                        const dist = Math.sqrt(distSq) || 0.001;
                        const nx = dx / dist; const ny = dy / dist; const nz = dz / dist;
                        const normal = new THREE.Vector3(nx, ny, nz);
                        const overlap = (minDist - dist) * 0.7; // Firmer push for stacking
                        
                        pt.pos.x += nx * overlap; pt.pos.y += ny * overlap; pt.pos.z += nz * overlap;
                        other.pos.x -= nx * overlap; other.pos.y -= ny * overlap; other.pos.z -= nz * overlap;
                        
                        const relVel = pt.vel.clone().sub(other.vel);
                        const velAlongNormal = relVel.dot(normal);
                        
                        if (velAlongNormal < 0) {
                            const jImpulse = -(1 + 0.2) * velAlongNormal;
                            const impulse = normal.clone().multiplyScalar(jImpulse * 0.5);
                            pt.vel.add(impulse);
                            other.vel.sub(impulse);
                        }
                        
                        // Friction between particles to help them stack
                        pt.vel.multiplyScalar(0.99);
                        other.vel.multiplyScalar(0.99);
                    }
                }
            }

            positions.push(pt.pos.x, pt.pos.y, pt.pos.z);
            
            // Only fade to black (for transparency) if Additive. 
            // Normal blending should stay bright to avoid "weird" soot look.
            const lifeRatio = Math.min(1, pt.life / pt.maxLife);
            const colorFactor = (p.blending === 'Additive') ? lifeRatio : 1.0;
            colors.push(colorBase.r * colorFactor, colorBase.g * colorFactor, colorBase.b * colorFactor);
        }
        item.particleData = data;

        const geo = item.objectRef.geometry;
        if (positions.length > 0) {
            // Add dummy normals so that the SSR overrideMaterial (which expects a normal attribute) does not crash
            const normals = new Float32Array(positions.length);
            for(let i=0; i < normals.length; i+=3) normals[i+2] = 1.0;

            geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
            geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
            geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
            geo.attributes.position.needsUpdate = true;
            geo.attributes.color.needsUpdate = true;
            geo.attributes.normal.needsUpdate = true;

            geo.computeBoundingSphere(); // Required so the points aren't culled by the camera
        }

        const avgSize = ((p.sizeMin ?? 0.5) + (p.sizeMax ?? 1)) / 2;
        item.objectRef.material.size = avgSize;
    });
}

export function updateScaleHandles() {
    if (state.selectedObjects.length === 0 || state.currentMode !== 'scale') {
        scaleHandles.visible = false; return;
    }
    scaleHandles.visible = true;

    // Maintain consistent screen size regardless of camera distance
    const dist = camera.position.distanceTo(selectionGroup.position);
    const sizeFactor = dist * 0.05; 

    // Counter the selectionGroup's scale and apply distance factor
    const invScale = new THREE.Vector3(1 / selectionGroup.scale.x, 1 / selectionGroup.scale.y, 1 / selectionGroup.scale.z)
        .multiplyScalar(sizeFactor);

    scaleHandles.children.forEach(handle => {
        const dir = handle.userData.direction;
        handle.position.set(dir.x * state.initialSize.x / 2, dir.y * state.initialSize.y / 2, dir.z * state.initialSize.z / 2);
        handle.scale.copy(invScale);
    });
}

transformControls.addEventListener('change', () => {
    if (state.selectedObjects.length > 0) {
        if (state.currentMode === 'scale') {
            updateScaleHandles();
            const needsSurfaceRefresh = state.selectedObjects.some(obj => {
                const itemId = findItemIdForObject(obj);
                const item = explorerHierarchy.findItemById(itemId);
                return item && getSurfaceDescendants(item).length > 0;
            });
            if (needsSurfaceRefresh) refreshSceneState();
        }
        updatePropertyValues();
    }
});


// --- SYSTEM REFRESH LOGIC ---
/**
 * Updates the entire scene based on the explorer hierarchy.
 */
export function refreshSceneState(targetItem = null) {
    if (state.isPastingOrDuplicating) return;
    
    let skyFound = false;
    state.allLights = []; // Reset tracked lights for the manager

    if (!targetItem) {
        if (scene.fog) scene.fog = null;
        if (bloomPass) bloomPass.strength = 0;
        if (godRaysPass) godRaysPass.enabled = false;
        if (saoPass) saoPass.enabled = false;
    }
    if (sunDisk) sunDisk.visible = false;
    if (sun) sun.intensity = 1.2;
    gameUIContainer.innerHTML = ''; 

    const processItem = (item, inWorld = false, inLighting = false, inUI = false, inSoundsFolder = false) => {
        const isWorld = inWorld || item.id === 'world-folder';
        const isLighting = inLighting || item.id === 'folder-lighting';
        const isUI = inUI || item.id === 'folder-ui';
        const isSoundsFolder = inSoundsFolder || item.id === 'folder-sounds';

        // Apply Workspace (World) properties
        if (item.id === 'world-folder') {
            const p = item.properties || {};
            state.gravityStrength = p.gravityStrength ?? 60;
            const dir = state.gravityDirection.set(
                p.gravityX ?? 0,
                p.gravityY ?? -1,
                p.gravityZ ?? 0
            );
            if (dir.lengthSq() > 0) dir.normalize();
            else dir.set(0, -1, 0);
        }

        // Apply global folder properties
        if (item.id === 'folder-lighting') {
            const p = item.properties || {};
            const time = p.timeOfDay ?? 12; // 0-24 hours
            const lat = p.geographicLatitude ?? 45; // -90 to 90 degrees
            
            // Apply specific lighting colors if defined
            if (p.sunColor) sun.color.set(p.sunColor);
            if (p.ambientColor && ambientLight) ambientLight.color.set(p.ambientColor);

            // Calculate Sun Position based on Time and Latitude
            const angle = (time / 24) * Math.PI * 2 - Math.PI / 2;
            const orbit = 100;
            const latRad = lat * (Math.PI / 180);
            
            sun.position.set(
                Math.cos(angle) * orbit,
                Math.sin(angle) * Math.cos(latRad) * orbit,
                Math.sin(angle) * Math.sin(latRad) * orbit
            );
            
            // Calculate intensities based on horizon position
            const sunHeight = sun.position.y / orbit;
            // Fade sun to 0 as it touches horizon to prevent light-leaking under objects
            sun.intensity = Math.max(0, Math.min(1, sunHeight * 10)) * (p.brightness ?? 1.2);

            // Position moon exactly opposite the sun
            if (moon) {
                moon.position.copy(sun.position).multiplyScalar(-1);
                const moonHeight = moon.position.y / orbit;
                // Subtle moonlight with shadows at night
                moon.intensity = Math.max(0, Math.min(1, moonHeight * 10)) * 0.3;
            }

            if (sun.shadow) {
                sun.shadow.radius = 1;
            }
            state.sunLightOffset.copy(sun.position);
            if (ambientLight) ambientLight.intensity = p.ambient ?? 0.4;

            // Simple Dynamic Sky Color
            // Only apply if we haven't found a Sky object (to prevent overwriting the Cubemap)
            const hasSkyRecursive = (items) => {
                for (const i of items) {
                    if (i.type === 'sky') return true;
                    if (i.children && hasSkyRecursive(i.children)) return true;
                }
                return false;
            };
            if (!hasSkyRecursive(explorerHierarchy.items)) {
                const sunHeight = sun.position.y / orbit;
                if (scene.background instanceof THREE.Color) {
                    if (sunHeight > 0) scene.background.setHSL(0.55, 0.5, 0.4 + (sunHeight * 0.2));
                    else scene.background.set(0x050510); // Night
                }
            }
        }

        if (item.id === 'folder-ui') {
            const p = item.properties || {};
            gameUIContainer.style.display = p.visible !== false ? 'block' : 'none';
        }

        // Handle 3D Objects & Lights
        // Handle Physical Objects & Lights (Only functional in the World)
        if (item.objectRef && item.subType !== 'particle') {
            const mesh = item.objectRef;
            const parentItem = findParentItem(item.id);
            const parentObj = (parentItem && parentItem.objectRef) ? parentItem.objectRef : scene;
            
            // Initialize Multi-Material support if children have surface elements
            const surfaceDescendants = getSurfaceDescendants(item);
            const isBox = mesh.geometry && mesh.geometry.type === 'BoxGeometry';
            
            if (surfaceDescendants.length > 0 && mesh.isMesh && !Array.isArray(mesh.material) && isBox) {
                const baseMat = mesh.material;
                // Save original map so Surface UI can draw on top of it
                mesh.userData.originalMap = baseMat.map || null;
                
                // Capture the initial part color before we lose it during multi-material conversion
                if (!mesh.userData.partColor && baseMat.color) {
                    mesh.userData.partColor = '#' + baseMat.color.getHexString();
                }
                
                const faces = [];
                for(let i=0; i<6; i++) {
                    const m = baseMat.clone();
                    faces.push(m);
                }
                item.objectRef.material = faces;
                updateObjectUVs(item.objectRef, item);
            } else if (item.objectRef.isMesh && Array.isArray(item.objectRef.material) && (surfaceDescendants.length === 0)) {
                const mesh = item.objectRef;
                mesh.material = mesh.material[0].clone();
                // Restore original map and base color/neon glow
                mesh.material.map = mesh.userData.originalMap || null;
                if (mesh.userData.material === 'Neon' && mesh.userData.partColor) {
                    mesh.material.color.set(mesh.userData.partColor).multiplyScalar(25);
                } else if (mesh.userData.partColor) {
                    mesh.material.color.set(mesh.userData.partColor);
                }
                updateObjectUVs(item.objectRef, item);
            }

            if (isWorld) {
                if (!scene.children.includes(item.objectRef) && !item.objectRef.parent) scene.add(item.objectRef);
                // Ensure the 3D object is in the scene and parented correctly
                if (item.objectRef.parent !== parentObj && !state.selectedObjects.includes(item.objectRef)) {
                    parentObj.attach(item.objectRef);
                }
                
                if (item.objectRef.isMesh) {
                    item.objectRef.visible = true;
                    // Transparent objects should not cast solid shadows
                    const isTransparent = item.objectRef.material && item.objectRef.material.transparent;
                    item.objectRef.castShadow = (item.objectRef.userData.castShadow !== false) && !isTransparent;
                    // Shadows disappear at 0.5 opacity and lower
                    const opacity = item.objectRef.userData.opacity ?? 1;
                    item.objectRef.castShadow = (item.objectRef.userData.castShadow !== false) && (opacity > 0.5);
                    item.objectRef.receiveShadow = true;
                }

                // Sync Light Properties
                if (item.type === 'light' && item.objectRef) {
                    state.allLights.push(item);
                    const lp = item.properties || { intensity: 1, range: 10, color: '#ffffff', castShadow: true };
                    
                    item.objectRef.intensity = (lp.intensity ?? 1) * 40;
                    item.objectRef.distance = lp.range ?? 10;
                    item.objectRef.decay = 0;

                    const col = lp.color || '#ffffff';
                    if (item.objectRef.color.getHexString() !== new THREE.Color(col).getHexString()) {
                        item.objectRef.color.set(col);
                    }
                    
                    // Initialize Lightweight Billboard LOD
                    if (!item.billboardRef) {
                        const canvas = document.createElement('canvas');
                        canvas.width = 64; canvas.height = 64;
                        const ctx = canvas.getContext('2d');
                        const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
                        grad.addColorStop(0, 'rgba(255, 255, 255, 1)');
                        grad.addColorStop(0.2, 'rgba(255, 255, 255, 0.8)');
                        grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
                        ctx.fillStyle = grad;
                        ctx.fillRect(0, 0, 64, 64);
                        
                        const map = new THREE.CanvasTexture(canvas);
                        const mat = new THREE.SpriteMaterial({ map, color: col, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
                        item.billboardRef = new THREE.Sprite(mat);
                        item.billboardRef.userData.isEditor = true; // Prevent selection/interaction
                        item.objectRef.add(item.billboardRef);
                    }
                    if (item.billboardRef.material.color.getHexString() !== new THREE.Color(col).getHexString()) {
                        item.billboardRef.material.color.set(col);
                    }

                    if (item.objectRef.shadow) item.objectRef.shadow.radius = 1;

                    // Configure shadow resolution for point lights
                    if (item.objectRef.shadow) {
                        if (item.objectRef.shadow.mapSize.x !== 256) {
                            item.objectRef.shadow.mapSize.set(256, 256);
                        }

                        if (item.objectRef.shadow.bias !== -0.0001) item.objectRef.shadow.bias = -0.0001;
                        if (item.objectRef.shadow.normalBias !== 0.05) item.objectRef.shadow.normalBias = 0.05;
                        
                        // If parented to an object, adjust near plane to prevent the parent from blocking light
                        if (parentItem && parentItem.type === 'object') {
                            const s = parentItem.objectRef.scale;
                        // Calculate half-diagonal to find the distance from the center to the furthest corner
                        const halfDiagonal = Math.sqrt(s.x*s.x + s.y*s.y + s.z*s.z) * 0.5;
                        // Set near plane just beyond the parent's bounds to exclude it from this light's shadow map
                        const targetNear = halfDiagonal + 0.1;
                        if (item.objectRef.shadow.camera.near !== targetNear) {
                            item.objectRef.shadow.camera.near = targetNear;
                            item.objectRef.shadow.camera.updateProjectionMatrix();
                        }
                        } else if (item.objectRef.shadow.camera.near !== 0.1) {
                            item.objectRef.shadow.camera.near = 0.1;
                            item.objectRef.shadow.camera.updateProjectionMatrix();
                        }
                    }

                    // If parented to a physical object, center it to emit light FROM that object
                    if (parentItem && parentItem.type === 'object') {
                        item.objectRef.position.set(0, 0, 0);
                    }
                }
            } else {
                scene.remove(item.objectRef);
                // Remove from scene if moved out of World
                if (item.objectRef.parent) item.objectRef.parent.remove(item.objectRef);
                if (item.objectRef.isMesh) item.objectRef.visible = false;
            }
        }

        // Handle Sound Elements
        if (item.type === 'sound') {
            const p = item.properties || {};
            const asset = state.soundAssets[p.soundId];
            
            if (asset && asset.buffer) {
                // Determine if the sound is in the world and find its parent mesh if applicable.
                // Sounds are now positional even if they aren't inside a Part.
                let physicalParentObj = null;
                let currId = item.id;
                while (currId) {
                    const pItem = findParentItem(currId);
                    if (!pItem) break;
                    // If inside a part, the sound will follow that part.
                    if (pItem.objectRef && (pItem.type === 'object' || pItem.type === 'spawn')) {
                        physicalParentObj = pItem.objectRef;
                        break;
                    }
                    currId = pItem.id;
                }

                const currentIsPositional = item.audioRef instanceof THREE.PositionalAudio;

                // 1. Manage Audio Object Lifetime
                if (!item.audioRef || currentIsPositional) {
                    if (item.audioRef) {
                        if (item.audioRef.parent) item.audioRef.parent.remove(item.audioRef);
                    }
                    item.audioRef = new THREE.Audio(audioListener);
                    item._sessionPlaying = false;
                }

                // 2. Parenting
                const targetParent = audioListener;
                if (item.audioRef.parent !== targetParent) {
                    targetParent.add(item.audioRef);
                }

                // 3. Buffer Assignment (Critical: Only set if changed to prevent restarts)
                if (!item.audioRef.buffer || item.audioRef.buffer !== asset.buffer) {
                    item.audioRef.setBuffer(asset.buffer);
                }

                // 4. Manual Distance Attenuation
                const listenerPos = new THREE.Vector3();
                const soundPos = new THREE.Vector3();
                camera.getWorldPosition(listenerPos);
                if (physicalParentObj) {
                    physicalParentObj.getWorldPosition(soundPos);
                } else {
                    soundPos.set(p.posX || 0, p.posY || 0, p.posZ || 0);
                }

                const distance = listenerPos.distanceTo(soundPos);
                const start = Math.max(0, p.startDistance ?? 0);
                const rolloff = Math.max(start, p.rolloffDistance ?? start);
                const max = Math.max(rolloff, p.maxDistance ?? 100);

                let spatialAtten = 1;
                if (distance >= max) {
                    spatialAtten = 0;
                } else if (distance > rolloff) {
                    spatialAtten = 1 - (distance - rolloff) / Math.max(0.0001, max - rolloff);
                }

                const targetVol = ((p.volume ?? 100) / 100) * spatialAtten;
                if (item.audioRef.getVolume() !== targetVol) item.audioRef.setVolume(targetVol);
                
                const targetRate = (p.playbackSpeed ?? 1) * (p.pitch ?? 1);
                if (item.audioRef.playbackRate !== targetRate) item.audioRef.setPlaybackRate(targetRate);
                
                const targetLoop = p.loop !== false;
                if (item.audioRef.getLoop() !== targetLoop) item.audioRef.setLoop(targetLoop);

                // 4. Play/Stop Logic (State-driven and persistent across scene refreshes)
                const shouldBePlaying = !!(state.isPlayTesting && p.playing === true);
                
                if (item._sessionPlaying !== shouldBePlaying) {
                    if (shouldBePlaying) {
                        // Only call play if not already playing. This prevents restarts on every click.
                        if (!item.audioRef.isPlaying) item.audioRef.play();
                    } else {
                        if (item.audioRef.isPlaying) item.audioRef.stop();
                    }
                    item._sessionPlaying = shouldBePlaying;
                }
            } else if (item.audioRef) {
                if (item.audioRef.isPlaying) item.audioRef.stop();
                if (item.audioRef.parent) item.audioRef.parent.remove(item.audioRef);
                item.audioRef = null;
                item._sessionPlaying = false;
            }
        }

        // Handle UI Elements
        if (isUI && surfaceTypes.includes(item.type)) {
            const parentItem = findParentItem(item.id);
            const isOnObject = parentItem && (parentItem.type === 'object' || parentItem.type === 'spawn' || parentItem.type === 'billboard');
            
            // If UI is on an object, don't render it in the 2D overlay
            if (isOnObject) return;

            const p = item.properties || {};
            let el = document.createElement('div'); // Always use a div wrapper for handles

            if (item.type !== 'frame') el.innerText = p.text ?? '';

            const displayStyle = p.visible === false ? 'none' : 'flex';
            el.style.cssText = `
                position: absolute; pointer-events: auto;
                background: ${item.type === 'text' || item.type === 'image' ? 'transparent' : (p.color || '#444444')}; color: ${p.textColor || '#ffffff'};
                font-size: ${p.fontSize || 14}px; border: none; border-radius: 0;
                display: ${displayStyle};
                opacity: ${p.opacity ?? 1};
                left: ${window.innerWidth / 2 + (p.posX || 0) - (p.sizeX || 100) / 2}px; top: ${window.innerHeight / 2 + (p.posY || 0) - (p.sizeY || 50) / 2}px;
                width: ${p.sizeX || 100}px; height: ${p.sizeY || 50}px;
                transform: rotate(${p.rotation || 0}deg); transform-origin: center;
                box-sizing: border-box; overflow: visible; align-items: center; justify-content: center; z-index: ${p.order || 0};
            `;

            if (item.type === 'image') {
                const asset = state.imageAssets[p.imageId];
                if (asset) {
                    el.style.backgroundImage = `url("${asset.frames[asset.currentFrame || 0]}")`;
                    el.style.backgroundSize = '100% 100%';
                } else {
                    const placeholder = "data:image/svg+xml;charset=utf-8,<svg xmlns='http://www.w3.org/2000/svg' width='100' height='100' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='1' stroke-linecap='round' stroke-linejoin='round'><rect x='3' y='3' width='18' height='18' rx='2' ry='2'/><line x1='3' y1='9' x2='21' y2='9'/><line x1='9' y1='21' x2='9' y2='9'/></svg>";
                    el.style.backgroundImage = `url("${placeholder}")`;
                    el.style.backgroundSize = 'contain';
                    el.style.backgroundRepeat = 'no-repeat';
                    el.style.backgroundPosition = 'center';
                    el.style.opacity = '0.3';
                }
            }

            el.onclick = (e) => {
                e.stopPropagation();
                const now = Date.now();
                const isSelected = state.currentSelectedItem === item;

                if ((item.type === 'image' || item.type === 'texture') && isSelected && !e.shiftKey) {
                    if (now - state.lastClickTime < 2000) {
                        const assetId = p.imageId;
                        if (assetId) {
                            makeTabPersistent(assetId);
                            switchTab(assetId);
                            state.lastClickTime = 0;
                            return;
                        }
                    }
                }
                state.lastClickTime = now;
                selectHierarchyItem(item, e.shiftKey);
            };

            el.ondblclick = (e) => {
                e.stopPropagation();
                if ((item.type === 'image' || item.type === 'texture') && p.imageId) {
                    makeTabPersistent(p.imageId);
                    switchTab(p.imageId);
                }
            };

        // Selection and Interaction Handles
        if (state.currentSelectedItem === item) {
            el.style.outline = '2px solid #00ff88';
            el.style.zIndex = '1000';
            el.style.cursor = 'move';

            const startInteraction = (e, mode, corner = null) => {
                e.stopPropagation();
                e.preventDefault();
                const startX = e.clientX, startY = e.clientY;
                const startPosX = p.posX || 0, startPosY = p.posY || 0;
                const startSizeX = p.sizeX || 100, startSizeY = p.sizeY || 50;
                const rad = (p.rotation || 0) * (Math.PI / 180);
                const cos = Math.cos(rad), sin = Math.sin(rad);

                // Calculate initial world center (screen pixels) and anchor point
                const screenCenterX = window.innerWidth / 2;
                const screenCenterY = window.innerHeight / 2;
                const startCenterX = screenCenterX + startPosX;
                const startCenterY = screenCenterY + startPosY;

                // Anchor is the point that stays fixed during scaling (the opposite corner)
                let localAnchorX = 0, localAnchorY = 0;
                if (corner === 'se') { localAnchorX = -startSizeX / 2; localAnchorY = -startSizeY / 2; }
                else if (corner === 'nw') { localAnchorX = startSizeX / 2; localAnchorY = startSizeY / 2; }
                else if (corner === 'ne') { localAnchorX = -startSizeX / 2; localAnchorY = startSizeY / 2; }
                else if (corner === 'sw') { localAnchorX = startSizeX / 2; localAnchorY = -startSizeY / 2; }

                const anchorWorldX = startCenterX + (localAnchorX * cos - localAnchorY * sin);
                const anchorWorldY = startCenterY + (localAnchorX * sin + localAnchorY * cos);

                const onMove = (me) => {
                    const dx = me.clientX - startX, dy = me.clientY - startY;
                    
                    const localDX = dx * cos + dy * sin;
                    const localDY = -dx * sin + dy * cos;

                    if (mode === 'move') {
                        p.posX = Math.round(startPosX + dx);
                        p.posY = Math.round(startPosY + dy);
                    } else if (mode === 'resize' && corner) {
                        let newSizeX = startSizeX, newSizeY = startSizeY;
                        if (corner.includes('e')) newSizeX = Math.max(5, startSizeX + localDX);
                        if (corner.includes('w')) newSizeX = Math.max(5, startSizeX - localDX);
                        if (corner.includes('s')) newSizeY = Math.max(5, startSizeY + localDY);
                        if (corner.includes('n')) newSizeY = Math.max(5, startSizeY - localDY);

                        // Calculate new center based on stationary anchor
                        let newLocalAnchorX = 0, newLocalAnchorY = 0;
                        if (corner === 'se') { newLocalAnchorX = -newSizeX / 2; newLocalAnchorY = -newSizeY / 2; }
                        else if (corner === 'nw') { newLocalAnchorX = newSizeX / 2; newLocalAnchorY = newSizeY / 2; }
                        else if (corner === 'ne') { newLocalAnchorX = -newSizeX / 2; newLocalAnchorY = newSizeY / 2; }
                        else if (corner === 'sw') { newLocalAnchorX = newSizeX / 2; newLocalAnchorY = -newSizeY / 2; }

                        const newCenterX = anchorWorldX - (newLocalAnchorX * cos - newLocalAnchorY * sin);
                        const newCenterY = anchorWorldY - (newLocalAnchorX * sin + newLocalAnchorY * cos);

                        p.sizeX = Math.round(newSizeX);
                        p.sizeY = Math.round(newSizeY);
                        p.posX = Math.round(newCenterX - screenCenterX);
                        p.posY = Math.round(newCenterY - screenCenterY);
                    } else if (mode === 'rotate') {
                        const rect = el.getBoundingClientRect();
                        const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
                        p.rotation = Math.round(Math.atan2(me.clientY - cy, me.clientX - cx) * (180 / Math.PI) + 90);
                    }
                    
                    el.style.left = (screenCenterX + p.posX - p.sizeX / 2) + 'px'; el.style.top = (screenCenterY + p.posY - p.sizeY / 2) + 'px';
                    el.style.width = p.sizeX + 'px'; el.style.height = p.sizeY + 'px';
                    el.style.transform = `rotate(${p.rotation}deg)`;
                    updatePropertyValues();
                };

                const onUp = () => {
                    window.removeEventListener('mousemove', onMove);
                    window.removeEventListener('mouseup', onUp);
                    refreshSceneState();
                };
                window.addEventListener('mousemove', onMove);
                window.addEventListener('mouseup', onUp);
            };

            el.onmousedown = (e) => {
                if (e.target === el) startInteraction(e, 'move');
            };
            
            // Four Corner Scale Handles
            const handles = [
                { id: 'nw', css: 'top: -6px; left: -6px; cursor: nwse-resize;' },
                { id: 'ne', css: 'top: -6px; right: -6px; cursor: nesw-resize;' },
                { id: 'sw', css: 'bottom: -6px; left: -6px; cursor: nesw-resize;' },
                { id: 'se', css: 'bottom: -6px; right: -6px; cursor: nwse-resize;' }
            ];

            handles.forEach(h => {
                const hEl = document.createElement('div');
                hEl.style.cssText = `position: absolute; width: 10px; height: 10px; background: #00ff88; border: 1px solid #000; z-index: 1001; ${h.css}`;
                hEl.onmousedown = (e) => startInteraction(e, 'resize', h.id);
                el.appendChild(hEl);
            });

            // Rotation Handle
            const rotator = document.createElement('div');
            rotator.style.cssText = 'position: absolute; top: -35px; left: 50%; transform: translateX(-50%); width: 12px; height: 12px; background: #00ff88; border: 1px solid #000; border-radius: 50%; cursor: crosshair; z-index: 1001;';
            const line = document.createElement('div');
            line.style.cssText = 'position: absolute; top: 12px; left: 50%; width: 2px; height: 23px; background: #00ff88; transform: translateX(-50%);';
            rotator.appendChild(line);
            rotator.onmousedown = (e) => startInteraction(e, 'rotate');
            el.appendChild(rotator);
        }
            
            gameUIContainer.appendChild(el);
        }

        // Handle Surface UI & Textures on Meshes
        if (item.objectRef && item.objectRef.isMesh) {
            const mesh = item.objectRef;
            const isBox = mesh.geometry && mesh.geometry.type === 'BoxGeometry';

            // Check if any selected item is a descendant (to refresh parent billboards when children change)
            const isSelected = state.selectedObjects.includes(mesh) || state.selectedItems.has(item) || 
                               Array.from(state.selectedItems).some(sel => {
                                   let p = findParentItem(sel.id);
                                   return p && p.id === item.id;
                               });

            const shouldUpdateSurface = !targetItem || isSelected || targetItem === item;

            // If not a box and not a global refresh, we still update if it's the target.
            if (!shouldUpdateSurface && isBox) return;
            
            const requiredOverlayKeys = new Set();

            // Pre-calculate variables used by both Billboards and Surface UI
            const worldScale = new THREE.Vector3();
            mesh.getWorldScale(worldScale);
            const surfaceChildren = getSurfaceDescendants(item);

            // --- 0. HANDLE BILLBOARD UI RENDERING ---
            if (item.type === 'billboard') {
                const key = `${mesh.uuid}-billboard`;
                const uiElements = surfaceChildren.filter(c => c.type !== 'texture');
                
                if (uiElements.length > 0) {
                    mesh.castShadow = item.properties?.castShadow !== false;
                    mesh.receiveShadow = true;

                    // "No Canvas Limit": Calculate the bounds of all UI children to make the billboard quad elastic
                    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                    uiElements.forEach(c => {
                        const p = c.properties || {};
                        if (p.visible === false) return;
                        const x = p.posX || 0, y = p.posY || 0;
                        const w = p.sizeX || 100, h = p.sizeY || 50;
                        minX = Math.min(minX, x); minY = Math.min(minY, y);
                        maxX = Math.max(maxX, x + w); maxY = Math.max(maxY, y + h);
                    });

                    if (minX === Infinity) { minX = 0; minY = 0; maxX = 100; maxY = 50; }
                    const contentW = maxX - minX;
                    const contentH = maxY - minY;

                    // Dynamic Resolution based on UI Content Bounds
                    const targetW = Math.max(512, Math.min(2048, Math.ceil(contentW * 1.5)));
                    const targetH = Math.max(512, Math.min(2048, Math.ceil(contentH * 1.5)));

                    let canvas = surfaceCanvases.get(key);
                    if (!canvas || canvas.width !== targetW || canvas.height !== targetH) {
                        if (surfaceTextures.has(key)) {
                            surfaceTextures.get(key).dispose();
                            surfaceTextures.delete(key);
                        }
                        canvas = document.createElement('canvas');
                        canvas.width = targetW; canvas.height = targetH;
                        surfaceCanvases.set(key, canvas);
                    }
                    
                    const ctx = canvas.getContext('2d');
                    ctx.clearRect(0, 0, canvas.width, canvas.height);
                    
                    uiElements.sort((a, b) => (a.properties?.order || 0) - (b.properties?.order || 0));
                    const ux = canvas.width / 1000;
                    const uy = canvas.height / 1000;

                    uiElements.forEach(c => {
                        const p = c.properties || {};
                        if (p.visible === false) return;
                        ctx.save();
                        ctx.globalAlpha = p.opacity ?? 1;
                        ctx.translate((500 + (p.posX || 0)) * ux, (500 + (p.posY || 0)) * uy);
                        ctx.rotate((p.rotation || 0) * Math.PI / 180);
                        ctx.translate((-(p.sizeX || 100) / 2) * ux, (-(p.sizeY || 50) / 2) * uy);
                        
                        if (c.type === 'frame' || c.type === 'textlabel') {
                            ctx.fillStyle = p.color || '#ffffff';
                            ctx.fillRect(0, 0, (p.sizeX || 100) * ux, (p.sizeY || 50) * uy);
                        }
                        if (c.type === 'image' && p.imageId && state.imageAssets[p.imageId]) {
                            const asset = state.imageAssets[p.imageId];
                            const img = new Image(); img.src = asset.frames[asset.currentFrame || 0];
                            if (img.complete) ctx.drawImage(img, 0, 0, (p.sizeX || 100) * ux, (p.sizeY || 50) * uy);
                            else img.onload = () => { if (img.complete) refreshSceneState(); };
                        }
                        if ((c.type === 'textlabel' || c.type === 'text') && p.text) {
                            ctx.fillStyle = p.textColor || '#000000';
                            ctx.font = `${(p.fontSize || 24) * uy}px sans-serif`;
                            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                            ctx.fillText(p.text, ((p.sizeX || 100) / 2) * ux, ((p.sizeY || 50) / 2) * uy);
                        }
                        ctx.restore();
                    });

                    if (!surfaceTextures.has(key)) {
                        const tex = new THREE.CanvasTexture(canvas);
                        tex.colorSpace = THREE.SRGBColorSpace;
                        surfaceTextures.set(key, tex);
                    }
                    const uiTex = surfaceTextures.get(key);
                    uiTex.needsUpdate = true;

                    if (mesh.material.map !== uiTex) {
                        mesh.material.map = uiTex;
                        mesh.material.needsUpdate = true;
                    }
                    mesh.material.opacity = item.properties?.opacity ?? 1;
                    mesh.material.alphaTest = 0.05;

                    // Purely Visual Rotation: Face camera ONLY during render, preserving logical rotation for gizmos
                    const originalQuat = new THREE.Quaternion();
                    const tempQuat = new THREE.Quaternion();
                    mesh.onBeforeRender = (renderer, scene, camera) => {
                        originalQuat.copy(mesh.quaternion);
                        mesh.quaternion.copy(camera.quaternion);
                        if (mesh.parent && mesh.parent !== scene) {
                            mesh.parent.getWorldQuaternion(tempQuat).invert();
                            mesh.quaternion.premultiply(tempQuat);
                        }
                        mesh.updateMatrixWorld();
                    };
                    mesh.onAfterRender = () => {
                        mesh.quaternion.copy(originalQuat);
                        mesh.updateMatrixWorld();
                    };

                    mesh.material.visible = true;
                } else {
                    // Fallback for empty billboard
                    if (mesh.material.map) {
                        mesh.material.map = null;
                        mesh.material.needsUpdate = true;
                    }
                    mesh.material.transparent = true;
                    mesh.material.opacity = 0;
                    mesh.material.visible = true; // Stay visible (but 0 opacity) for selection hits
                }
                return; // Billboards don't use the standard face-overlay system below
            }

            // --- 1. HANDLE MESH SURFACE OVERLAYS ---
            const currentOverlays = mesh.children.filter(c => c.userData.isSurfaceOverlay);
            
            // FIX: Always run bounds check to allow cleanup if surfaceChildren is 0
            if (mesh.isMesh) {
                if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
                const geomSize = new THREE.Vector3();
                mesh.geometry.boundingBox.getSize(geomSize);

                const absW = Math.max(0.01, geomSize.x * worldScale.x);
                const absH = Math.max(0.01, geomSize.y * worldScale.y);
                const absD = Math.max(0.01, geomSize.z * worldScale.z);

                const faceGroups = {};
                surfaceChildren.forEach(child => {
                    const f = child.properties?.face || 'Front';
                    if (!faceGroups[f]) faceGroups[f] = [];
                    faceGroups[f].push(child);
                });

                // Loop through all 6 faces to either update UI or clear old UI textures
                for (const [faceName, faceIdx] of Object.entries(FACE_MAP)) {
                    const children = faceGroups[faceName] || [];
                    const key = `${mesh.uuid}-${faceIdx}`;
                    
                    if (children.length > 0) {
                        // Determine the world-space dimensions for this specific face
                        let faceW, faceH;
                        if (faceName === 'Top' || faceName === 'Bottom') { faceW = absW; faceH = absD; }
                        else if (faceName === 'Left' || faceName === 'Right') { faceW = absD; faceH = absH; }
                        else { faceW = absW; faceH = absH; }

                        const uiElements = children.filter(c => c.type !== 'texture');
                        const textureElements = children.filter(c => c.type === 'texture');

                        // 1. Handle Tiling Textures as independent GPU layers
                        textureElements.forEach((c, idx) => {
                            const p = c.properties || {};
                            if (p.visible === false || !p.imageId || !state.imageAssets[p.imageId]) return;
                            
                            const overlayId = `tex-${key}-${idx}`;
                            requiredOverlayKeys.add(overlayId);

                            let plane = currentOverlays.find(o => o.userData.overlayId === overlayId);
                            if (!plane) {
                                const asset = state.imageAssets[p.imageId];
                                const tex = getTextureFromCache(asset.frames[asset.currentFrame || 0]);
                                
                                // UNIVERSAL SHAPE SUPPORT: If not a box, clone the parent geometry
                                // We clone geometry so we can modify UVs for face projection on primitives
                                const overlayGeo = isBox ? new THREE.PlaneGeometry(1, 1) : mesh.geometry.clone();
                                
                                plane = new THREE.Mesh(
                                    overlayGeo,
                                    new THREE.MeshStandardMaterial({ 
                                        map: tex, transparent: true, opacity: p.opacity ?? 1,
                                        // Force depth priority over base mesh
                                        polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -100 - idx,
                                        depthWrite: false, side: THREE.DoubleSide,
                                        envMap: (scene.background instanceof THREE.CubeTexture) ? scene.background : null,
                                        roughness: 1.0, metalness: 0.0,
                                        shadowSide: null
                                    })
                                );
                                plane.userData.isSurfaceOverlay = true;
                                plane.userData.overlayId = overlayId;
                                plane.userData.face = faceName;
                                plane.userData.currentImageId = p.imageId;
                                mesh.add(plane);
                            } else if (plane.userData.currentImageId !== p.imageId) {
                                // REFRESH TEXTURE: If imageId changed, update the map immediately
                                const asset = state.imageAssets[p.imageId];
                                if (asset) {
                                    const newTex = getTextureFromCache(asset.frames[asset.currentFrame || 0]);
                                    if (plane.material.map) plane.material.map.dispose();
                                    plane.material.map = newTex;
                                    plane.userData.currentImageId = p.imageId;
                                    // Force UV update for new texture tiling
                                    updateObjectUVs(mesh, item);
                                }
                            }
                            
                            const repX = faceW / (p.tileX || 1);
                            const repY = faceH / (p.tileY || 1);
                            if (plane.material.map.repeat.x !== repX || plane.material.map.repeat.y !== repY) {
                                plane.material.map.repeat.set(repX, repY);
                            }
                            plane.material.opacity = p.opacity ?? 1;
                            plane.receiveShadow = true;

                            if (isBox) {
                                const config = FACE_CONFIG[faceName];
                                plane.position.set(...config.pos);
                                plane.rotation.set(...config.rot);
                            } else {
                                plane.position.set(0, 0, 0);
                                plane.rotation.set(0, 0, 0);
                            }
                        });

                        // 2. Handle UI Elements on a shared high-res transparent canvas
                        // UI is only supported on Box faces for layout predictability
                        if (uiElements.length > 0 && isBox) {
                            // Dynamic Resolution: Scale canvas to keep UI sharp on large objects.
                            // Capped at 4096px for performance.
                            const targetW = Math.max(512, Math.min(4096, Math.ceil(faceW * 256)));
                            const targetH = Math.max(512, Math.min(4096, Math.ceil(faceH * 256)));

                            const overlayId = `ui-${key}`;
                            requiredOverlayKeys.add(overlayId);

                            let canvas = surfaceCanvases.get(key);
                            if (!canvas || canvas.width !== targetW || canvas.height !== targetH) {
                                if (surfaceTextures.has(key)) {
                                    surfaceTextures.get(key).dispose();
                                    surfaceTextures.delete(key);
                                }
                                canvas = document.createElement('canvas');
                                canvas.width = targetW; canvas.height = targetH;
                                surfaceCanvases.set(key, canvas);
                            }
                            const ctx = canvas.getContext('2d');
                            ctx.clearRect(0, 0, canvas.width, canvas.height);
                            
                            uiElements.sort((a, b) => (a.properties?.order || 0) - (b.properties?.order || 0));
                            uiElements.forEach(c => {
                                const p = c.properties || {};
                                if (p.visible === false) return;
                                // UI uses 0-1000 normalized coordinates, map to current high-res canvas pixels
                                const ux = canvas.width / 1000;
                                const uy = canvas.height / 1000;
                                ctx.save();
                                ctx.globalAlpha = p.opacity ?? 1;
                                ctx.translate((500 + (p.posX || 0)) * ux, (500 + (p.posY || 0)) * uy);
                                ctx.rotate((p.rotation || 0) * Math.PI / 180);
                                ctx.translate((-(p.sizeX || 100) / 2) * ux, (-(p.sizeY || 50) / 2) * uy);
                                if (c.type === 'frame' || c.type === 'textlabel') {
                                    ctx.fillStyle = p.color || '#ffffff';
                                    ctx.fillRect(0, 0, (p.sizeX || 100) * ux, (p.sizeY || 50) * uy);
                                }
                                if (c.type === 'image' && p.imageId && state.imageAssets[p.imageId]) {
                                    const asset = state.imageAssets[p.imageId];
                                    const img = new Image(); img.src = asset.frames[asset.currentFrame || 0];
                                    if (img.complete) ctx.drawImage(img, 0, 0, (p.sizeX || 100) * ux, (p.sizeY || 50) * uy);
                                    else img.onload = () => { if (img.complete) refreshSceneState(); };
                                }
                                if ((c.type === 'textlabel' || c.type === 'text') && p.text) {
                                    ctx.fillStyle = p.textColor || '#000000';
                                    ctx.font = `${(p.fontSize || 24) * uy}px sans-serif`;
                                    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                                    ctx.fillText(p.text, ((p.sizeX || 100) / 2) * ux, ((p.sizeY || 50) / 2) * uy);
                                }
                                ctx.restore();
                            });

                            if (!surfaceTextures.has(key)) {
                                const tex = new THREE.CanvasTexture(canvas);
                                tex.colorSpace = THREE.SRGBColorSpace;
                                surfaceTextures.set(key, tex);
                            }
                            const uiTex = surfaceTextures.get(key);
                            uiTex.needsUpdate = true;

                            let uiPlane = currentOverlays.find(o => o.userData.overlayId === overlayId);
                            if (!uiPlane) {
                                uiPlane = new THREE.Mesh(
                                    new THREE.PlaneGeometry(1, 1),
                                    new THREE.MeshStandardMaterial({ 
                                        map: uiTex, transparent: true,
                                        polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -200,
                                        depthWrite: false, side: THREE.DoubleSide,
                                        roughness: 1.0, metalness: 0.0,
                                        envMap: (scene.background instanceof THREE.CubeTexture) ? scene.background : null
                                    })
                                );
                                uiPlane.userData.isSurfaceOverlay = true;
                                uiPlane.userData.overlayId = overlayId;
                                uiPlane.userData.face = faceName;
                                mesh.add(uiPlane);
                            }
                            uiPlane.receiveShadow = true;
                            const config = FACE_CONFIG[faceName];
                            uiPlane.position.set(...config.pos);
                            uiPlane.rotation.set(...config.rot);
                        }
                    }
                }

                // Remove any overlays that are no longer required
                currentOverlays.forEach(overlay => {
                    if (!requiredOverlayKeys.has(overlay.userData.overlayId)) {
                        if (overlay.material.map && !overlay.material.map.isCanvasTexture) overlay.material.map.dispose();
                        overlay.material.dispose();
                        mesh.remove(overlay);
                    }
                });
                // Recalculate UVs to apply tiling properties from Texture elements
                updateObjectUVs(mesh, item);
            }
        }

        // Handle Particle Emitters (Functional initialization)
        if (item.subType === 'particle') {
            const p = item.properties || {};
            if (!item.objectRef) {
                const geo = new THREE.BufferGeometry();
                const mat = new THREE.PointsMaterial({
                    size: 5, transparent: true, depthWrite: false,
                    sizeAttenuation: true, alphaTest: 0.01,
                    depthTest: true, // Respect world depth
                    blending: THREE.NormalBlending, vertexColors: true
                });
                item.objectRef = new THREE.Points(geo, mat);
                item.objectRef.frustumCulled = false;
                item.objectRef.renderOrder = 5; // Render with other transparent objects
                item.particleData = [];
            }

            // Sync properties to userData for SSR processing
            item.objectRef.userData.reflectiveness = p.reflectiveness ?? 0;
            item.objectRef.userData.opacity = p.opacity ?? 1;
            
            const mat = item.objectRef.material;
            mat.blending = p.blending === 'Additive' ? THREE.AdditiveBlending : THREE.NormalBlending;

            if (p.imageId && state.imageAssets[p.imageId]) {
                const asset = state.imageAssets[p.imageId];
                if (!mat.map || mat.map.name !== p.imageId) {
                    const tex = new THREE.TextureLoader().load(asset.frames[asset.currentFrame || 0], () => {
                        mat.needsUpdate = true;
                    });
                    tex.colorSpace = THREE.SRGBColorSpace;
                    mat.map = tex;
                    mat.map.name = p.imageId;
                }
            } else {
                mat.map = null;
            }
            mat.opacity = p.opacity ?? 1;
            
            if (isWorld) {
                // Particles MUST be children of the scene to use World Space coordinates correctly
                if (item.objectRef.parent !== scene) {
                    scene.add(item.objectRef);
                    item.objectRef.position.set(0,0,0);
                    item.objectRef.scale.set(1,1,1);
                }
                item.objectRef.visible = p.enabled !== false;
                state.activeEmitters.add(item);
            } else {
                if (item.objectRef.parent) item.objectRef.parent.remove(item.objectRef);
                state.activeEmitters.delete(item);
            }
        }

        // Handle Effects (Only in Lighting)
        if (isLighting && item.type === 'effect') {
            const p = item.properties || {};
            if (item.subType === 'bloom') {
                bloomPass.strength = p.strength || 0;
                bloomPass.radius = p.radius || 0.4;
                bloomPass.threshold = p.threshold ?? 0.85;
            } else if (item.subType === 'fog') {
                scene.fog = new THREE.FogExp2(p.color || 0x87CEEB, p.density || 0.01);
            } else if (item.subType === 'sunrays') {
                if (godRaysPass) {
                    godRaysPass.enabled = true;
                    if (sunDisk) sunDisk.visible = true;
                    godRaysPass.uniforms.exposure.value = (p.intensity ?? 1);
                    if (p.color) godRaysPass.uniforms.sunColor.value.set(p.color);
                }
            } else if (item.subType === 'ambient-occlusion') {
                if (saoPass) {
                    saoPass.enabled = p.enabled !== false;
                    // Remap intensity: 1 in UI = 0.001 internally
                    saoPass.params.saoIntensity = (p.intensity ?? 1) * 0.001;
                    saoPass.params.saoKernelRadius = p.radius ?? 10;
                    saoPass.params.saoBias = p.bias ?? 0.05;
                    saoPass.params.saoBlur = p.blur !== false;
                    saoPass.params.saoBlurDepthCutoff = p.depthCutoff ?? 0.001;
                }
            }
        }

        // Handle Skybox
        if (item.type === 'sky') {
            skyFound = true;
            const p = item.properties || {};
            if (p.skyboxId && state.lastSkyboxKey !== p.skyboxId) {
                state.lastSkyboxKey = p.skyboxId;
                const asset = state.imageAssets[p.skyboxId];
                if (asset && asset.frames[0]) {
                    sliceCubemap(asset.frames[0], (sides) => {
                        new THREE.CubeTextureLoader().load(sides, tex => {
                            tex.colorSpace = THREE.SRGBColorSpace;
                            scene.background = tex;
                        });
                    });
                }
            }
        }

        if (item.children) {
            item.children.forEach(child => processItem(child, isWorld, isLighting, isUI, isSoundsFolder));
        }
    };

    explorerHierarchy.items.forEach(item => processItem(item));

    // Only reset to blue if no skybox item was found in the hierarchy
    if (!skyFound && scene.background instanceof THREE.CubeTexture) {
        scene.background = new THREE.Color(0x87CEEB);
        state.lastSkyboxKey = null;
    }
}

export function updateSoundAttenuation() {
    if (!state.isPlayTesting) return;
    const listenerPos = new THREE.Vector3();
    const soundPos = new THREE.Vector3();
    camera.getWorldPosition(listenerPos);

    const processItem = (item) => {
        if (item.type === 'sound' && item.audioRef && item.audioRef.buffer) {
            const p = item.properties || {};
            let physicalParentObj = null;
            let currId = item.id;
            while (currId) {
                const pItem = findParentItem(currId);
                if (!pItem) break;
                if (pItem.objectRef && (pItem.type === 'object' || pItem.type === 'spawn')) {
                    physicalParentObj = pItem.objectRef;
                    break;
                }
                currId = pItem.id;
            }

            if (physicalParentObj) {
                physicalParentObj.getWorldPosition(soundPos);
            } else {
                soundPos.set(p.posX || 0, p.posY || 0, p.posZ || 0);
            }

            const distance = listenerPos.distanceTo(soundPos);
            const start = Math.max(0, p.startDistance ?? 0);
            const rolloff = Math.max(start, p.rolloffDistance ?? start);
            const max = Math.max(rolloff, p.maxDistance ?? 100);

            let spatialAtten = 1;
            if (distance >= max) {
                spatialAtten = 0;
            } else if (distance > rolloff) {
                spatialAtten = 1 - (distance - rolloff) / Math.max(0.0001, max - rolloff);
            }

            const targetVol = ((p.volume ?? 100) / 100) * spatialAtten;
            if (item.audioRef.getVolume() !== targetVol) {
                item.audioRef.setVolume(targetVol);
            }
        }

        if (item.children) item.children.forEach(processItem);
    };

    explorerHierarchy.items.forEach(processItem);
}

// --- UI AND INSPECTOR ---
const explorerList = document.getElementById('explorer-list');
const propertyControls = document.getElementById('property-controls');
const noSelectionText = document.getElementById('no-selection-text');
const nameInput = document.getElementById('prop-name');

// Create dynamic properties container if it doesn't exist
let dynamicProps = document.getElementById('dynamic-properties');
if (!dynamicProps) {
    dynamicProps = document.createElement('div');
    dynamicProps.id = 'dynamic-properties';
    // Insert after the Name field (first .prop-group) so Name stays at the top
    const nameGroup = nameInput.closest('.prop-group');
    if (nameGroup && nameGroup.nextSibling) {
        propertyControls.insertBefore(dynamicProps, nameGroup.nextSibling);
    } else {
        propertyControls.appendChild(dynamicProps);
    }
}

// Create the Density property UI if it is missing from the static HTML.
// This is automatically shown/hidden for physical objects via showInspector().
if (!document.getElementById('prop-density')) {
    const densityGroup = document.createElement('div');
    densityGroup.className = 'prop-group';
    densityGroup.innerHTML = `
        <label class="prop-label">Density</label>
        <input type="number" id="prop-density" class="prop-input" value="10" min="0" max="100" step="0.1" style="width: 100%;">
    `;
    // Insert before the Anchored checkbox group to keep physics properties together
    const anchoredGroup = document.getElementById('prop-anchored').closest('.prop-group');
    propertyControls.insertBefore(densityGroup, anchoredGroup);
}

const colorPicker = document.getElementById('prop-color');
const colorLabel = document.getElementById('prop-color-label');

const deleteBtn = document.getElementById('prop-delete');

const posInputs = { x: document.getElementById('prop-pos-x'), y: document.getElementById('prop-pos-y'), z: document.getElementById('prop-pos-z') };
const rotInputs = { x: document.getElementById('prop-rot-x'), y: document.getElementById('prop-rot-y'), z: document.getElementById('prop-rot-z') };
const scaleInputs = { x: document.getElementById('prop-scale-x'), y: document.getElementById('prop-scale-y'), z: document.getElementById('prop-scale-z') };
const anchoredInput = document.getElementById('prop-anchored');
const collideInput = document.getElementById('prop-collide');
const castShadowInput = document.getElementById('prop-cast-shadow');
const opacityInput = document.getElementById('prop-opacity');
const normalInput = document.getElementById('prop-normal');
const roughnessInput = document.getElementById('prop-roughness');
const densityInput = document.getElementById('prop-density');
const reflectionInput = document.getElementById('prop-reflection');


function clamp01(v) { return Math.max(0, Math.min(1, v)); }
const explorerMenu = document.getElementById('explorer-menu');


document.getElementById('right-sidebar').addEventListener('mousedown', (e) => e.stopPropagation());

// --- HIERARCHICAL EXPLORER SYSTEM ---
export const explorerHierarchy = {
    items: [],
    expanded: {},
    objectCounter: { 'object': 1, 'folder': 1, 'model': 1, 'light': 1, 'effect': 1, 'sound': 1, 'spawn': 1 },
    
    getOrCreateWorld() {
        let world = this.items.find(item => item.type === 'folder' && item.name === 'World');
        if (!world) {
            world = { 
                id: 'world-folder',
                type: 'folder',
                name: 'World', 
                children: [], 
                isProtected: true,
                properties: { gravityStrength: 60, gravityX: 0, gravityY: -1, gravityZ: 0 }
            };
            this.items.push(world);

            // Add Baseplate to explorer
            const bpItem = { id: 'obj-baseplate', type: 'object', name: 'Baseplate', objectRef: baseplate, isProtected: false, children: [] };
            world.children.push(bpItem);

            // Add Default Player Spawn (Only once on initialization)
            setTimeout(() => { 
                createObjectInFolder('world-folder', 'PlayerSpawn'); 
            }, 0);

            this.expanded['world-folder'] = true;
        }
        return world;
    },

    initializeDefaultFolders() {
        const defaultFolders = [
            { name: 'Lighting', icon: '💡', properties: { brightness: 1.2, ambient: 0.4, timeOfDay: 10, geographicLatitude: 50, sunColor: '#ffffff', ambientColor: '#ffffff' } },
            { name: 'UI', icon: '🎨', properties: { visible: true } },
            { name: 'Sounds', icon: '🔊', properties: {} }
        ];

        defaultFolders.forEach(folderData => {
            if (!this.items.find(item => item.type === 'folder' && item.name === folderData.name)) {
                const folder = {
                    id: `folder-${folderData.name.toLowerCase()}`,
                    type: 'folder',
                    name: folderData.name,
                    children: [],
                    isProtected: true,
                    folderIcon: folderData.icon,
                    properties: { ...folderData.properties }
                };
                this.items.push(folder);
                this.expanded[folder.id] = true;
            }
        });
    },
    
    getNextName(type) {
        const names = {
            'object': 'Part',
            'folder': 'Folder',
            'model': 'Model',
            'light': 'Light',
            'frame': 'Frame',
            'effect': 'Effect',
            'ambient-occlusion': 'Ambient Occlusion',
            'sound': 'Sound',
            'bloom': 'Bloom',
            'sunrays': 'SunRays',
            'fog': 'Fog',
            'particle': 'Particle',
            'decal': 'Decal',
            'textlabel': 'TextLabel',
            'text': 'Text',
            'imagebutton': 'ImageButton',
            'textbutton': 'TextButton',
            'framebutton': 'FrameButton',
            'texture': 'Texture',
            'sky': 'Sky',
            'image': 'Image',
            'billboard': 'Billboard',
            'camera': 'Camera',
            'spawn': 'Player Spawn'
        };
        const key = type.toLowerCase();
        return names[key] || type;
    },
    
    findItemById(id) {
        const search = (items) => {
            for (let item of items) {
                if (item.id === id) return item;
                if (item.children) {
                    const found = search(item.children);
                    if (found) return found;
                }
            }
            return null;
        };
        return search(this.items);
    },
    
    addChild(parentId, newItem) {
        const parent = this.findItemById(parentId);
        if (parent && parent.children) {
            parent.children.push(newItem);
            this.expanded[parentId] = true;
            return true;
        }
        return false;
    },
    
    removeItem(id) {
        const remove = (items) => {
            for (let i = 0; i < items.length; i++) {
                if (items[i].id === id) {
                    items.splice(i, 1);
                    return true;
                }
                if (items[i].children && remove(items[i].children)) return true;
            }
            return false;
        };
        return remove(this.items);
    },
    
    moveItem(itemId, newParentId) {
        // Prevent moving protected/default folders
        const itemToMove = this.findItemById(itemId);
        if (!itemToMove || itemToMove.isProtected) return false;

        // Remove from current location
        const removeRecursive = (items) => {
            for (let i = 0; i < items.length; i++) {
                if (items[i].id === itemId) {
                    const item = items.splice(i, 1)[0];
                    return item;
                }
                if (items[i].children) {
                    const found = removeRecursive(items[i].children);
                    if (found) return found;
                }
            }
            return null;
        };
        
        const item = removeRecursive(this.items);
        if (!item) return false;
        
        // Add to new parent
        const newParent = this.findItemById(newParentId);
        if (newParent) {
            // If the new parent doesn't have children, initialize it
            if (!newParent.children) newParent.children = [];
            newParent.children.push(item);
            this.expanded[newParentId] = true;
            refreshSceneState();
            return true;
        }
        return false;
    },
    
    getAllObjectsInItem(itemId) {
        const item = this.findItemById(itemId);
        if (!item) return [];
        
        const collect = (items) => {
            let result = [];
            if (items.objectRef) result.push(items.objectRef);
            if (items.children) {
                items.children.forEach(child => result.push(...collect(child)));
            }
            return result;
        };
        
        return collect(item);
    }
};

// Initialize World folder on startup and add default folders
explorerHierarchy.getOrCreateWorld();
explorerHierarchy.initializeDefaultFolders();

// Current context (for the menu)
export let currentContextId = null;
let draggedItemId = null;
let renamingItemId = null;

export function updateToolUI(activeId) {
    const modes = ['select', 'move', 'scale', 'rotate'];
    modes.forEach(m => {
        const isCurrent = `mode-${m}` === activeId;
        const gBtn = document.getElementById(`mode-${m}`);
        const mBtn = document.getElementById(`mode-${m}-m`);
        [gBtn, mBtn].forEach(btn => {
            if (btn) {
                btn.style.setProperty('background-color', isCurrent ? '#00ff88' : '#333333', 'important');
                btn.style.setProperty('color', isCurrent ? '#000000' : '#ffffff', 'important');
            }
        });
    });
}

function renderExplorerItem(item, depth = 0) {
    const container = document.createElement('div');
    const itemEl = document.createElement('div');
    itemEl.className = 'explorer-item';
    itemEl.style.marginLeft = (depth * 15) + 'px'; // Increased indent for better readability
    itemEl.draggable = true; // Allow dragging all items
    itemEl.dataset.itemId = item.id;
    
    const isObjectSelected = item.objectRef && state.selectedObjects.includes(item.objectRef);
    const isItemSelected = state.selectedItems.has(item);
    if (isObjectSelected || isItemSelected) itemEl.classList.add('selected');
    
    // Arrow for folders/models
    if (item.children && item.children.length > 0) {
        const arrow = document.createElement('div');
        arrow.className = 'exp-arrow' + (explorerHierarchy.expanded[item.id] ? ' open' : '');
        arrow.innerText = '▶';
        arrow.onclick = (e) => {
            e.stopPropagation();
            explorerHierarchy.expanded[item.id] = !explorerHierarchy.expanded[item.id];
            updateExplorer(); 
        };
        itemEl.appendChild(arrow);
    } else {
        // Add empty space for items without arrow
        const emptySpace = document.createElement('div');
        emptySpace.style.width = '12px';
        emptySpace.style.display = 'inline-block';
        itemEl.appendChild(emptySpace);
    }
    
    // Icon for the item - includes animated preview for image assets
    const iconSpan = document.createElement('span');
    iconSpan.style.cssText = 'margin-right: 5px; display: inline-flex; align-items: center; vertical-align: middle;';
    
    if ((item.type === 'image' || item.type === 'texture') && item.properties?.imageId && state.imageAssets[item.properties.imageId]) {
        const asset = state.imageAssets[item.properties.imageId];
        const preview = document.createElement('img');
        preview.style.cssText = 'width: 14px; height: 14px; background: #fff; border-radius: 2px; object-fit: contain;';
        preview.src = asset.frames[0];
        
        if (asset.frames.length > 1) {
            let frameIdx = 0;
            const interval = setInterval(() => {
                // Automatically clear the interval if the explorer item is re-rendered or removed
                if (!preview.closest('body')) {
                    clearInterval(interval);
                    return;
                }
                frameIdx = (frameIdx + 1) % asset.frames.length;
                preview.src = asset.frames[frameIdx];
            }, 1000);
        }
        iconSpan.appendChild(preview);
    } else {
        const icons = {
            'folder': '📁',
            'model': '🎁',
            'object': '🟦',
            'light': '💡',
            'effect': '✨',
            'frame': '⬛',
            'spawn': '🚩',
            'textlabel': '📄',
            'sound': '🔊',
            'billboard': '📺',
            'camera': '📷',
            'text': '🔤',
            'image': '🖼️',
            'texture': '🏁',
            'sky': '🌌',
        };
        iconSpan.innerText = icons[item.type] || icons['object'];
    }
    itemEl.appendChild(iconSpan);
    
    // Item name
    if (renamingItemId === item.id) {
        const input = document.createElement('input');
        input.type = 'text';
        input.value = item.name;
        input.style.cssText = 'flex: 1; background: #333; color: #fff; border: 1px solid #00ff88; padding: 1px 4px; outline: none; font-family: inherit; font-size: 12px; border-radius: 2px;';
        
        const save = () => {
            const trimmed = input.value.trim();
            if (trimmed && renamingItemId === item.id) {
                item.name = trimmed;
                if (item.objectRef) item.objectRef.name = trimmed;
                refreshSceneState();
                showInspector();
            }
            renamingItemId = null;
            updateExplorer();
        };

        input.onkeydown = (e) => {
            if (e.key === 'Enter') save();
            if (e.key === 'Escape') { renamingItemId = null; updateExplorer(); }
            e.stopPropagation();
        };
        input.onblur = save;
        itemEl.appendChild(input);
        setTimeout(() => { input.focus(); input.select(); }, 0);
    } else {
        const nameSpan = document.createElement('span');
        nameSpan.innerText = item.name;
        nameSpan.style.flex = '1';
        itemEl.appendChild(nameSpan);
    }
    
    // Plus button
    const plus = document.createElement('div');
    plus.className = 'exp-plus';
    plus.innerText = '+';
    plus.onclick = (e) => {
        e.stopPropagation();
        currentContextId = item.id;
        
        // Show all possible items regardless of context
        const menuItems = [
            { type: 'create', label: '🟦 Object', objectType: 'Object' },
            { type: 'create', label: '📁 Folder', objectType: 'Folder' },
            { type: 'create', label: '🎁 Model', objectType: 'Model' },
            { type: 'create', label: '💡 Light', objectType: 'Light' },
            { type: 'create', label: '🔊 Sound', objectType: 'Sound' },
            { type: 'create', label: '📺 Billboard', objectType: 'Billboard' },
            { type: 'create', label: '📷 Camera', objectType: 'Camera' },
            { type: 'create', label: '🚩 Player Spawn', objectType: 'PlayerSpawn' },
            { type: 'create', label: '🏁 Texture', objectType: 'Texture' },
            { type: 'create', label: '💫 Particles', objectType: 'ParticleEmitter' },
            { type: 'divider' },
            { type: 'create', label: '✨ Bloom', objectType: 'Bloom' },
            { type: 'create', label: '🌫️ Fog', objectType: 'Fog' },
            { type: 'create', label: '☀️ Sun Rays', objectType: 'SunRays' },
            { type: 'create', label: '🌓 Ambient Occlusion', objectType: 'AmbientOcclusion' },
            { type: 'create', label: '🌌 Sky', objectType: 'Sky' },
            { type: 'divider' },
            { type: 'create', label: '📄 Text Frame', objectType: 'TextLabel' },
            { type: 'create', label: '🔤 Text', objectType: 'Text' },
            { type: 'create', label: '⬛ Frame', objectType: 'Frame' },
            { type: 'create', label: '🖼️ Image', objectType: 'Image' },
        ];

        
        // Build HTML
        let menuHtml = '';
        menuItems.forEach((menuItem, index) => {
            if (menuItem.type === 'divider') {
                menuHtml += `<div style="border-top: 1px solid #444; margin: 5px 0;"></div>`;
                return;
            }
            menuHtml += `<div class="menu-item" data-explorer-index="${index}">${menuItem.label}</div>`;
        });
        
        explorerMenu.innerHTML = menuHtml;
        
        // Attach event listeners
        menuItems.forEach((menuItem, index) => {
            if (menuItem.type === 'divider') return;
            const element = explorerMenu.querySelector(`[data-explorer-index="${index}"]`);
            if (element) {
                element.onclick = (e) => {
                    e.stopPropagation();
                    createObjectInFolder(currentContextId, menuItem.objectType);
                    explorerMenu.style.display = 'none';
                };
            }
        });
        
        explorerMenu.style.display = 'block';
        
        // Position menu and keep it on screen
        let left = e.pageX;
        let top = e.pageY;
        explorerMenu.style.left = left + 'px';
        explorerMenu.style.top = top + 'px';
        
        // Adjust if off screen (forced reflow for accurate measurements)
        explorerMenu.offsetHeight; // Force reflow
        const rect = explorerMenu.getBoundingClientRect();
        if (rect.right > window.innerWidth) {
            explorerMenu.style.left = (window.innerWidth - rect.width - 10) + 'px';
        }
        if (rect.bottom > window.innerHeight) {
            explorerMenu.style.top = (window.innerHeight - rect.height - 10) + 'px';
        }
    };
    itemEl.appendChild(plus);
    
    // Right-click context menu for folders/models
    itemEl.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();

        const isObjectInCurrentSelection = item.objectRef && state.selectedObjects.includes(item.objectRef);
        const isItemSelected = state.selectedItems.has(item);
        const isMultiSelectionActive = state.selectedItems.size > 1;

        if (!(isMultiSelectionActive && (isObjectInCurrentSelection || isItemSelected))) {
            selectHierarchyItem(item, e.shiftKey);
        }
        showRightClickMenu(e.pageX, e.pageY, item.id);
    });
    
    // Click to select object (or select all in container)
    itemEl.onclick = (e) => {
        if (e.target.tagName === 'INPUT') return;
        e.stopPropagation();

        const now = Date.now();
        const isSelected = state.currentSelectedItem === item;

        // If an image or texture is already selected, clicking it again within 2 seconds opens the tab
        if ((item.type === 'image' || item.type === 'texture') && isSelected && !e.shiftKey) {
            if (now - state.lastClickTime < 2000) {
                const assetId = item.properties?.imageId;
                if (assetId) {
                    makeTabPersistent(assetId);
                    switchTab(assetId);
                    state.lastClickTime = 0;
                    return;
                }
            }
        }

        // If a sound is already selected, clicking it again within 2 seconds opens the tab
        if (item.type === 'sound' && isSelected && !e.shiftKey) {
            if (now - state.lastClickTime < 2000) {
                const assetId = item.properties?.soundId;
                if (assetId) {
                    makeTabPersistent(assetId);
                    switchTab(assetId);
                    state.lastClickTime = 0;
                    return;
                }
            }
        }

        state.lastClickTime = now;
        // Use the centralized hierarchy selection logic
        selectHierarchyItem(item, e.shiftKey);
    };

    itemEl.ondblclick = (e) => {
        e.stopPropagation();
        if ((item.type === 'image' || item.type === 'texture') && item.properties?.imageId) {
            makeTabPersistent(item.properties.imageId);
            switchTab(item.properties.imageId);
        } else if (item.type === 'sound' && item.properties?.soundId) {
            makeTabPersistent(item.properties.soundId);
            switchTab(item.properties.soundId);
        }
    };
    
    // Drag and drop
    itemEl.addEventListener('dragstart', (e) => {
        draggedItemId = item.id;
        e.dataTransfer.effectAllowed = 'move';
    });
    
    itemEl.addEventListener('dragover', (e) => {
        e.preventDefault(); // Allow drop
        e.dataTransfer.dropEffect = 'move';
        itemEl.style.backgroundColor = 'rgba(0, 255, 136, 0.2)'; // Visual feedback
    });
    
    itemEl.addEventListener('dragleave', () => {
        itemEl.style.backgroundColor = '';
    });
    
    itemEl.addEventListener('drop', (e) => {
        e.stopPropagation();
        itemEl.style.backgroundColor = '';
        
        if (draggedItemId && draggedItemId !== item.id) {
            explorerHierarchy.moveItem(draggedItemId, item.id);
            refreshSceneState();
            updateExplorer();
        }
        draggedItemId = null;
    });
    
    container.appendChild(itemEl);
    
    // Render children
    if (item.children && explorerHierarchy.expanded[item.id]) {
        const childrenContainer = document.createElement('div');
        childrenContainer.className = 'exp-children';
        item.children.forEach(child => {
            childrenContainer.appendChild(renderExplorerItem(child, depth + 1));
        });
        container.appendChild(childrenContainer);
    }
    
    return container;
}

/**
 * Searches up the hierarchy to find the highest Model ancestor for an item.
 */
export function findModelParent(itemId) {
    let currentId = itemId;
    let modelItem = null;
    while (currentId) {
        const parent = findParentItem(currentId);
        if (!parent) break;
        if (parent.type === 'model') modelItem = parent;
        currentId = parent.id;
    }
    return modelItem;
}

/**
 * Centralized logic for selecting items in the Explorer.
 * Handles recursive selection for Folders/Models and synchronization with 3D view.
 */
export function selectHierarchyItem(item, isMulti = false) {
    if (!item) return;
    if (!isMulti) clearSelection();

    const isSelected = state.selectedItems.has(item);

    const toggle = (target, forceAdd = false) => {
        // Include audioRef in selection so it can be moved with the gizmo tools
        let objects = [];
        if (target.objectRef) objects.push(target.objectRef);
        else if (target.audioRef) objects.push(target.audioRef);
        else objects = explorerHierarchy.getAllObjectsInItem(target.id);

        if (isSelected && isMulti && !forceAdd) {
            state.selectedItems.delete(target);
            state.selectedObjects = state.selectedObjects.filter(obj => !objects.includes(obj));
        } else {
            state.selectedItems.add(target);
            objects.forEach(obj => { if (!state.selectedObjects.includes(obj)) state.selectedObjects.push(obj); });
        }
        if (target.children) target.children.forEach(child => toggle(child, true));
    };

    toggle(item);
    state.currentSelectedItem = item;

    // Tab Management for Image Elements - Open temporary tab immediately on selection
    if (item.type === 'image' || item.type === 'texture' || (item.type === 'effect' && item.subType === 'particle')) {
        const assetId = item.properties?.imageId;
        if (assetId) {
            if (!state.openTabs.find(t => t.id === assetId)) {
                state.openTabs.push({ 
                    id: assetId, 
                    name: state.imageAssets[assetId]?.name || 'New Image', 
                    persistent: false 
                });
                updateTabs();
                // updateTabs(); // Redundant, as updateTabs() is called at the end of this function
            }
        } else {
            // If no image is selected, ensure no temporary asset tabs are lingering from previous selections
            state.openTabs = state.openTabs.filter(tab => tab.persistent || tab.id === 'game-editor');
            if (state.activeTabId !== 'game-editor' && !state.openTabs.find(t => t.id === state.activeTabId)) {
                switchTab('game-editor');
            }
        }
    }

    // Tab Management for Sound Elements
    if (item.type === 'sound') {
        const assetId = item.properties?.soundId;
        if (assetId) {
            const existingTab = state.openTabs.find(t => t.id === assetId);
            if (existingTab) {
                // If a temporary tab exists, update the name just in case
                existingTab.name = state.soundAssets[assetId]?.name || 'New Sound';
            } else {
                state.openTabs.push({ 
                    id: assetId, 
                    name: state.soundAssets[assetId]?.name || 'New Sound', 
                    persistent: false 
                });
            }
        } else {
            state.openTabs = state.openTabs.filter(tab => tab.persistent || tab.id === 'game-editor');
            if (state.activeTabId !== 'game-editor' && !state.openTabs.find(t => t.id === state.activeTabId)) {
                switchTab('game-editor');
            }
        }
    }

    // Auto-close non-persistent tabs
    state.openTabs = state.openTabs.filter(tab => {
        if (tab.persistent || tab.id === 'game-editor' || tab.id === state.activeTabId) return true;
        // Keep open if any selected image element uses this asset
        const inSelection = Array.from(state.selectedItems).some(i => 
            (i.type === 'image' || i.type === 'texture' || (i.type === 'effect' && i.subType === 'particle')) && i.properties?.imageId === tab.id);
        const inSoundSelection = Array.from(state.selectedItems).some(i => i.type === 'sound' && i.properties?.soundId === tab.id);
        return inSelection || inSoundSelection;
    });
    
    if (!state.openTabs.find(t => t.id === state.activeTabId)) switchTab('game-editor');
    updateTabs();

    if (state.selectedObjects.length > 0) attachTool(null, true);
    else {
        transformControls.detach();
        scaleHandles.visible = false;
        selectionBox.visible = false;
    }

    showInspector();
    updateExplorer();
    refreshSceneState();
}

export function findParentItem(itemId) {
    const search = (items, parent = null) => {
        for (let item of items) {
            if (item.id === itemId) return parent;
            if (item.children) {
                const found = search(item.children, item);
                if (found) return found;
            }
        }
        return null;
    };
    return search(explorerHierarchy.items);
}

// Memoized cache for object->id mapping to avoid recursive searches
const objectIdCache = new Map();

export function findItemIdForObject(obj) {
    if (!obj) return null;
    let curr = obj;
    while (curr) {
        if (objectIdCache.has(curr)) return objectIdCache.get(curr);
        
        const search = (items) => {
            for (let item of items) {
                if (item.objectRef === curr || item.audioRef === curr) {
                    objectIdCache.set(curr, item.id);
                    return item.id;
                }
                if (item.children) {
                    const found = search(item.children);
                    if (found) return found;
                }
            }
            return null;
        };
        const id = search(explorerHierarchy.items);
        if (id) return id;
        curr = curr.parent;
    }
    return null;
}

export function updateExplorer() {
    if (state.isPastingOrDuplicating) return;
    
    explorerList.innerHTML = '';
    explorerHierarchy.items.forEach(item => {
        explorerList.appendChild(renderExplorerItem(item, 0));
    });
}

/**
 * Updates the UV coordinates of a BoxGeometry to prevent texture stretching.
 * Tiles the texture based on the physical world scale of the object.
 */
export function updateObjectUVs(obj, hierarchyItem = null) {
    if (!obj || !obj.geometry || !obj.geometry.attributes.uv) return;

    // Force matrix update to ensure getWorldScale is accurate
    obj.updateMatrixWorld(true);

    const geometry = obj.geometry;
    const uvAttr = geometry.attributes.uv;

    if (!geometry.attributes.uv_orig) {
        geometry.attributes.uv_orig = geometry.attributes.uv.clone();
    }
    const baseUvAttr = geometry.attributes.uv_orig;

    const item = hierarchyItem || explorerHierarchy.findItemById(findItemIdForObject(obj));
    const surfaceDescendants = item ? getSurfaceDescendants(item) : [];

    const faceGroups = {};
    surfaceDescendants.forEach(child => {
        const f = child.properties?.face || 'Front';
        if (!faceGroups[f]) faceGroups[f] = true;
    });

    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const geomSize = new THREE.Vector3();
    geometry.boundingBox.getSize(geomSize);

    const worldScale = new THREE.Vector3();
    obj.getWorldScale(worldScale);

    // Calculate absolute world dimensions (Geometry Base Size * Object Scale)
    const absW = Math.max(0.01, geomSize.x * worldScale.x);
    const absH = Math.max(0.01, geomSize.y * worldScale.y);
    const absD = Math.max(0.01, geomSize.z * worldScale.z);

    const tx = obj.userData.tileScaleX ?? 1;
    const ty = obj.userData.tileScaleY ?? 1;
    const isBox = geometry.type === 'BoxGeometry';

    if (isBox) {
        if (!geometry.attributes.normal) geometry.computeVertexNormals();

        const normals = geometry.attributes.normal;

        // Map face orientation => [uWorldSize, vWorldSize]
        // Local axes meaning:
        //  - ±X faces: use Z (width) and Y (height)
        //  - ±Y faces: use X (width) and Z (height)
        //  - ±Z faces: use X (width) and Y (height)
        const scaleForNormal = (nx, ny, nz) => {
            const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
            if (ax >= ay && ax >= az) return [absD, absH]; // ±X
            if (ay >= ax && ay >= az) return [absW, absD]; // ±Y (top/bottom)
            return [absW, absH]; // ±Z
        };

        const getFaceName = (nx, ny, nz) => {
            const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
            if (ax >= ay && ax >= az) return nx > 0 ? 'Right' : 'Left';
            if (ay >= ax && ay >= az) return ny > 0 ? 'Top' : 'Bottom';
            return nz > 0 ? 'Front' : 'Back';
        };

        for (let i = 0; i < uvAttr.count; i++) {
            const nx = normals.getX(i);
            const ny = normals.getY(i);
            const nz = normals.getZ(i);
            
            const faceName = getFaceName(nx, ny, nz);

            let tx = obj.userData.tileScaleX ?? 1;
            let ty = obj.userData.tileScaleY ?? 1;

            const [uWorld, vWorld] = scaleForNormal(nx, ny, nz);
            const repU = tx === 0 ? 1 : uWorld / tx;
            const repV = ty === 0 ? 1 : vWorld / ty;

            uvAttr.setXY(i, baseUvAttr.getX(i) * repU, baseUvAttr.getY(i) * repV);
        }
    }

    // Efficiently update repeat only if the geometry scale actually changes
    obj.children.forEach(child => {
        if (child.userData.isSurfaceOverlay && child.material && child.material.map && !child.material.map.isCanvasTexture) {
            const faceName = child.userData.face;
            const texItem = surfaceDescendants.find(c => c.type === 'texture' && (c.properties?.face || 'Front') === faceName);
            const childGeo = child.geometry;
            const childUvAttr = childGeo.attributes.uv;
            const childBaseUvAttr = childGeo.attributes.uv_orig || childUvAttr.clone();
            if (!childGeo.attributes.uv_orig) childGeo.attributes.uv_orig = childBaseUvAttr;
            
            if (texItem) {
                const p = texItem.properties || {};
                let faceW, faceH;
                if (faceName === 'Top' || faceName === 'Bottom') { faceW = absW; faceH = absD; }
                else if (faceName === 'Left' || faceName === 'Right') { faceW = absD; faceH = absH; }
                else { faceW = absW; faceH = absH; }

                const repU = faceW / (p.tileX || 1);
                const repV = faceH / (p.tileY || 1);

                if (isBox) {
                    child.material.map.repeat.set(repU, repV);
                } else {
                    // UNIVERSAL MAPPING: Apply Planar Projection to Spheres/Cylinders
                    // This forces the texture to wrap correctly on specific "faces" of primitives
                    const normals = childGeo.attributes.normal;
                    const positions = childGeo.attributes.position;
                    const conf = FACE_CONFIG[faceName];
                    const normal = new THREE.Vector3(...conf.normal);

                    for (let i = 0; i < childUvAttr.count; i++) {
                        const vNormal = new THREE.Vector3(normals.getX(i), normals.getY(i), normals.getZ(i));
                        const dot = vNormal.dot(normal);
                        
                        if (dot > 0.1) { // Vertex faces the correct direction
                            const posX = positions.getX(i);
                            const posY = positions.getY(i);
                            const posZ = positions.getZ(i);
                            
                            let u, v;
                            if (faceName === 'Top' || faceName === 'Bottom') { u = posX + 0.5; v = posZ + 0.5; }
                            else if (faceName === 'Left' || faceName === 'Right') { u = posZ + 0.5; v = posY + 0.5; }
                            else { u = posX + 0.5; v = posY + 0.5; }
                            
                            childUvAttr.setXY(i, u * repU, v * repV);
                        } else {
                            // Hide texture on the "wrong" side by pushing UVs to a transparent/edge pixel
                            childUvAttr.setXY(i, -10, -10);
                        }
                    }
                    childUvAttr.needsUpdate = true;
                }
            }
        }
    });

    // Recalculate tangents and normals so 3D displacement and lighting follow the tiled UVs correctly.
    // This prevents stretching/lighting artifacts on non-uniformly scaled parts.
    // Optimized: Only recompute if scaling or modified via code.
    if (geometry.attributes.position && (state.isDraggingObject || state.activeHandle)) {
        if (geometry.type !== 'BoxGeometry') geometry.computeVertexNormals();
        if (geometry.index) geometry.computeTangents();
    }

    uvAttr.needsUpdate = true;
}

function safeSetInput(input, value) {
    if (!input || document.activeElement === input) return;
    input.value = value;
}


export function updatePropertyValues() {
    const currentItem = state.currentSelectedItem;
    const uiTypes = ['textlabel', 'textbutton', 'frame', 'text', 'framebutton', 'image'];
    const isUI = currentItem && uiTypes.includes(currentItem.type);

    if (isUI) {
        const p = currentItem.properties || {};
        safeSetInput(posInputs.x, (p.posX || 0).toFixed(0));
        safeSetInput(posInputs.y, (p.posY || 0).toFixed(0));
        safeSetInput(scaleInputs.x, (p.sizeX || 100).toFixed(0));
        safeSetInput(scaleInputs.y, (p.sizeY || 50).toFixed(0));
        safeSetInput(rotInputs.x, (p.rotation || 0).toFixed(0));
        safeSetInput(opacityInput, (p.opacity ?? 1));
        return;
    }

    if (state.selectedObjects.length === 0) {
        if (currentItem && (surfaceTypes.includes(currentItem.type))) {
            safeSetInput(opacityInput, (currentItem.properties.opacity ?? 1));
        }
        return;
    }
    
    let worldPos = new THREE.Vector3();
    let worldQuat = new THREE.Quaternion();
    let worldScale = new THREE.Vector3();
    let worldEuler = new THREE.Euler();
    
    if (state.selectedObjects.length > 0) {
        // We pick the primary object for property display
        const obj = state.selectedObjects[0];
        
        // Force a matrix update so world scale/pos is fresh even if recently moved/parented
        obj.updateMatrixWorld(true);

        obj.getWorldPosition(worldPos);
        if (obj.getWorldQuaternion) obj.getWorldQuaternion(worldQuat); 
        obj.getWorldScale(worldScale);

        if (obj.isLight) return; 

        // Only set material properties if the object actually has a material
        if (obj.material) {
            anchoredInput.checked = obj.userData.anchored !== false;
            collideInput.checked = obj.userData.canCollide !== false;
            if (castShadowInput) castShadowInput.checked = obj.castShadow !== false;
            const r100 = (obj.userData.roughness100 !== undefined)
                ? obj.userData.roughness100
                : (((obj.material && obj.material.roughness !== undefined) ? obj.material.roughness : 0.8) * 100);
// UI expects 0..10 where 10 maps to 100
            roughnessInput.value = Number(r100 / 10).toFixed(1);

            // IMPORTANT: prop-reflection no longer changes physical roughness/metalness,
            // so after re-syncing UI, we restore the physical roughness from roughnessInput.
            // (This keeps the “shine” controlled only by prop-roughness.)
            if (obj.material && obj.userData.roughness100 !== undefined) {
                obj.material.roughness = clamp01(obj.userData.roughness100 / 100);
                obj.material.needsUpdate = true;
            }
            safeSetInput(normalInput, (obj.material && obj.material.normalScale) ? obj.material.normalScale.x : 0.5);
            safeSetInput(opacityInput, obj.userData.opacity !== undefined ? obj.userData.opacity : 1);
            if (obj.material && obj.material.transparent) {
                obj.material.opacity = parseFloat(opacityInput.value) || 1;
            }
            safeSetInput(tileScaleXInput, obj.userData.tileScaleX || 1);
            safeSetInput(tileScaleYInput, obj.userData.tileScaleY || 1);
            const refl = obj.userData.reflectiveness ?? 0;
            safeSetInput(reflectionInput, refl);
        }
        safeSetInput(densityInput, obj.userData.density !== undefined ? obj.userData.density : 10);

    } else {

        // For multi-select, read the center of the selection group
        worldPos.copy(selectionGroup.position);
        worldQuat.copy(selectionGroup.quaternion);
        worldScale.copy(selectionGroup.scale);
        anchoredInput.checked = state.selectedObjects.every(o => o.userData.anchored !== false);
        collideInput.checked = state.selectedObjects.every(o => o.userData.canCollide !== false);
        if (castShadowInput) castShadowInput.checked = state.selectedObjects.every(o => o.castShadow !== false);
        if (densityInput) {
            const firstDensity = state.selectedObjects[0].userData.density ?? 10;
            const sameDensity = state.selectedObjects.every(o => (o.userData.density ?? 10) === firstDensity);
            safeSetInput(densityInput, sameDensity ? firstDensity : "");
        }

    }
    
    worldEuler.setFromQuaternion(worldQuat);

    safeSetInput(posInputs.x, worldPos.x.toFixed(2));
    safeSetInput(posInputs.y, worldPos.y.toFixed(2));
    safeSetInput(posInputs.z, worldPos.z.toFixed(2));

    safeSetInput(rotInputs.x, THREE.MathUtils.radToDeg(worldEuler.x).toFixed(0));
    safeSetInput(rotInputs.y, THREE.MathUtils.radToDeg(worldEuler.y).toFixed(0));
    safeSetInput(rotInputs.z, THREE.MathUtils.radToDeg(worldEuler.z).toFixed(0));

    safeSetInput(scaleInputs.x, worldScale.x.toFixed(2));
    safeSetInput(scaleInputs.y, worldScale.y.toFixed(2));
    safeSetInput(scaleInputs.z, worldScale.z.toFixed(2));

    // Recalculate UVs whenever properties (like scale) change
    state.selectedObjects.forEach(obj => {
        if (obj.isMesh) updateObjectUVs(obj);
    });
}


nameInput.oninput = () => {
    if (state.currentSelectedItem) {
        state.currentSelectedItem.name = nameInput.value;
        updateExplorer();
    } else if (state.selectedObjects.length === 1) {
        state.selectedObjects[0].name = nameInput.value;
        updateExplorer();
    }
};

const handleManualInput = () => {
    const currentItem = state.currentSelectedItem;
    const uiTypes = ['textlabel', 'textbutton', 'frame', 'text', 'framebutton', 'image'];
    const isUI = currentItem && uiTypes.includes(currentItem.type);

    if (isUI) {
        currentItem.properties.posX = Math.round(parseFloat(posInputs.x.value)) || 0;
        currentItem.properties.posY = Math.round(parseFloat(posInputs.y.value)) || 0;
        currentItem.properties.sizeX = Math.round(parseFloat(scaleInputs.x.value)) || 0;
        currentItem.properties.sizeY = Math.round(parseFloat(scaleInputs.y.value)) || 0;
        currentItem.properties.rotation = Math.round(parseFloat(rotInputs.x.value)) || 0;
        refreshSceneState();
        return;
    }

    if (state.selectedObjects.length === 0) return;
    
    const parse = (val) => {
        const f = parseFloat(val);
        return isNaN(f) ? null : f;
    };

    // Snap position inputs
    const rawPx = parse(posInputs.x.value), rawPy = parse(posInputs.y.value), rawPz = parse(posInputs.z.value);
    if (rawPx === null || rawPy === null || rawPz === null) return;

    selectionGroup.position.set(rawPx, rawPy, rawPz);
    
    // Sync manual transform inputs back to Sound properties so they save
    if (currentItem && currentItem.type === 'sound') {
        currentItem.properties.posX = rawPx;
        currentItem.properties.posY = rawPy;
        currentItem.properties.posZ = rawPz;
        refreshSceneState();
    }

    // Snap rotation inputs using Rotation Snap
    const rawRx = parse(rotInputs.x.value), rawRy = parse(rotInputs.y.value), rawRz = parse(rotInputs.z.value);
    if (rawRx === null || rawRy === null || rawRz === null) return;

    selectionGroup.rotation.set(THREE.MathUtils.degToRad(rawRx), THREE.MathUtils.degToRad(rawRy), THREE.MathUtils.degToRad(rawRz));

    // Snap scale inputs
    const rawSx = parse(scaleInputs.x.value), rawSy = parse(scaleInputs.y.value), rawSz = parse(scaleInputs.z.value);
    if (rawSx === null || rawSy === null || rawSz === null) return;

    if (state.selectedObjects.length === 1) {
        const obj = state.selectedObjects[0];
        selectionGroup.scale.set(rawSx / Math.max(0.0001, obj.scale.x), rawSy / Math.max(0.0001, obj.scale.y), rawSz / Math.max(0.0001, obj.scale.z));
    } else {
        selectionGroup.scale.set(rawSx, rawSy, rawSz);
    }
    if (state.currentMode === 'scale') updateScaleHandles();
    // Ensure materials and gizmos update when typing values manually
    updatePropertyValues();
};

[...Object.values(posInputs), ...Object.values(rotInputs), ...Object.values(scaleInputs)].forEach(input => {
    input.oninput = handleManualInput;
});

collideInput.onchange = () => {
    state.selectedObjects.forEach(obj => {
        obj.userData.canCollide = collideInput.checked;
    updatePropertyValues();
    });
};

colorPicker.onchange = () => {
    // Heavy refresh (Surface UI rebake) only on mouse up
    state.selectedItems.forEach(item => refreshSceneState(item));
};

if (castShadowInput) {
    castShadowInput.onchange = () => {
        state.selectedObjects.forEach(obj => {
            obj.castShadow = castShadowInput.checked;
            obj.userData.castShadow = castShadowInput.checked;
        updatePropertyValues();
        });
    };
}

opacityInput.oninput = () => {
    const opacityValue = parseFloat(opacityInput.value);
    if (isNaN(opacityValue)) return;

    if (state.currentSelectedItem && state.currentSelectedItem.properties) {
        state.currentSelectedItem.properties.opacity = opacityValue;
        refreshSceneState();
    }

    state.selectedObjects.forEach(obj => {
        obj.userData.opacity = opacityValue;
        if (obj.material) {
            const isTransparent = opacityValue < 1;
            obj.material.transparent = isTransparent;
            obj.material.opacity = opacityValue;
            obj.material.depthWrite = !isTransparent;
            obj.castShadow = !isTransparent; // Shadows disappear when object becomes transparent
            obj.castShadow = opacityValue > 0.5; // Shadows disappear at 0.5 opacity and lower
            obj.frustumCulled = !isTransparent; // Prevent popping at sharp angles for transparency
            obj.material.needsUpdate = true;
        }
    });
};

if (densityInput) {
    densityInput.oninput = () => {
        const val = parseFloat(densityInput.value);
        if (isNaN(val)) return;
        const densityValue = Math.max(0, Math.min(100, val));
        state.selectedObjects.forEach(obj => {
            obj.userData.density = densityValue;
        });
    };
}

roughnessInput.oninput = () => {
    // UI range 0..10 where 10 => 100 roughness (stored as roughness100)
    const roughnessValue = parseFloat(roughnessInput.value);
    if (isNaN(roughnessValue)) return;
    const r100 = Math.max(0, Math.min(100, (roughnessValue / 10) * 100));

    state.selectedObjects.forEach(obj => {
        if (!obj || !obj.material) return;

        obj.userData.roughness100 = r100;

        if (obj.material) {
            // Use Standard material even at max roughness to keep displacement support
            obj.material.roughness = clamp01(r100 / 100);

            // If 3D Normal is enabled, re-apply displacement settings
            obj.material.needsUpdate = true;
        }
    });
};




reflectionInput.oninput = () => {
    const val = parseFloat(reflectionInput.value);
    if (isNaN(val)) return;
    const reflectionValue = Math.max(0, Math.min(10, val));
    state.selectedObjects.forEach(obj => {
obj.userData.reflectiveness = reflectionValue;
        refreshSceneState();
    });
};

normalInput.oninput = () => {
    const normalValue = parseFloat(normalInput.value);
    if (isNaN(normalValue)) return;
    state.selectedObjects.forEach(obj => {
        if (!obj || !obj.material) return;
        obj.material.normalScale.set(normalValue, normalValue);
    });
};



// --- MATERIAL SYSTEM ---
const materialSelect = document.getElementById('prop-material');


const tileScaleXInput = document.getElementById('prop-tile-scale-x');
const tileScaleYInput = document.getElementById('prop-tile-scale-y');

export const materials = {
    // Keep this in sync with folders inside ./Materials
    list: ['Bricks', 'Concrete', 'DiamondPlate', 'Dirt', 'Fabric', 'Grass', 'Metal', 'Neon', 'Rust', 'Sand', 'Tile', 'Wood', 'WoodPlanks'],
    cache: {},
    textureLoader: new THREE.TextureLoader(),
    
    
    async loadMaterial(name) {
        if (this.cache[name]) return this.cache[name];

        // Neon: textures may not exist; still provide a usable emissive color.
        if (name === 'Neon') {
            const neonColor = new THREE.Color(0x00ff88);
            this.cache[name] = { neonColor };
            return this.cache[name];
        }

        try {
            const basePath = `./Materials/${name}/`;

            if (name === 'Bricks') {
                const [cementTex, bricksColorTex, roughnessTex, normalTex] = await Promise.all([
                    new Promise((res, rej) => this.textureLoader.load(`${basePath}${name}.png`, res, undefined, rej)),
                    new Promise((res, rej) => this.textureLoader.load(`${basePath}${name}Color.png`, res, undefined, rej)),
                    new Promise((res, rej) => this.textureLoader.load(`${basePath}${name}Roughness.png`, res, undefined, rej)),
                    new Promise((res, rej) => this.textureLoader.load(`${basePath}${name}Normal.png`, res, undefined, rej))
                ]);

                [cementTex, bricksColorTex, roughnessTex, normalTex].forEach(tex => {
                    tex.magFilter = THREE.LinearFilter;
                    tex.minFilter = THREE.LinearMipmapLinearFilter;
                    tex.colorSpace = tex === normalTex ? THREE.NoColorSpace : THREE.SRGBColorSpace;
                });

                this.cache[name] = { cementTex, bricksColorTex, roughnessTex, normalTex };
                return this.cache[name];
            }

            const [colorTex, roughnessTex, normalTex] = await Promise.all([
                new Promise((res, rej) => this.textureLoader.load(`${basePath}${name}.png`, res, undefined, rej)),
                new Promise((res, rej) => this.textureLoader.load(`${basePath}${name}Roughness.png`, res, undefined, rej)),
                new Promise((res, rej) => this.textureLoader.load(`${basePath}${name}Normal.png`, res, undefined, rej))
            ]);

            [colorTex, roughnessTex, normalTex].forEach(tex => {
                tex.magFilter = THREE.LinearFilter;
                tex.minFilter = THREE.LinearMipmapLinearFilter;
                tex.colorSpace = tex === normalTex ? THREE.NoColorSpace : THREE.SRGBColorSpace;
            });

            this.cache[name] = { colorTex, roughnessTex, normalTex };
            return this.cache[name];
        } catch (err) {
            console.warn(`Failed to load material ${name}:`, err);
            return null;
        }
    },


    
    applyToObject(obj, materialName, tileScaleX = 1, tileScaleY = 1) {
        const loadedMat = this.cache[materialName];
        if (!loadedMat) return false;

        const maxAnisotropy = renderer.capabilities?.getMaxAnisotropy?.() || 1;
        const setTiling = (tex) => {
            tex.repeat.set(1, 1);
            tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
            tex.anisotropy = maxAnisotropy;
            tex.generateMipmaps = true;
        };

        if (materialName === 'Bricks') {
            // Bricks should behave exactly like every other material:
            // use Bricks.png for albedo plus roughness + normal.

            const bricksTex = loadedMat.cementTex.clone();
            const roughnessTex = loadedMat.roughnessTex.clone();
            const normalTex = loadedMat.normalTex.clone();

            [bricksTex, roughnessTex, normalTex].forEach(setTiling);

            const opacity = obj.userData.opacity ?? 1;
            const isTransparent = opacity < 1;
            const roughnessVal = (obj.userData.roughness100 !== undefined) ? (obj.userData.roughness100 / 100) : 0.8;
            const baseColor = obj.userData.partColor ? new THREE.Color(obj.userData.partColor) : new THREE.Color(0xffffff);
            const mat = new THREE.MeshStandardMaterial({
                color: baseColor,
                map: bricksTex,
                roughnessMap: roughnessTex,
                roughness: roughnessVal,
                normalMap: normalTex,
                normalScale: new THREE.Vector2(0.5, 0.5),
                transparent: isTransparent,
                opacity: opacity,
                depthWrite: !isTransparent,
                shadowSide: THREE.DoubleSide, // Allows shadows to project inside hollow objects
                frustumCulled: !isTransparent,
                displacementMap: null, // Set via syncObjectDisplacement
                displacementScale: 0,
                displacementBias: 0
            });

            obj.material = mat;
            obj.castShadow = !isTransparent;
            obj.castShadow = opacity > 0.5;
            obj.userData.material = materialName;
            obj.userData.tileScaleX = tileScaleX;
            obj.userData.tileScaleY = tileScaleY;

            updateObjectUVs(obj);
            return true;
        }

        if (materialName === 'Neon') {
            // Neon in Roblox style: emissive + bloom glow.
            // This project’s Neon folder may not have textures, so we generate a glowing material.
            const baseColor = obj.userData.partColor ? new THREE.Color(obj.userData.partColor) :
                (obj.material?.color ? obj.material.color.clone() : new THREE.Color(0xffffff));
            const hex = "#" + baseColor.getHexString();

            // Use MeshBasicMaterial: it is "Unlit", meaning it ignores all scene lights and shadows.
            // This ensures every side of the part is the exact same color.
            const opacity = obj.userData.opacity ?? 1;
            const isTransparent = opacity < 1;
            const mat = new THREE.MeshBasicMaterial({
                color: baseColor,
                // We multiply the color components to push them into HDR range (> 1.0).
                // This makes the object "super bright" for the Bloom effect.
                toneMapped: false, 
                transparent: isTransparent,
                opacity: opacity,
                depthWrite: !isTransparent,
                shadowSide: THREE.DoubleSide,
                frustumCulled: !isTransparent
            });

            // Overdrive the color so it passes the bloom threshold even if it's a dark color
            mat.color.multiplyScalar(25);

            obj.material = mat;
            obj.userData.material = materialName;
            obj.userData.tileScaleX = tileScaleX;
            obj.userData.tileScaleY = tileScaleY;
            obj.userData.reflectiveness = 0;
            obj.userData.emissiveColorHex = hex;

            updateObjectUVs(obj);
            return true;
        }

        // --- Default materials ---
        const colorTex = loadedMat.colorTex.clone();
        const roughnessTex = loadedMat.roughnessTex.clone();
        const normalTex = loadedMat.normalTex.clone();

        [colorTex, roughnessTex, normalTex].forEach(setTiling);

        const opacity = obj.userData.opacity ?? 1;
        const isTransparent = opacity < 1;
        const roughnessVal = (obj.userData.roughness100 !== undefined) ? (obj.userData.roughness100 / 100) : 0.8;
        const baseColor = obj.userData.partColor ? new THREE.Color(obj.userData.partColor) : new THREE.Color(0xffffff);

        obj.material = new THREE.MeshStandardMaterial({
            color: baseColor,
            map: colorTex,
            roughnessMap: roughnessTex,
            roughness: roughnessVal,
            normalMap: normalTex,
            normalScale: new THREE.Vector2(0.5, 0.5),
            transparent: isTransparent,
            opacity: opacity,
            depthWrite: !isTransparent,
            shadowSide: THREE.DoubleSide
        });
        obj.frustumCulled = !isTransparent;
        obj.castShadow = !isTransparent;
        obj.castShadow = opacity > 0.5;

        obj.material.needsUpdate = true;

        obj.userData.material = materialName;
        obj.userData.tileScaleX = tileScaleX;
        obj.userData.tileScaleY = tileScaleY;

        updateObjectUVs(obj);
        return true;
    }
};


// Initialize material dropdown
async function initMaterialDropdown() {
    materialSelect.innerHTML = '<option value="">None</option>';
    
    // Pre-load all materials
    for (const matName of materials.list) {
        await materials.loadMaterial(matName);
        const option = document.createElement('option');
        option.value = matName;
        option.textContent = matName;
        materialSelect.appendChild(option);
    }
}

materialSelect.onchange = () => {
    if (state.selectedObjects.length === 0) return;

    const materialName = materialSelect.value;
    const valX = parseFloat(tileScaleXInput.value);
    const valY = parseFloat(tileScaleYInput.value);
    const tx = isNaN(valX) ? 1 : valX;
    const ty = isNaN(valY) ? 1 : valY;

    state.selectedObjects.forEach(obj => {
        if (!obj) return;

        if (materialName === '') {
            // Remove material: create a fresh base material so Neon doesn't “stick”
            const opacity = obj.userData.opacity ?? 1;
            const isTransparent = opacity < 1;
            obj.material = new THREE.MeshStandardMaterial({
                color: 0xffffff,
                transparent: isTransparent,
                opacity: opacity,
                depthWrite: !isTransparent,
                shadowSide: THREE.DoubleSide,
                roughness: 0.8,
                metalness: 0,
            });
            obj.frustumCulled = !isTransparent;
            obj.castShadow = !isTransparent;
            obj.castShadow = opacity > 0.5;
            obj.userData.originalMap = null;

            obj.userData.material = '';
            obj.userData.emissiveColorHex = undefined;
            obj.userData.tileScaleX = tx;
            obj.userData.tileScaleY = ty;
            obj.material.needsUpdate = true;
            return;
        }

        materials.applyToObject(obj, materialName, tx, ty);
    });
};

const handleTileUpdate = () => {
    if (state.selectedObjects.length === 0 || !materialSelect.value) return;
    const valX = parseFloat(tileScaleXInput.value);
    const valY = parseFloat(tileScaleYInput.value);
    const tx = isNaN(valX) ? 1 : valX;
    const ty = isNaN(valY) ? 1 : valY;
    state.selectedObjects.forEach(obj => {
        obj.userData.tileScaleX = tx;
        obj.userData.tileScaleY = ty;
        updateObjectUVs(obj);
    });
};
tileScaleXInput.oninput = handleTileUpdate;
tileScaleYInput.oninput = handleTileUpdate;



// Initialize on load
initMaterialDropdown();


function createPropertyControl(label, value, type, onChange) {
    const container = document.createElement('div');
    container.className = 'prop-group';
    
    // For boolean (checkbox) properties, place the checkbox UNDER the label
    // so it visually stacks like a mini column in the inspector.
    if (type === 'boolean') {
        container.style.display = 'flex';
        container.style.flexDirection = 'column';
        container.style.alignItems = 'flex-start';
        container.style.gap = '4px';
        // keep the checkbox group height tight
        container.style.paddingTop = '2px';
    }

    
    const labelEl = document.createElement('label');
    labelEl.className = 'prop-label';
    if (type === 'boolean') {
        labelEl.style.marginBottom = '0';
    }
    const displayLabel = label.replace(/([A-Z])/g, ' $1')
                               .replace(/^./, str => str.toUpperCase());
    labelEl.innerText = displayLabel;
    
    const propId = label;

    container.appendChild(labelEl);

    const input = document.createElement('input');
    if (type === 'color') {
        input.type = 'color';
        input.value = value;
        input.style.cssText = 'width: 100%; height: 28px; border: none; background: none; cursor: pointer;';
    } else if (type === 'boolean') {
        input.type = 'checkbox';
        input.checked = value;
        input.id = `inspector-prop-${propId}`;
        input.className = 'prop-input';
        input.style.cssText = 'width: 18px; height: 18px; cursor: pointer; margin: 0;';
        input.style.cursor = 'pointer';
        input.style.cssText = 'width: 14px; height: 14px; cursor: pointer;';
        input.style.cssText = 'width: 14px; height: 14px; cursor: pointer; display: block;';
    } else if (type === 'text') {
        input.type = 'text';
        input.value = value;
        input.id = `inspector-prop-${propId}`;
        input.className = 'prop-input';
        input.style.width = '100%';
    } else {
        input.type = 'number';
        input.value = value;
        input.id = `inspector-prop-${propId}`;
        // Set step to 1 for 'order' property, otherwise 0.1 for general numbers
        const isUIProp = ['posX', 'posY', 'sizeX', 'sizeY', 'rotation'].includes(label);
        if (label === 'order' || isUIProp) {
            input.step = '1';
        } else {
            input.step = '0.1';
        }
        input.className = 'prop-input';
    }

    input.oninput = (e) => {
        let newVal;
        if (type === 'boolean') newVal = e.target.checked;
        else if (type === 'number') {
            newVal = parseFloat(e.target.value);
            if (isNaN(newVal)) return;
        } else {
            newVal = e.target.value;
        }
        onChange(newVal);

        // Sync Sound Editor if active
        if (state.activeTabId.startsWith('snd-')) {
            const editorInp = document.getElementById(`sound-editor-input-${propId}`);
            if (editorInp) editorInp.value = newVal;
        }
    };

    container.appendChild(input);
    return container;
}

function createDropdownPropertyControl(label, value, options, onChange) {
    const container = document.createElement('div');
    container.className = 'prop-group';
    
    const labelEl = document.createElement('label');
    labelEl.className = 'prop-label';
    labelEl.innerText = label.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase());
    container.appendChild(labelEl);

    const select = document.createElement('select');
    select.className = 'prop-input';
    select.style.width = '100%';
    
    options.forEach(opt => {
        const o = document.createElement('option');
        o.value = opt;
        o.innerText = opt;
        if (opt === value) o.selected = true;
        select.appendChild(o);
    });

    select.onchange = (e) => onChange(e.target.value);
    container.appendChild(select);
    return container;
}

function createImageAssetDropdown(currentItem, labelText = 'Image', propKey = 'imageId') {
    const container = document.createElement('div');
    container.className = 'prop-group';
    const label = document.createElement('label');
    label.className = 'prop-label';
    label.innerText = labelText;
    container.appendChild(label);

    const selectWrapper = document.createElement('div');
    selectWrapper.style.cssText = 'position: relative; background: #1a1a1a; border: 1px solid #444; border-radius: 4px; margin-top: 4px; cursor: pointer;';

    // Dropdown Header (Current Selection)
    const header = document.createElement('div');
    header.style.cssText = 'padding: 2px 8px; display: flex; align-items: center; justify-content: space-between; height: 20px; font-size: 11px;';
    const currentAsset = state.imageAssets[currentItem.properties[propKey]];
    header.innerHTML = `<span>${currentAsset ? currentAsset.name : '<i>None</i>'}</span><span style="font-size: 10px;">▼</span>`;
    selectWrapper.appendChild(header);

    // Dropdown Menu (Options)
    const menu = document.createElement('div');
    menu.style.cssText = 'position: absolute; top: 100%; left: -1px; width: calc(100% + 2px); background: #222; border: 1px solid #444; border-radius: 0 0 4px 4px; z-index: 2000; display: none; max-height: 300px; overflow-y: auto; box-shadow: 0 4px 10px rgba(0,0,0,0.5); font-size: 11px;';
    selectWrapper.appendChild(menu);

    let intervals = [];
    const cleanup = () => {
        intervals.forEach(clearInterval);
        intervals = [];
    };

    const toggleMenu = (e) => {
        e.stopPropagation();
        const isOpen = menu.style.display === 'block';
        cleanup();
        if (!isOpen) {
            renderMenuOptions();
            menu.style.display = 'block';
        } else {
            menu.style.display = 'none';
        }
    };

    selectWrapper.onclick = toggleMenu;
    document.addEventListener('click', () => { menu.style.display = 'none'; cleanup(); });

    const renderMenuOptions = () => {
        menu.innerHTML = '';

        const createItem = (label, onClick, assetId = null) => {
            const item = document.createElement('div');
            item.style.cssText = 'padding: 4px 8px; display: flex; align-items: center; gap: 10px; border-bottom: 1px solid #333;';
            item.onmouseover = () => item.style.background = '#333';
            item.onmouseout = () => item.style.background = 'transparent';

            if (assetId) {
                const preview = document.createElement('img');
                preview.style.cssText = 'width: 18px; height: 18px; background: #fff; border-radius: 2px; object-fit: contain;';
                const asset = state.imageAssets[assetId];
                preview.src = asset.frames[0];
                
                // Frame Cycling Animation Logic
                if (asset.frames.length > 1) {
                    let frameIdx = 0;
                    const interval = setInterval(() => {
                        frameIdx = (frameIdx + 1) % asset.frames.length;
                        preview.src = asset.frames[frameIdx];
                    }, 1000);
                    intervals.push(interval);
                }
                item.appendChild(preview);
            }

            const text = document.createElement('span');
            text.innerText = label;
            text.style.flex = '1';
            item.appendChild(text);

            if (assetId) {
                const del = document.createElement('span');
                del.innerHTML = '🗑️';
                del.style.opacity = '0.5';
                del.onmouseover = () => del.style.opacity = '1';
                del.onmouseout = () => del.style.opacity = '0.5';
                del.onclick = (e) => {
                    e.stopPropagation();
                    delete state.imageAssets[assetId];
                    state.openTabs = state.openTabs.filter(t => t.id !== assetId);
                    if (state.activeTabId === assetId) switchTab('game-editor');
                    renderMenuOptions();
                    refreshSceneState();
                };
                item.appendChild(del);
            }

            item.onclick = (e) => {
                onClick();
                menu.style.display = 'none';
                cleanup();
            };
            menu.appendChild(item);
        };

        createItem('+ Create New', () => {
            const id = `img-${Date.now()}`;
            const w = 1280, h = 720; // Default to 720p
            state.imageAssets[id] = { name: 'New Image', frames: [createBlankFrame(w, h)], currentFrame: 0, width: w, height: h };
            currentItem.properties[propKey] = id;
            
            // Adopt image dimensions clamped to reasonable screen size with uniform aspect ratio
            const MAX_SIZE = 500;
            const ratio = Math.min(MAX_SIZE / w, MAX_SIZE / h, 1);
            currentItem.properties.sizeX = Math.round(w * ratio);
            currentItem.properties.sizeY = Math.round(h * ratio);

            refreshSceneState();
            showInspector();
            makeTabPersistent(id);
            switchTab(id);
        });

        createItem('📥 Import File', () => {
            const inp = document.createElement('input');
            inp.type = 'file'; inp.accept = 'image/*';
            inp.onchange = (e) => {
                const file = e.target.files[0];
                const reader = new FileReader();
                reader.onload = (re) => {
                    const img = new Image();
                    img.onload = () => {
                        const id = `img-${Date.now()}`;
                        const w = img.width, h = img.height;
                        state.imageAssets[id] = { name: file.name, frames: [re.target.result], currentFrame: 0, width: w, height: h };
                        currentItem.properties[propKey] = id;
                        
                        const MAX_SIZE = 500;
                        const ratio = Math.min(MAX_SIZE / w, MAX_SIZE / h, 1);
                        currentItem.properties.sizeX = Math.round(w * ratio);
                        currentItem.properties.sizeY = Math.round(h * ratio);

                        refreshSceneState();
                        showInspector();
                        makeTabPersistent(id);
                        switchTab(id);
                    };
                    img.src = re.target.result;
                };
                reader.readAsDataURL(file);
            };
            inp.click();
        });

        Object.keys(state.imageAssets).forEach(id => {
            createItem(state.imageAssets[id].name, () => {
                currentItem.properties[propKey] = id;
                // Re-sync dimensions if it was empty
                if (currentItem.properties.sizeX === 100 && state.imageAssets[id]) {
                    const asset = state.imageAssets[id];
                    const ratio = Math.min(500 / asset.width, 500 / asset.height, 1);
                    currentItem.properties.sizeX = Math.round(asset.width * ratio);
                    currentItem.properties.sizeY = Math.round(asset.height * ratio);
                }
                refreshSceneState();
                showInspector();
            }, id);
        });
    };

    container.appendChild(selectWrapper);
    return container;
}

function createSoundAssetDropdown(currentItem) {
    const container = document.createElement('div');
    container.className = 'prop-group';
    const label = document.createElement('label');
    label.className = 'prop-label';
    label.innerText = 'Sound Asset';
    container.appendChild(label);

    const selectWrapper = document.createElement('div');
    selectWrapper.style.cssText = 'position: relative; background: #1a1a1a; border: 1px solid #444; border-radius: 4px; margin-top: 4px; cursor: pointer;';
    const header = document.createElement('div');
    header.style.cssText = 'padding: 4px 8px; display: flex; align-items: center; justify-content: space-between; font-size: 11px;';
    const currentAsset = state.soundAssets[currentItem.properties.soundId];
    header.innerHTML = `<span>${currentAsset ? currentAsset.name : '<i>None</i>'}</span><span>▼</span>`;
    selectWrapper.appendChild(header);

    const menu = document.createElement('div');
    menu.style.cssText = 'position: absolute; top: 100%; left: -1px; width: calc(100% + 2px); background: #222; border: 1px solid #444; border-radius: 0 0 4px 4px; z-index: 2000; display: none; max-height: 250px; overflow-y: auto;';
    selectWrapper.appendChild(menu);

    selectWrapper.onclick = (e) => { e.stopPropagation(); menu.style.display = menu.style.display === 'block' ? 'none' : 'block'; };
    document.addEventListener('click', () => menu.style.display = 'none');

    const renderOptions = () => {
        menu.innerHTML = '';
        const createOption = (label, icon, onClick, assetId = null) => {
            const item = document.createElement('div');
            item.style.cssText = 'padding: 6px 10px; display: flex; align-items: center; gap: 8px; border-bottom: 1px solid #333; font-size: 11px;';
            item.onmouseover = () => item.style.background = '#333';
            item.onmouseout = () => item.style.background = 'transparent';
            
            const iconSpan = document.createElement('span'); iconSpan.innerText = icon;
            item.appendChild(iconSpan);
            
            const text = document.createElement('span'); text.innerText = label; text.style.flex = '1';
            item.appendChild(text);

            if (assetId) {
                const del = document.createElement('span'); del.innerText = '🗑️'; del.style.opacity = '0.5';
                del.onclick = (e) => { e.stopPropagation(); delete state.soundAssets[assetId]; renderOptions(); };
                item.appendChild(del);
            }

            item.onclick = (e) => { e.stopPropagation(); onClick(); menu.style.display = 'none'; };
            menu.appendChild(item);
        };

        // 1. Record Sound
        createOption('Record Sound', '🎤', () => {
            alert("Microphone recording is not yet implemented in this preview. Please use 'Import Sound'.");
        });

        // 2. Import Sound
        createOption('Import Sound', '📥', () => {
            const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'audio/*';
            inp.onchange = async (e) => {
                const file = e.target.files[0];
                const arrayBuffer = await file.arrayBuffer();
                const audioBuffer = await audioListener.context.decodeAudioData(arrayBuffer);
                const id = `snd-${Date.now()}`;
                state.soundAssets[id] = { name: file.name, buffer: audioBuffer, volume: 1, pitch: 1, speed: 1 };
                currentItem.properties.soundId = id;
                
                // Ensure tab exists before switching
                if (!state.openTabs.find(t => t.id === id)) {
                    state.openTabs.push({ id, name: file.name, persistent: true });
                }
                makeTabPersistent(id); switchTab(id);
            };
            inp.click();
        });

        // 3. Existing Assets
        Object.keys(state.soundAssets).forEach(id => {
            createOption(state.soundAssets[id].name, '🔊', () => {
                currentItem.properties.soundId = id;
                refreshSceneState();
                showInspector();
            }, id);
        });
    };

    renderOptions();
    container.appendChild(selectWrapper);
    return container;
}

function renderSoundEditor(assetId) {
    const assetData = state.soundAssets[assetId];
    let previewSource = null;
    const currentItem = state.currentSelectedItem;
    if (!assetData || !currentItem) return;

    soundEditorWorkspace.innerHTML = '';
    
    const container = document.createElement('div');
    container.style.cssText = 'flex: 1; display: flex; flex-direction: column; padding: 20px; gap: 20px; color: #fff;';
    
    const header = document.createElement('h2'); header.innerText = `Sound Editor: ${assetData.name}`;
    container.appendChild(header);

    // Waveform Visualization
    const waveform = document.createElement('canvas');
    waveform.width = 800; waveform.height = 200;
    waveform.style.cssText = 'width: 100%; height: 200px; background: #000; border-radius: 8px;';
    container.appendChild(waveform);
    
    const ctx = waveform.getContext('2d');
    const data = assetData.buffer.getChannelData(0);
    const step = Math.ceil(data.length / waveform.width);
    const amp = waveform.height / 2;
    ctx.fillStyle = '#00ff88';
    for(let i=0; i < waveform.width; i++) {
        let min = 1.0, max = -1.0;
        for (let j=0; j < step; j++) {
            const dat = data[(i*step)+j];
            if (dat < min) min = dat; if (dat > max) max = dat;
        }
        ctx.fillRect(i, (1+min)*amp, 1, Math.max(1, (max-min)*amp));
    }

    const stopPreview = () => {
        if (previewSource) {
            previewSource.stop();
            previewSource = null;
            playBtn.innerHTML = '▶';
            playBtn.style.background = '#00ff88';
        }
    };

    const playPreview = (startTime = 0) => {
        stopPreview();
        const source = audioListener.context.createBufferSource();
        source.buffer = assetData.buffer;
        const p = currentItem.properties;
        source.playbackRate.value = (p.playbackSpeed ?? 1) * (p.pitch ?? 1);
        const gain = audioListener.context.createGain();
        gain.gain.value = (p.volume ?? 100) / 100;
        source.connect(gain); gain.connect(audioListener.context.destination);
        source.start(0, startTime);
        previewSource = source;
        playBtn.innerHTML = '■';
        playBtn.style.background = '#ff4444';
        source.onended = () => { if (previewSource === source) stopPreview(); };
    };

    waveform.onclick = (e) => {
        const rect = waveform.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const time = (x / rect.width) * assetData.buffer.duration;
        playPreview(time);
    };

    // Controls
    const controls = document.createElement('div');
    controls.style.cssText = 'display: flex; gap: 25px; background: #222; padding: 20px; border-radius: 8px; align-items: flex-end;';
    
    const createValueBox = (label, propKey, min, max, step) => {
        const group = document.createElement('div'); 
        group.style.cssText = 'display: flex; flex-direction: column; gap: 5px;';
        const propId = label.toLowerCase().replace(/\s+/g, '-');
        
        const l = document.createElement('label'); 
        l.style.cssText = 'font-size: 11px; color: #aaa;';
        l.innerText = label; 
        group.appendChild(l);
        
        const inp = document.createElement('input'); 
        inp.type = 'number'; inp.min = min; inp.max = max; inp.step = step; 
        inp.value = currentItem.properties[propKey] ?? (propKey === 'volume' ? 100 : 1);
        inp.id = `sound-editor-input-${propId}`;
        inp.style.cssText = 'width: 70px; background: #111; border: 1px solid #444; color: #fff; padding: 5px; border-radius: 4px;';
        
        inp.oninput = (e) => {
            const val = parseFloat(e.target.value);
            if (!isNaN(val)) {
                currentItem.properties[propKey] = val;
                refreshSceneState();
                
                // Sync Inspector
                const inspectorInp = document.getElementById(`inspector-prop-${propId}`);
                if (inspectorInp) inspectorInp.value = val;
            }
        };
        group.appendChild(inp);
        return group;
    };

    controls.appendChild(createValueBox('Volume', 'volume', 0, 100, 1));
    controls.appendChild(createValueBox('Pitch', 'pitch', 0, 10, 0.1));
    controls.appendChild(createValueBox('Speed', 'playbackSpeed', 0, 10, 0.1));
    
    controls.appendChild(createValueBox('Start Distance', 'startDistance', 0, 1000, 0.1));
    controls.appendChild(createValueBox('Max Distance', 'maxDistance', 0, 1000, 1));
    controls.appendChild(createValueBox('Roll Off Distance', 'rolloffDistance', 0, 1000, 0.1));
    
    const playBtn = document.createElement('button');
    playBtn.innerHTML = '▶';
    playBtn.style.cssText = 'height: 40px; width: 40px; background: #00ff88; color: #000; border: none; border-radius: 50%; cursor: pointer; font-size: 20px; display: flex; align-items: center; justify-content: center; transition: background 0.2s;';
    playBtn.onclick = () => {
        if (previewSource) stopPreview();
        else playPreview(0);
    };
    controls.appendChild(playBtn);

    container.appendChild(controls);
    soundEditorWorkspace.appendChild(container);
}

function createBlankFrame(width = 128, height = 128) {
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: true });
    ctx.clearRect(0,0,width,height);
    return canvas.toDataURL();
}

function createVectorPropertyControl(label, vx, vy, vz, onChange) {
    const container = document.createElement('div');
    container.className = 'prop-group';
    
    const labelEl = document.createElement('label');
    labelEl.className = 'prop-label';
    labelEl.innerText = label.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase());
    container.appendChild(labelEl);

    const row = document.createElement('div');
    row.style.cssText = 'display: flex; gap: 4px;';

    ['X', 'Y', 'Z'].forEach((axis, i) => {
        const input = document.createElement('input');
        input.type = 'number';
        input.value = [vx, vy, vz][i];
        input.step = '0.1';
        input.className = 'prop-input';
        input.style.cssText = 'flex: 1; min-width: 0; padding: 4px;';
        
        input.oninput = (e) => {
            const val = parseFloat(e.target.value);
            if (!isNaN(val)) onChange(axis, val);
        };
        row.appendChild(input);
    });

    container.appendChild(row);
    return container;
}

function createNumberPairControl(label, xLabel, yLabel, xValue, yValue, onChangeX, onChangeY) {
    const container = document.createElement('div');
    container.className = 'prop-group';

    const labelEl = document.createElement('label');
    labelEl.className = 'prop-label';
    labelEl.innerText = label;
    container.appendChild(labelEl);

    const row = document.createElement('div');
    row.className = 'num-row';
    row.style.gap = '6px';

    const makeField = (fieldLabel, value, onChange) => {
        const field = document.createElement('div');
        field.style.display = 'flex';
        field.style.flexDirection = 'column';
        field.style.gap = '4px';
        field.style.flex = '1';

        const subLabel = document.createElement('label');
        subLabel.className = 'prop-label';
        subLabel.style.marginBottom = '0';
        subLabel.style.fontSize = '11px';
        subLabel.innerText = fieldLabel;
        field.appendChild(subLabel);

        const input = document.createElement('input');
        input.type = 'number';
        input.value = value;
        input.step = '0.1';
        input.className = 'prop-input';
        input.oninput = (e) => {
            const parsed = parseFloat(e.target.value);
            if (!isNaN(parsed)) onChange(parsed);
        };
        field.appendChild(input);

        return field;
    };

    row.appendChild(makeField(xLabel, xValue, onChangeX));
    row.appendChild(makeField(yLabel, yValue, onChangeY));
    container.appendChild(row);
    return container;
}

export function showInspector() {
    if (state.activeTabId !== 'game-editor') return; // Hide inspector in image editor

    // Sync the hierarchy item if we have a single 3D object selected but no item reference
    // This ensures that clicking a Light in the 3D view still shows its properties
    if (state.selectedObjects.length === 1 && !state.currentSelectedItem) {
        const itemId = findItemIdForObject(state.selectedObjects[0]);
        if (itemId) state.currentSelectedItem = explorerHierarchy.findItemById(itemId);
    }

    const currentItem = state.currentSelectedItem;
    dynamicProps.innerHTML = '';

    // Ensure we have something to inspect
    if (!currentItem && (!state.selectedObjects || state.selectedObjects.length === 0)) {
        propertyControls.style.display = 'none';
        noSelectionText.style.display = 'block';
        return;
    }

    const isPhysical = currentItem?.type === 'object' || state.selectedObjects.some(obj => obj.isMesh);
    const isBillboard = currentItem?.type === 'billboard' || state.selectedObjects.some(obj => obj.userData.isBillboard);
    const uiTypes = ['textlabel', 'textbutton', 'frame', 'text', 'framebutton', 'image'];
    const isUI = currentItem && uiTypes.includes(currentItem.type);
    const isLight = currentItem?.type === 'light' || state.selectedObjects.some(obj => obj.isLight);
    const isSound = currentItem?.type === 'sound';
    const isSurface = currentItem && surfaceTypes.includes(currentItem.type);
    const isParticle = currentItem?.subType === 'particle';

    const isInsideObject = (itemId) => {
        let p = findParentItem(itemId);
        while (p) {
            if (p.type === 'object' || p.type === 'spawn' || p.type === 'billboard') return true;
            p = findParentItem(p.id);
        }
        return false;
    };
    const isOnObject = currentItem && isInsideObject(currentItem.id);

    propertyControls.style.display = 'flex';
    noSelectionText.style.display = 'none';

    if (isOnObject && isSurface) {
        dynamicProps.appendChild(createDropdownPropertyControl('face', currentItem.properties.face || 'Front', ['Front', 'Back', 'Top', 'Bottom', 'Left', 'Right'], (v) => { currentItem.properties.face = v; refreshSceneState(); }));
    }

    // Clean up transform properties: Hide unused axes for UI and bunch X/Y side-by-side
    const transformFields = [
        { el: posInputs.x, ui: true }, { el: posInputs.y, ui: true }, { el: posInputs.z, ui: false },
        { el: rotInputs.x, ui: true }, { el: rotInputs.y, ui: false }, { el: rotInputs.z, ui: false },
        { el: scaleInputs.x, ui: true }, { el: scaleInputs.y, ui: true }, { el: scaleInputs.z, ui: false }
    ];

    transformFields.forEach(f => {
        const container = f.el?.closest('.prop-input-container');
        if (container) {
            const shouldShow = isUI ? f.ui : true;
            container.style.display = shouldShow ? 'flex' : 'none';
            container.style.flex = (isUI && shouldShow) ? '1' : '';
            container.style.minWidth = '0';
            
            const subLabel = container.querySelector('.prop-input-label');
            if (subLabel) {
                // Hide 'X' sub-label for UI rotation to treat it as a single field
                subLabel.style.display = (isUI && f.el === rotInputs.x) ? 'none' : 'block';
            }
        }
    });

    document.querySelectorAll('.prop-group-transform').forEach(group => {
        const label = group.querySelector('.prop-label');
        const row = group.querySelector('.prop-row') || group.querySelector('div[style*="flex"]');
        if (isUI) {
            if (label && label.innerText.includes('Scale')) label.innerText = 'Size';
            if (row) {
                row.style.display = 'flex';
                row.style.gap = '4px';
                row.style.flexDirection = 'row';
            }
        } else {
            if (label && label.innerText.includes('Size')) label.innerText = 'Scale';
            if (row) {
                row.style.display = '';
                row.style.flexDirection = '';
            }
        }
    });

    // 0. Unique/Dynamic Properties
    if (currentItem && currentItem.properties) {
        const props = currentItem.properties;
        const pKeys = Object.keys(props);
        const handled = new Set();

        if (isParticle) {
            dynamicProps.appendChild(createImageAssetDropdown(currentItem));
            dynamicProps.appendChild(createDropdownPropertyControl('shape', props.shape || 'Point', ['Point', 'Sphere', 'Cylinder', 'Disc'], (v) => { props.shape = v; refreshSceneState(); }));
            dynamicProps.appendChild(createDropdownPropertyControl('blending', props.blending || 'Normal', ['Normal', 'Additive'], (v) => { props.blending = v; refreshSceneState(); }));
            
            dynamicProps.appendChild(createNumberPairControl('Lifespan', 'Min', 'Max', props.lifeMin, props.lifeMax, (v) => { props.lifeMin = v; refreshSceneState(); }, (v) => { props.lifeMax = v; refreshSceneState(); }));
            dynamicProps.appendChild(createNumberPairControl('Speed', 'Min', 'Max', props.speedMin, props.speedMax, (v) => { props.speedMin = v; refreshSceneState(); }, (v) => { props.speedMax = v; refreshSceneState(); }));
            dynamicProps.appendChild(createNumberPairControl('Size', 'Min', 'Max', props.sizeMin, props.sizeMax, (v) => { props.sizeMin = v; refreshSceneState(); }, (v) => { props.sizeMax = v; refreshSceneState(); }));
            
            dynamicProps.appendChild(createVectorPropertyControl('Direction', props.directionX || 0, props.directionY || 1, props.directionZ || 0, (axis, val) => {
                props['direction' + axis] = val;
                refreshSceneState();
            }));

            dynamicProps.appendChild(createVectorPropertyControl('Gravity', props.gravityX || 0, props.gravityY || 0, props.gravityZ || 0, (axis, val) => {
                props['gravity' + axis] = val;
                refreshSceneState();
            }));
            
            dynamicProps.appendChild(createPropertyControl('Reflectiveness', props.reflectiveness ?? 0, 'number', (newVal) => {
                props.reflectiveness = parseFloat(newVal);
                refreshSceneState();
            }));

            ['rate', 'spread', 'opacity', 'color', 'enabled', 'environmentCollision', 'particleCollision'].forEach(key => {
                const type = (key === 'enabled' || key === 'environmentCollision' || key === 'particleCollision') ? 'boolean' : (key === 'color' ? 'color' : 'number');
                const label = key.charAt(0).toUpperCase() + key.slice(1).replace(/([A-Z])/g, ' $1');
                dynamicProps.appendChild(createPropertyControl(label, props[key], type, (newVal) => {
                    props[key] = type === 'number' ? parseFloat(newVal) : newVal;
                    refreshSceneState();
                }));
            });
            
            handled.add('reflectiveness'); 
            handled.add('imageId'); handled.add('shape'); handled.add('blending');
            handled.add('lifeMin'); handled.add('lifeMax');
            handled.add('speedMin'); handled.add('speedMax'); handled.add('sizeMin'); handled.add('sizeMax');
            handled.add('gravityX'); handled.add('gravityY'); handled.add('gravityZ');
            handled.add('directionX'); handled.add('directionY'); handled.add('directionZ');
            handled.add('rate'); handled.add('spread'); handled.add('opacity');
            handled.add('color'); handled.add('enabled');
            handled.add('environmentCollision'); handled.add('particleCollision');
        } else if (isLight) {
            pKeys.forEach(key => {
                // Hide internal sound identifiers
            if (key === 'soundId' || key.startsWith('skybox')) return;

                const val = props[key];
                let type;
                if (typeof val === 'number') type = 'number';
                else if (typeof val === 'boolean') type = 'boolean';
                else if (key.toLowerCase().includes('color')) type = 'color';
                else type = 'text';

                const control = createPropertyControl(key, val, type, (newVal) => {
                    props[key] = type === 'number' ? parseFloat(newVal) : newVal;
                    refreshSceneState();
                });
                dynamicProps.appendChild(control);
            });
        } else {
            // Position asset dropdowns at the top of the dynamic properties section
            if (currentItem.type === 'image' || currentItem.type === 'texture') {
                dynamicProps.appendChild(createImageAssetDropdown(currentItem));
            }

            if (currentItem.type === 'texture') {
                dynamicProps.appendChild(createNumberPairControl(
                    'Tile',
                    'Tile X',
                    'Tile Y',
                    currentItem.properties.tileX ?? 1,
                    currentItem.properties.tileY ?? 1,
                    (value) => {
                        currentItem.properties.tileX = value;
                        refreshSceneState();
                    },
                    (value) => {
                        currentItem.properties.tileY = value;
                        refreshSceneState();
                    }
                ));
            }
            
            if (currentItem.type === 'sound') {
                dynamicProps.appendChild(createSoundAssetDropdown(currentItem));
            }

            if (currentItem.type === 'sky') {
                dynamicProps.appendChild(createImageAssetDropdown(currentItem, 'Cubemap Image', 'skyboxId'));
            }

            pKeys.forEach(key => {
                if (handled.has(key)) return;

                // Hide internal identifiers from the generic list
                if (key === 'imageId' || key === 'soundId' || key === 'face' || key.startsWith('skybox')) return;
                
                // Skip UI transform properties to avoid duplicates (they are handled by global transform inputs)
                if (isUI && ['posX', 'posY', 'sizeX', 'sizeY', 'rotation', 'imageId'].includes(key)) return;
                // Hide texture-specific size fields and duplicate tile controls for texture children
                if (currentItem.type === 'texture' && ['tileX', 'tileY', 'sizeX', 'sizeY'].includes(key)) return;
                
                // Detect Vector Triplets (e.g. gravityX, gravityY, gravityZ)
                if (key.endsWith('X') && pKeys.includes(key.slice(0, -1) + 'Y') && pKeys.includes(key.slice(0, -1) + 'Z')) {
                    const base = key.slice(0, -1);
                    const control = createVectorPropertyControl(base, props[base+'X'], props[base+'Y'], props[base+'Z'], (axis, val) => {
                        props[base + axis] = val;
                        refreshSceneState();
                    });
                    dynamicProps.appendChild(control);
                    handled.add(base + 'X'); handled.add(base + 'Y'); handled.add(base + 'Z');
                    return;
                }

                const val = props[key];
                let type;
                if (typeof val === 'number') type = 'number';
                else if (typeof val === 'boolean') type = 'boolean';
                else if (key.toLowerCase().includes('color')) type = 'color';
                else type = 'text';

                const control = createPropertyControl(key, val, type, (newVal) => {
                    props[key] = type === 'number' ? parseFloat(newVal) : newVal;
                    refreshSceneState();
                });
                dynamicProps.appendChild(control);
                handled.add(key);
            });
        }
        dynamicProps.style.display = 'block';
    } else {
        dynamicProps.style.display = 'none';
    }

    // 1. Basic Info (Name/Delete)
    const nameGroup = nameInput.closest('.prop-group');
    if (nameGroup) nameGroup.style.display = currentItem?.isProtected ? 'none' : 'block';
    
    nameInput.value = currentItem ? currentItem.name : (state.selectedObjects.length > 1 ? "Multiple Objects" : state.selectedObjects[0].name);
    nameInput.disabled = state.selectedObjects.length > 1;
    deleteBtn.style.visibility = currentItem?.isProtected ? 'hidden' : 'visible';

    // 2. Physical Properties Visibility
    const physPropIds = ['prop-material', 'prop-roughness', 'prop-tile-scale-x', 'prop-anchored', 'prop-collide', 'prop-opacity', 'prop-cast-shadow', 'prop-reflection', 'prop-density'];
    // Only show physical props for actual parts/meshes, never for lights (they use dynamic ones)
    const showPhysical = isPhysical;
    colorPicker.parentElement.style.display = showPhysical ? 'block' : 'none';
    physPropIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            const group = el.closest('.prop-group');
            let shouldShow = showPhysical;
            if (id === 'prop-opacity' && (isUI || isSurface)) shouldShow = true;
            if (group) group.style.display = shouldShow ? 'block' : 'none';
        }
    });

    // 3. Transform (Position/Rotation/Scale)
    const hasTransform = showPhysical || isUI;
    if (hasTransform) {
        updatePropertyValues();
        document.querySelectorAll('.prop-group-transform').forEach(el => el.style.display = 'block');
    } else {
        document.querySelectorAll('.prop-group-transform').forEach(el => el.style.display = 'none');
    }

    // Update input step based on context (1 for UI, 0.1 for 3D)
    const stepVal = isUI ? "1" : "0.1";
    [posInputs.x, posInputs.y, posInputs.z, rotInputs.x, rotInputs.y, rotInputs.z, scaleInputs.x, scaleInputs.y, scaleInputs.z].forEach(inp => {
        if (inp) inp.step = stepVal;
    });

    // 4. Sync Material UI if single physical object
    if (isPhysical && state.selectedObjects.length === 1) {
        const target = state.selectedObjects[0];

        const displayColor = target.userData.partColor || (Array.isArray(target.material) ? 
            '#' + target.material[0].color.getHexString() : 
            (target.material?.color ? '#' + target.material.color.getHexString() : '#ffffff'));

        // Neon: inspector color must reflect emissive, not base color.
        colorPicker.value = (target?.userData?.material === 'Neon' && target.material?.emissive) ? 
            '#' + target.material.emissive.getHexString() : displayColor;

        colorPicker.parentElement.style.opacity = "1";
        materialSelect.value = target.userData.material || '';

        const r100 = (target.userData.roughness100 !== undefined)
            ? target.userData.roughness100
            : ((target.material?.roughness ?? 0.8) * 100);
        roughnessInput.value = Number(r100 / 10).toFixed(1);
    } else if (isLight && state.selectedObjects.length === 1) {
        const target = state.selectedObjects[0];
        if (target.color) {
            colorPicker.value = '#' + target.color.getHexString();
            colorPicker.parentElement.style.opacity = "1";
        }
    } else {
        colorPicker.parentElement.style.opacity = "0.5";
    }

    // Force UI handles to appear/update immediately on selection
    if (isUI) refreshSceneState();

    updateExplorer();
}



function getHexFromColorInput(inputEl) {
    return inputEl.value;
}

colorPicker.oninput = () => {
    const hex = getHexFromColorInput(colorPicker);

    // Bricks: allow color picker to tint Bricks like other materials.
    const isBricksSelection = state.selectedObjects.some(o => o?.userData?.material === 'Bricks');
    if (isBricksSelection) {
        state.selectedObjects.forEach(obj => {
            if (!obj || obj.userData?.material !== 'Bricks') return;
            obj.userData.partColor = hex;
            obj.userData.bricksColorHex = hex;
            const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
            mats.forEach(m => {
                if (!m.color) return;
                const isSurfaceCanvas = m.map instanceof THREE.CanvasTexture;
                if (isSurfaceCanvas) {
                    m.color.set(0xffffff);
                } else {
                    m.color.set(hex);
                }
                m.needsUpdate = true;
            });
        });
        refreshSceneState();
        return;
    }

    state.selectedObjects.forEach(obj => {
        if (!obj) return;

        obj.userData.partColor = hex;
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];

        if (obj.userData?.material === 'Neon') {
            obj.userData.emissiveColorHex = hex;
            mats.forEach(m => {
                if (!m.color) return;
                const isSurfaceCanvas = m.map instanceof THREE.CanvasTexture;
                if (isSurfaceCanvas) {
                    m.color.set(0xffffff);
                } else {
                    m.color.set(hex).multiplyScalar(25);
                }
                m.toneMapped = false;
                m.needsUpdate = true;
            });
        } else {
            mats.forEach(m => {
                if (!m.color) return;
                const isSurfaceCanvas = m.map instanceof THREE.CanvasTexture;
                if (isSurfaceCanvas) {
                    m.color.set(0xffffff);
                } else {
                    m.color.set(hex);
                }
                m.needsUpdate = true;
            });
        }
    });

    refreshSceneState(); // Redraw canvases with the new partColor background
};




anchoredInput.onchange = () => {
    state.selectedObjects.forEach(obj => {
        obj.userData.anchored = anchoredInput.checked;
    updatePropertyValues();
    });
};

// --- CONTEXT MENU HANDLERS ---
document.addEventListener('click', (e) => {
    if (e.target !== explorerMenu && !explorerMenu.contains(e.target) && !e.target.closest('.exp-plus')) {
        explorerMenu.style.display = 'none';
    }
});

function createObjectInFolder(parentId, type) {
    const parent = explorerHierarchy.findItemById(parentId);
    if (!parent) return;
    
    const uiTypes = ['textlabel', 'frame', 'text'];
    const getUniqueUIOrder = () => {
        const existingOrders = (parent.children || [])
            .filter(c => uiTypes.includes(c.type))
            .map(c => c.properties?.order ?? 0);
        let order = 0;
        while (existingOrders.includes(order)) order++;
        return order;
    };

    if (type === 'Object') {
        // Create a new 3D object
        // Using Unit Geometry (1x1x1) so Scale property matches World Size
        const geometry = new THREE.BoxGeometry(1, 1, 1);
        const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: false, roughness: 0.8 });
        mat.shadowSide = THREE.DoubleSide;
        const mesh = new THREE.Mesh(geometry, mat);
        mesh.scale.set(2, 2, 2); // Default starting size
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        const objName = explorerHierarchy.getNextName('object');
        mesh.name = objName;
        mesh.userData.partColor = '#ffffff';
        mesh.userData.anchored = true;
        mesh.userData.castShadow = true;
        mesh.userData.opacity = 1;
        mesh.userData.reflectiveness = 0;
        mesh.userData.roughness100 = 80;
        mesh.userData.canCollide = true;
        mesh.userData.density = 10;
        mesh.userData.velocity = new THREE.Vector3(0, 0, 0);

        
        scene.add(mesh);
        state.selectableObjects.push(mesh);
        placeOnTargetSurface(mesh);
        updateObjectUVs(mesh);
        
        // Add to hierarchy
        const item = { id: `obj-${Date.now()}-${Math.floor(Math.random() * 1000)}`, type: 'object', name: objName, objectRef: mesh, children: [], properties: {} };
        parent.children.push(item);
        explorerHierarchy.expanded[parentId] = true;

        attachTool(mesh, false);
        refreshSceneState();
        updateExplorer();

    } else if (type === 'Billboard') {
        const name = explorerHierarchy.getNextName('billboard');
        const geo = new THREE.PlaneGeometry(1, 1);
        // Billboards are typically unlit to ensure UI colors are accurate
        const mat = new THREE.MeshBasicMaterial({ 
            transparent: true, side: THREE.DoubleSide, depthWrite: false, opacity: 1, alphaTest: 0.05 
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.scale.set(5, 5, 1);
        mesh.userData.isBillboard = true;
        mesh.userData.anchored = true;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        mesh.userData.opacity = 1;
        mesh.userData.isEditor = false;
        
        scene.add(mesh);
        state.selectableObjects.push(mesh);
        placeOnTargetSurface(mesh);
        
        const item = { id: `bill-${Date.now()}`, type: 'billboard', name: name, objectRef: mesh, children: [], properties: { opacity: 1 } };
        parent.children.push(item);
        explorerHierarchy.expanded[parentId] = true;
        attachTool(mesh, false);
        refreshSceneState();
        updateExplorer();

    } else if (type === 'PlayerSpawn') {
        const geometry = new THREE.BoxGeometry(1, 1, 1);
        const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: false, shadowSide: THREE.DoubleSide }));
        mesh.scale.set(4, 0.5, 4);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        const objName = explorerHierarchy.getNextName('spawn');
        mesh.name = objName;
        mesh.userData.isPlayerSpawn = true;
        mesh.userData.anchored = true;
        mesh.userData.density = 10;
        mesh.userData.opacity = 1;
        mesh.userData.reflectiveness = 0;
        mesh.userData.roughness100 = 80;
        mesh.userData.canCollide = true;

        scene.add(mesh);
        state.selectableObjects.push(mesh);
        if (parentId === 'world-folder') mesh.position.set(0, 0.25, 0);
        else placeOnTargetSurface(mesh);

        const item = { id: `spawn-${Date.now()}`, type: 'spawn', name: objName, objectRef: mesh, children: [], properties: { enabled: true } };
        parent.children.push(item);
        explorerHierarchy.expanded[parentId] = true;

    } else if (type === 'Light') {
        const light = new THREE.PointLight(0xffffff, 1, 10);
        const name = explorerHierarchy.getNextName('light');
        scene.add(light);
        
        const item = { 
            id: `light-${Date.now()}`, type: 'light', name: name, objectRef: light,
            properties: { intensity: 1, range: 10, color: '#ffffff', castShadow: true },
            children: []
        };
        parent.children.push(item);

        if (parent.type === 'object' || parent.type === 'spawn') {
            light.position.set(0, 0, 0);
        } else {
            placeOnTargetSurface(light);
        }

    } else if (type === 'Bloom') {
        const bloomName = explorerHierarchy.getNextName('bloom');
        const item = { id: `bloom-${Date.now()}`, type: 'effect', subType: 'bloom', name: bloomName, properties: { strength: 1.5, radius: 0.4, threshold: 0.85 } };
        parent.children.push(item);
        
    } else if (type === 'SunRays') {
        const sunraysName = explorerHierarchy.getNextName('sunrays');
        const item = { id: `sunrays-${Date.now()}`, type: 'effect', subType: 'sunrays', name: sunraysName, properties: { intensity: 1, color: '#ffffff' } };
        parent.children.push(item);
        
    } else if (type === 'AmbientOcclusion') {
        const aoName = explorerHierarchy.getNextName('ambient-occlusion');
        const item = { id: `ao-${Date.now()}`, type: 'effect', subType: 'ambient-occlusion', name: aoName, properties: { intensity: 1, radius: 10, bias: 0.05, blur: true, depthCutoff: 0.001, enabled: true } };
        parent.children.push(item);

    } else if (type === 'Fog') {
        const fogName = explorerHierarchy.getNextName('fog');
        const item = { id: `fog-${Date.now()}`, type: 'effect', subType: 'fog', name: fogName, properties: { color: '#87CEEB', density: 0.01 } };
        parent.children.push(item);
    } else if (type === 'ParticleEmitter') {
        const name = explorerHierarchy.getNextName('particle');
        const item = { 
            id: `parti-${Date.now()}`, 
            type: 'effect', 
            subType: 'particle', 
            name: name, 
            properties: { 
                imageId: null, shape: 'Point', rate: 40, 
                lifeMin: 1.5, lifeMax: 3.5, 
                speedMin: 4, speedMax: 8,
                sizeMin: 1, sizeMax: 2.5,
                color: '#ffffff', opacity: 1,
                gravityX: 0, gravityY: -10, gravityZ: 0,
                directionX: 0, directionY: 1, directionZ: 0,
                spread: 0.4, blending: 'Normal',
                enabled: true,
                environmentCollision: false,
                particleCollision: false,
                reflectiveness: 0.5
            } 
        };
        parent.children.push(item);
    } else if (type === 'Folder') {
        const name = explorerHierarchy.getNextName('folder');
        const item = { id: `folder-${Date.now()}`, type: 'folder', name: name, children: [], properties: {} };
        parent.children.push(item);
    } else if (type === 'Model') {
        const name = explorerHierarchy.getNextName('model');
        const item = { id: `model-${Date.now()}`, type: 'model', name: name, children: [], properties: {} };
        parent.children.push(item);
    } else if (type === 'TextLabel') {
        const name = explorerHierarchy.getNextName('textlabel');
        const item = { id: `ui-${Date.now()}`, type: 'textlabel', name: name, properties: { text: 'Label', fontSize: 18, color: '#ffffff', textColor: '#000000', posX: 0, posY: 0, sizeX: 100, sizeY: 50, rotation: 0, order: getUniqueUIOrder(), visible: true, face: 'Front', opacity: 1 } };
        parent.children.push(item);
    } else if (type === 'Frame') {
        const name = explorerHierarchy.getNextName('frame');
        const item = { id: `ui-${Date.now()}`, type: 'frame', name: name, properties: { color: '#ffffff', posX: 0, posY: 0, sizeX: 100, sizeY: 100, rotation: 0, order: getUniqueUIOrder(), visible: true, face: 'Front', opacity: 1 } };
        parent.children.push(item);
    } else if (type === 'Text') {
        const name = explorerHierarchy.getNextName('text');
        const item = { id: `ui-${Date.now()}`, type: 'text', name: name, properties: { text: 'Text', fontSize: 18, textColor: '#ffffff', posX: 0, posY: 0, sizeX: 100, sizeY: 50, rotation: 0, order: getUniqueUIOrder(), visible: true, face: 'Front', opacity: 1 } };
        parent.children.push(item);
    } else if (type === 'Image') {
        const name = explorerHierarchy.getNextName('image');
        const item = { id: `ui-${Date.now()}`, type: 'image', name: name, properties: { imageId: null, posX: 0, posY: 0, sizeX: 100, sizeY: 100, rotation: 0, order: getUniqueUIOrder(), visible: true, face: 'Front', opacity: 1 } };
        parent.children.push(item);
    } else if (type === 'Texture') {
        const name = explorerHierarchy.getNextName('texture');
        const item = { id: `tex-${Date.now()}`, type: 'texture', name: name, properties: { imageId: null, face: 'Front', tileX: 1, tileY: 1, opacity: 1 } };
        parent.children.push(item);
    } else if (type === 'Sky') {
        const name = explorerHierarchy.getNextName('sky');
        const item = { id: `sky-${Date.now()}`, type: 'sky', name: name, properties: { skyboxId: null } };
        parent.children.push(item);
    } else if (type === 'Camera') {
        const name = explorerHierarchy.getNextName('camera');
        const cam = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
        
        const indicator = new THREE.Group();
        indicator.userData.isIndicator = true;
        indicator.userData.isEditor = true;
        const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.8), new THREE.MeshStandardMaterial({ color: 0x222222 }));
        const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.3, 0.4, 16), new THREE.MeshStandardMaterial({ color: 0x444444 }));
        lens.rotation.x = Math.PI / 2;
        lens.position.z = -0.5;
        indicator.add(body, lens);
        
        cam.add(indicator);
        scene.add(cam);
        state.selectableObjects.push(cam);
        placeOnTargetSurface(cam);
        
        const item = { 
            id: `cam-${Date.now()}`, 
            type: 'camera', 
            name: name, 
            objectRef: cam, 
            properties: { enabled: false, fov: 75, near: 0.1, far: 1000 },
            children: [] 
        };
        parent.children.push(item);
    } else if (type === 'Sound') {
        const name = explorerHierarchy.getNextName('sound');
        const item = { 
            id: `snd-item-${Date.now()}`, 
            type: 'sound', 
            name: name, 
            properties: { 
                soundId: null, volume: 100, playbackSpeed: 1, pitch: 1, loop: true, playing: false, 
                startDistance: 10, maxDistance: 100, rolloffDistance: 1,
                posX: 0, posY: 5, posZ: 0 
            } 
        };
        parent.children.push(item);
    }

    explorerHierarchy.expanded[parentId] = true;
    refreshSceneState();
    updateExplorer();
}

// Menu item click handlers
document.getElementById('menu-add-part').onclick = () => {
    if (currentContextId) {
        createObjectInFolder(currentContextId, 'Object');
        explorerMenu.style.display = 'none';
    }
};

document.getElementById('menu-add-folder').onclick = () => {
    if (currentContextId) {
        createObjectInFolder(currentContextId, 'Folder');
        explorerMenu.style.display = 'none';
    }
};

document.getElementById('menu-add-model').onclick = () => {
    if (currentContextId) {
        createObjectInFolder(currentContextId, 'Model');
        explorerMenu.style.display = 'none';
    }
};

// --- RIGHT-CLICK CONTEXT MENU FOR GROUPING AND DELETION ---
const rightClickMenu = document.createElement('div');
rightClickMenu.id = 'right-click-menu';
rightClickMenu.style.cssText = `
    position: fixed;
    background: #222;
    border: 1px solid #444;
    padding: 5px 0;
    z-index: 2001;
    display: none;
    box-shadow: 0 4px 10px rgba(0,0,0,0.5);
    border-radius: 4px;
    min-width: 120px;
`;
document.body.appendChild(rightClickMenu);

export function showRightClickMenu(x, y, contextId = null) {
    currentContextId = contextId || 'world-folder'; // Default to World if background clicked
    const contextItem = explorerHierarchy.findItemById(currentContextId);
    const topLevelSelected = getTopLevelSelectedItems();
    const hasSelection = topLevelSelected.length > 0;
    const isContainer = contextItem && (contextItem.type === 'folder' || contextItem.type === 'model');

    const menuItems = [];

    // If there are objects selected, show grouping options
    // Only show grouping if the selected items are not protected default folders
    const canGroup = hasSelection && topLevelSelected.every(item => !item.isProtected);
    if (canGroup) {
        const count = topLevelSelected.length;
        const labelSuffix = count > 1 ? ` (${count} items)` : '';
        menuItems.push({ type: 'group-model', label: `Group as Model${labelSuffix}` });
        menuItems.push({ type: 'group-folder', label: `Group as Folder${labelSuffix}` });
    }

    // Rename logic (only show for non-protected/non-default folders)
    if (contextItem && !contextItem.isProtected) {
        menuItems.push({
            type: 'rename',
            label: 'Rename',
            onTrigger: () => {
                renamingItemId = contextItem.id;
                updateExplorer();
            }
        });
    }

    // Copy / Paste options
    const canCopy = state.selectedObjects.length > 0 || state.currentSelectedItem || state.selectedItems.size > 0;

    menuItems.push({
        type: 'copy',
        label: 'Copy',
        disabled: !canCopy,
        onTrigger: () => {
            if (canCopy) copySelection();
        }
    });

    menuItems.push({
        type: 'paste',
        label: 'Paste',
        disabled: clipboard.length === 0,
        onTrigger: () => {
            if (clipboard.length === 0) return;
            // Paste uses current behavior (pastes into World or current context if valid)
            pasteSelection(currentContextId);
        }
    });

    menuItems.push({
        type: 'paste-into',
        label: 'Paste into',
        disabled: clipboard.length === 0,
        onTrigger: () => {
            if (clipboard.length === 0) return;
            pasteSelection(currentContextId);
        }
    });

    menuItems.push({
        type: 'duplicate',
        label: 'Duplicate',
        disabled: !canCopy,
        onTrigger: () => {
            if (canCopy) duplicateSelected();
        }
    });

    // Delete logic with protection check
    if (hasSelection && topLevelSelected.every(item => !item.isProtected)) {
        let deleteLabel = 'Delete';
        if (topLevelSelected.length > 1) deleteLabel = `Delete Selection (${topLevelSelected.length})`;
        else deleteLabel = `Delete ${topLevelSelected[0].name}`;
        menuItems.push({ type: 'delete', label: deleteLabel, isDelete: true });
    } else if (contextItem && !contextItem.isProtected && !state.selectedItems.has(contextItem)) {
        // If right-clicking a non-selected item that isn't protected
        menuItems.push({ type: 'delete', label: `Delete ${contextItem.name}`, isDelete: true });
    }


    if (menuItems.length === 0) {
        rightClickMenu.style.display = 'none';
        return;
    }

    // Build HTML and attach event listeners
    let menuHtml = '';
    menuItems.forEach((item, index) => {
        if (item.type === 'divider') {
            menuHtml += `<div style="border-top: 1px solid #444; margin: 5px 0;"></div>`;
            return;
        }
        if (item.label === undefined) return; // Skip dividers
        const deleteStyle = item.isDelete ? 'color: #ff6666;' : '';
        const borderStyle = item.isDelete ? 'border-top: 1px solid #444; margin-top: 5px;' : '';
        menuHtml += `<div class="menu-item" data-menu-index="${index}" style="${deleteStyle} ${borderStyle}">${item.label}</div>`;
    });

    rightClickMenu.innerHTML = menuHtml;

    // Attach event listeners to menu items
    menuItems.forEach((item, index) => {
        if (item.label === undefined || item.type === 'divider') return; // Skip dividers
        const element = rightClickMenu.querySelector(`[data-menu-index="${index}"]`);
        if (element) {
            element.onclick = (e) => {
                e.stopPropagation();
                
                if (item.disabled) return;

                if (item.onTrigger) {
                    item.onTrigger();
                } else if (item.type === 'create') {
                    createObjectInFolder(currentContextId, item.objectType);
                } else if (item.type === 'group-model') {
                    groupAsModel();
                } else if (item.type === 'group-folder') {
                    groupAsFolder();
                } else if (item.type === 'delete') {
                    deleteSelected();
                }

                
                rightClickMenu.style.display = 'none';
            };
        }
    });
    
    rightClickMenu.style.left = x + 'px';
    rightClickMenu.style.top = y + 'px';
    rightClickMenu.style.display = 'block';
    
    // Keep menu on screen (forced reflow for accurate measurements)
    rightClickMenu.offsetHeight; // Force reflow
    const rect = rightClickMenu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
        rightClickMenu.style.left = (window.innerWidth - rect.width - 10) + 'px';
    }
    if (rect.bottom > window.innerHeight) {
        rightClickMenu.style.top = (window.innerHeight - rect.height - 10) + 'px';
    }
}

function getActiveParent() {
    if (currentContextId) {
        const item = explorerHierarchy.findItemById(currentContextId);
        if (item) {
            if (item.type === 'folder' || item.type === 'model') return item;
            // If it's an object, find its parent in the hierarchy
            const search = (items, parent) => {
                for (let i of items) {
                    if (i.id === item.id) return parent;
                    if (i.children) {
                        const p = search(i.children, i);
                        if (p) return p;
                    }
                }
                return null;
            };
            return search(explorerHierarchy.items, null) || explorerHierarchy.getOrCreateWorld();
        }
    }
    return explorerHierarchy.getOrCreateWorld();
}

/**
 * Returns the top-most selected items in the hierarchy to avoid redundant operations 
 * on children of selected folders.
 */
function getTopLevelSelectedItems() {
    const selected = Array.from(state.selectedItems);
    return selected.filter(item => {
        let p = findParentItem(item.id);
        while (p) {
            if (state.selectedItems.has(p)) return false;
            p = findParentItem(p.id);
        }
        return true;
    });
}

window.groupAsModel = () => {
    const toGroup = getTopLevelSelectedItems().filter(item => !item.isProtected);
    if (toGroup.length === 0) return;
    
    const modelName = explorerHierarchy.getNextName('model');
    const modelId = `model-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const modelItem = { id: modelId, type: 'model', name: modelName, children: [] };
    
    const parent = getActiveParent();
    parent.children.push(modelItem);
    
    if (parent.id) explorerHierarchy.expanded[parent.id] = true;
    explorerHierarchy.expanded[modelId] = true;

    toGroup.forEach(item => {
        explorerHierarchy.moveItem(item.id, modelId);
    });

    updateExplorer();
    rightClickMenu.style.display = 'none';
};

window.groupAsFolder = () => {
    const toGroup = getTopLevelSelectedItems().filter(item => !item.isProtected);
    if (toGroup.length === 0) return;
    
    const folderName = explorerHierarchy.getNextName('folder');
    const folderId = `folder-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const folderItem = { id: folderId, type: 'folder', name: folderName, children: [] };

    const parent = getActiveParent();
    parent.children.push(folderItem);

    if (parent.id) explorerHierarchy.expanded[parent.id] = true;
    explorerHierarchy.expanded[folderId] = true;

    toGroup.forEach(item => {
        explorerHierarchy.moveItem(item.id, folderId);
    });
    
    updateExplorer();
    rightClickMenu.style.display = 'none';
};

window.deleteSelected = () => {
    const topLevel = getTopLevelSelectedItems();
    let idsToDelete = topLevel.map(item => item.id);

    // If nothing is selected, check if we right-clicked a specific item
    if (idsToDelete.length === 0 && currentContextId) {
        const contextItem = explorerHierarchy.findItemById(currentContextId);
        if (contextItem && !contextItem.isProtected) idsToDelete.push(currentContextId);
    }

    if (idsToDelete.length === 0) return;

    // 2. Clear selection state BEFORE removing from scene
    clearSelection();
    
    // Clear the object id cache for deleted items
    idsToDelete.forEach(id => {
        const item = explorerHierarchy.findItemById(id);
        if (item) {
            explorerHierarchy.getAllObjectsInItem(id).forEach(obj => objectIdCache.delete(obj));
        }
    });

    // 3. Execute deletion
    idsToDelete.forEach(id => {
        const item = explorerHierarchy.findItemById(id);
        if (!item || item.isProtected) return;

        const objects = explorerHierarchy.getAllObjectsInItem(id);
        objects.forEach(obj => {
            if (obj.parent) obj.parent.remove(obj);
            const idx = state.selectableObjects.indexOf(obj);
            if (idx > -1) state.selectableObjects.splice(idx, 1);
        });
        state.activeEmitters.delete(item);
        explorerHierarchy.removeItem(id);
        refreshSceneState();
    });

    currentContextId = null;
    showInspector();
    updateExplorer();
    rightClickMenu.style.display = 'none';
};

document.addEventListener('click', (e) => {
    if (e.target !== explorerMenu && !explorerMenu.contains(e.target) && !e.target.closest('.exp-plus')) {
        explorerMenu.style.display = 'none';
    }
    if (e.target !== rightClickMenu && !rightClickMenu.contains(e.target)) {
        rightClickMenu.style.display = 'none';
    }
});

export function clearSelection() {
    if (selectionGroup.children.length > 0) {
        const children = [...selectionGroup.children].filter(c => c !== selectionBox && c !== scaleHandles);
        children.forEach(obj => scene.attach(obj));
    }
    selectionGroup.position.set(0, 0, 0); selectionGroup.rotation.set(0, 0, 0); selectionGroup.scale.set(1, 1, 1);
    selectionGroup.updateMatrixWorld();

    state.selectedItems.clear();
    state.selectedObjects = [];
    state.currentSelectedItem = null;

    // Also clear container selection tracking
    if (state.selectedContainerItems) {
        state.selectedContainerItems.clear();
    }

    // Close non-persistent asset tabs on deselection
    state.openTabs = state.openTabs.filter(tab => tab.persistent || tab.id === 'game-editor');
    if (!state.openTabs.find(t => t.id === state.activeTabId)) switchTab('game-editor');
    updateTabs();

    transformControls.detach(); scaleHandles.visible = false; selectionBox.visible = false;
    refreshSceneState();
}


deleteBtn.onclick = () => {
    window.deleteSelected();
};

export function attachTool(obj, isMulti = false) {
    // Detach current objects before recalculating selection group
    const currentChildren = [...selectionGroup.children].filter(c => c !== selectionBox && c !== scaleHandles);
    currentChildren.forEach(child => scene.attach(child));

    // 1. Manage the internal selection array
    if (obj) {
        if (isMulti === 'force') {
            if (!state.selectedObjects.includes(obj)) state.selectedObjects.push(obj);
        } else if (!isMulti) {
            state.selectedItems.clear();
            state.selectedObjects = [obj];
        } else {
            if (state.selectedObjects.includes(obj)) {
                state.selectedObjects = state.selectedObjects.filter(o => o !== obj);
            } else {
                state.selectedObjects.push(obj);
            }
        }

        // Sync hierarchy selection for 3D clicks
        const itemId = findItemIdForObject(obj);
        const item = explorerHierarchy.findItemById(itemId);
        if (item) {
            if (state.selectedObjects.includes(obj)) {
                state.selectedItems.add(item);
                state.currentSelectedItem = item;
            } else {
                state.selectedItems.delete(item);
                if (state.currentSelectedItem === item) state.currentSelectedItem = Array.from(state.selectedItems).pop() || null;
            }
        }
    }

    // 2. Visual Update
    if (state.selectedObjects.length === 0) { 
        transformControls.detach();
        scaleHandles.visible = false;
        selectionBox.visible = false;
        if (selectionGroup.children.length > 0) {
            const children = [...selectionGroup.children].filter(c => c !== selectionBox && c !== scaleHandles);
            children.forEach(obj => scene.attach(obj));
        }
        return; 
    }

    const worldBox = new THREE.Box3();
    state.selectedObjects.forEach(o => worldBox.union(new THREE.Box3().setFromObject(o)));
    const center = new THREE.Vector3(); worldBox.getCenter(center);

    // Clear group transforms before re-attaching
    selectionGroup.position.set(0, 0, 0); selectionGroup.rotation.set(0, 0, 0); selectionGroup.scale.set(1, 1, 1);
    selectionGroup.updateMatrixWorld(true);
    
    selectionGroup.remove(selectionBox); selectionGroup.remove(scaleHandles);
    selectionGroup.position.copy(center);

    if (state.selectedObjects.length === 1) selectionGroup.quaternion.copy(state.selectedObjects[0].getWorldQuaternion(new THREE.Quaternion()));
    else selectionGroup.rotation.set(0, 0, 0);

    selectionGroup.scale.set(1, 1, 1); selectionGroup.updateMatrixWorld(true);

    // Only physically attach meshes/groups, don't move lights into the tool group
    state.selectedObjects.forEach(o => {
        if (!o.isLight) selectionGroup.attach(o);
    });

    const tightBox = new THREE.Box3(), inverseGroupMatrix = selectionGroup.matrixWorld.clone().invert();
    state.selectedObjects.forEach(o => {
        if (o.geometry) {
            if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
            const localBox = o.geometry.boundingBox.clone();
            localBox.applyMatrix4(o.matrixWorld.clone().premultiply(inverseGroupMatrix));
            tightBox.union(localBox);
        } else {
            const objBox = new THREE.Box3().setFromObject(o);
            objBox.applyMatrix4(inverseGroupMatrix);
            tightBox.union(objBox);
        }
    });

    const size = new THREE.Vector3(); tightBox.getSize(size);
    selectionBox.scale.copy(size); selectionBox.position.set(0, 0, 0); state.initialSize.copy(size);
    selectionGroup.add(selectionBox); selectionGroup.add(scaleHandles);

    if (state.currentMode === 'scale') { transformControls.detach(); updateScaleHandles(); }
    else if (state.currentMode !== 'select') { transformControls.attach(selectionGroup); }

    selectionBox.visible = true;
}



export function setMode(mode) {
    state.currentMode = mode;
    updateToolUI(`mode-${mode}`);
    transformControls.detach(); scaleHandles.visible = false;
    if (state.selectedObjects.length > 0) {
        if (mode === 'scale') { scaleHandles.visible = true; updateScaleHandles(); } 
        else if (mode === 'move' || mode === 'rotate') {
            transformControls.setMode(mode === 'move' ? 'translate' : 'rotate');
            transformControls.setSpace('local'); transformControls.attach(selectionGroup);
        }
    }
}

['select', 'move', 'scale', 'rotate'].forEach(mode => {
    const action = () => setMode(mode);
    const btnG = document.getElementById(`mode-${mode}`), btnM = document.getElementById(`mode-${mode}-m`);
    if (btnG) btnG.onclick = action; if (btnM) btnM.onclick = action;
});

// --- SHAPE CREATION & TABS ---
export function getSurfacePosition(intersect, obj) {
    const normal = intersect.face.normal.clone(); normal.applyQuaternion(intersect.object.quaternion); 
    const size = new THREE.Vector3();
    if (obj.geometry) {
        if (!obj.geometry.boundingBox) obj.geometry.computeBoundingBox();
        obj.geometry.boundingBox.getSize(size); size.multiply(obj.scale);
    } else { new THREE.Box3().setFromObject(obj).getSize(size); }
    const localNormal = normal.clone().applyQuaternion(obj.quaternion.clone().invert());
    const thickness = Math.abs(localNormal.x * size.x) + Math.abs(localNormal.y * size.y) + Math.abs(localNormal.z * size.z);
    return intersect.point.clone().add(normal.clone().multiplyScalar(thickness / 2));
}

export function placeOnTargetSurface(obj) {
    raycaster.setFromCamera(new THREE.Vector2(0, 0), camera); 

    // We MUST ignore the object we are placing AND its children
    const targets = state.selectableObjects.filter(o => {
        return o !== obj && !obj.children.includes(o) && o !== selectionGroup;
    });

    const intersects = raycaster.intersectObjects(targets);

    if (intersects.length > 0) {
        const pos = getSurfacePosition(intersects[0], obj);
        obj.position.set(snapValue(pos.x), snapValue(pos.y), snapValue(pos.z));
    } else {
        const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
        const pos = camera.position.clone().add(forward.multiplyScalar(10));
        obj.position.set(snapValue(pos.x), snapValue(pos.y), snapValue(pos.z));
        if (obj.position.y < 1) obj.position.y = 1; 
    }
}

// --- COPY & PASTE ---

// Store the data of what we copied
export let clipboard = [];

// Batch flags to avoid expensive refresh/inspector work during paste/duplicate.
// main goal: prevent lag spikes and partial hierarchy sync issues.
state.isPastingOrDuplicating = false;


// Determines how selecting a mesh that belongs to a model behaves in 3D.
// 'container' => select the model/folder container as the inspector target.
// 'contents' => select the clicked meshes.
const DEFAULT_SELECTION_CONTAINER_MODE = 'container';

if (!state.selectionContainerMode) state.selectionContainerMode = DEFAULT_SELECTION_CONTAINER_MODE;

// Track which explorer containers (folder/model) are currently selected.
// Selection in the 3D view should be able to include container items as first-class selections.
if (!state.selectedContainerItems) state.selectedContainerItems = new Set();


function serializeHierarchyItem(item) {
    // Prevent copying the root protected folders themselves
    if (item.isProtected && (item.id === 'world-folder' || item.id === 'folder-lighting' || item.id === 'folder-ui')) return null;

    const data = {
        type: item.type,
        subType: item.subType,
        name: item.name,
        properties: item.properties ? JSON.parse(JSON.stringify(item.properties)) : {}, // Deep copy properties
        originalParentId: findParentItem(item.id)?.id, // Store the original parent's ID for paste-into-parent behavior
        children: []
    };

    if (item.objectRef) {
        const obj = item.objectRef;

        // Capture world transform to ensure consistent relative placement when pasting/duplicating
        const worldPos = new THREE.Vector3();
        const worldQuat = new THREE.Quaternion();
        const worldScale = new THREE.Vector3();
        
        obj.updateMatrixWorld(true);
        obj.getWorldPosition(worldPos);
        obj.getWorldQuaternion(worldQuat);
        obj.getWorldScale(worldScale);

        data.transform = {
            position: [worldPos.x, worldPos.y, worldPos.z],
            quaternion: [worldQuat.x, worldQuat.y, worldQuat.z, worldQuat.w],
            scale: [worldScale.x, worldScale.y, worldScale.z]
        };
        
        if (obj.isMesh) {
            data.geometry = obj.geometry.clone();
            // Handle multi-material arrays (common on objects with Surface UI)
            if (Array.isArray(obj.material)) {
                data.material = obj.material.map(m => m.clone());
            } else if (obj.material) {
                data.material = obj.material.clone();
            }

            // Capture effective color tint for system materials (Neon/Bricks) or standard color
            const primaryMat = Array.isArray(obj.material) ? obj.material[0] : obj.material;
            data.colorHex = obj.userData.bricksColorHex || 
                           obj.userData.emissiveColorHex || 
                           (primaryMat && primaryMat.color ? '#' + primaryMat.color.getHexString() : null);
        }
        data.userData = JSON.parse(JSON.stringify(obj.userData || {}));
        data.castShadow = obj.castShadow;
        data.receiveShadow = obj.receiveShadow;
    }

    if (item.children) {
        item.children.forEach(child => {
            const childData = serializeHierarchyItem(child);
            if (childData) data.children.push(childData);
        });
    }

    return data;
}

function instantiateSerializedItem(data, parentItem, transformAdjustment = null) {
    const newItem = {
        id: `${data.type}-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
        type: data.type,
        subType: data.subType,
        name: data.name,
        properties: JSON.parse(JSON.stringify(data.properties || {})),
        children: []
    };

    if (data.transform) {
        let obj;
        if (data.type === 'object' || data.type === 'spawn') {
            const geo = data.geometry ? data.geometry.clone() : new THREE.BoxGeometry(1, 1, 1);
            let mat;
            if (Array.isArray(data.material)) {
                mat = data.material.map(m => m.clone());
            } else {
                mat = data.material ? data.material.clone() : new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true });
            }
            obj = new THREE.Mesh(geo, mat);
            state.selectableObjects.push(obj);
        } else if (data.type === 'light') {
            const lp = data.properties || {};
            obj = new THREE.PointLight(lp.color || 0xffffff, lp.intensity || 1, lp.range || 10);
        }

        if (obj) {
            obj.name = data.name;
            
            let finalPos = new THREE.Vector3(...data.transform.position);
            if (transformAdjustment) {
                const offset = finalPos.clone().sub(transformAdjustment.originalCenter);
                finalPos.copy(transformAdjustment.targetPoint).add(offset);
                finalPos.set(snapValue(finalPos.x), snapValue(finalPos.y), snapValue(finalPos.z));
            }
            
            obj.position.copy(finalPos);
            obj.quaternion.set(...data.transform.quaternion);
            obj.scale.set(...data.transform.scale);
            obj.userData = JSON.parse(JSON.stringify(data.userData || {}));
            if (data.colorHex) obj.userData.partColor = data.colorHex;
            obj.castShadow = data.castShadow ?? (obj.userData.castShadow !== false);
            obj.receiveShadow = data.receiveShadow ?? true;
            scene.add(obj);
            newItem.objectRef = obj;

            if (obj.isMesh && obj.userData.material && materials.cache[obj.userData.material]) {
                materials.applyToObject(obj, obj.userData.material, obj.userData.tileScaleX || 1, obj.userData.tileScaleY || 1);
                
                // Restore color tint after material application
                if (data.colorHex) {
                    if (obj.userData.material === 'Neon') {
                        obj.material.color.set(data.colorHex).multiplyScalar(25);
                    } else {
                        obj.material.color.set(data.colorHex);
                    }
                }
            }
        }
    }

    parentItem.children.push(newItem);

    if (data.children) {
        data.children.forEach(childData => instantiateSerializedItem(childData, newItem, transformAdjustment));
    }

    return newItem;
}

export function copySelection() {
    clipboard = [];
    const selectedIds = new Set();
    
    // 1. Collect IDs from all selection sources (Explorer items take priority for containers)
    state.selectedItems.forEach(item => selectedIds.add(item.id));

    if (state.selectedObjects.length > 0) {
        state.selectedObjects.forEach(obj => {
            const id = findItemIdForObject(obj);
            if (id) selectedIds.add(id);
        });
    }

    if (state.currentSelectedItem) {
        selectedIds.add(state.currentSelectedItem.id);
    }

    if (selectedIds.size === 0) return;

    // 2. Filter to only top-most items of the selection to avoid redundant copying
    const topLevelIds = [];
    selectedIds.forEach(id => {
        let parent = findParentItem(id);
        let parentIsSelected = false;
        while (parent) {
            if (selectedIds.has(parent.id)) { parentIsSelected = true; break; }
            parent = findParentItem(parent.id);
        }
        if (!parentIsSelected) topLevelIds.push(id);
    });

    // 3. Serialize selection
    topLevelIds.forEach(id => {
        const item = explorerHierarchy.findItemById(id);
        if (item) {
            const data = serializeHierarchyItem(item);
            if (data) clipboard.push(data);
        }
    });
}

export function duplicateSelected() {
    const canCopy = state.selectedObjects.length > 0 || state.currentSelectedItem || state.selectedItems.size > 0;
    if (!canCopy) return;

    // Save current clipboard to restore it later
    const oldClipboard = [...clipboard];
    
    copySelection();
    
    if (clipboard.length > 0) {
        // pasteSelection with null target will automatically use originalParentId from the clipboard data
        pasteSelection(null, true);
    }

    // Restore clipboard so duplicate doesn't overwrite copy
    clipboard = oldClipboard;
}

export function pasteSelection(targetParentId = null, isDuplicate = false) {
    if (clipboard.length === 0) return;

    state.isPastingOrDuplicating = true;
    const newItems = [];

    let originalCenter = new THREE.Vector3();
    let targetPoint = new THREE.Vector3();
    let transformAdjustment = null;

    if (!isDuplicate) {
        // 1. Calculate the average world-space center of all copied objects (recursive)
        let count = 0;
        const collectPos = (list) => {
            list.forEach(d => {
                if (d.transform) { originalCenter.add(new THREE.Vector3(...d.transform.position)); count++; }
                if (d.children) collectPos(d.children);
            });
        };
        collectPos(clipboard);

        if (count > 0) originalCenter.divideScalar(count);

        // 2. Raycast to find the surface target point
        raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
        const intersects = raycaster.intersectObjects(state.selectableObjects);

        if (intersects.length > 0) {
            targetPoint.copy(intersects[0].point);
        } else {
            const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
            targetPoint.copy(camera.position).add(forward.multiplyScalar(10));
            if (targetPoint.y < 1) targetPoint.y = 1;
        }

        transformAdjustment = { originalCenter, targetPoint };
    }

    clipboard.forEach((data, index) => {
        let effectivePasteParent = null;

        // Priority 1: If a specific targetParentId was provided (e.g., from right-click "Paste into")
        if (targetParentId) {
            effectivePasteParent = explorerHierarchy.findItemById(targetParentId);
        }

        // Priority 2: If the copied item itself had a parent, try to paste into that parent's equivalent
        if (!effectivePasteParent && data.originalParentId) {
            effectivePasteParent = explorerHierarchy.findItemById(data.originalParentId);
        }

        // Priority 3: Fallback to World folder
        if (!effectivePasteParent) {
            effectivePasteParent = explorerHierarchy.getOrCreateWorld();
        }

        // Ensure the effectivePasteParent has a children array
        if (!effectivePasteParent.children) {
            effectivePasteParent.children = [];
        }
        explorerHierarchy.expanded[effectivePasteParent.id] = true;

        const newItem = instantiateSerializedItem(data, effectivePasteParent, transformAdjustment);
        newItems.push(newItem);
    });

    state.isPastingOrDuplicating = false;
    refreshSceneState();
    updateExplorer();

    // Fully select the entire newly pasted/duplicated hierarchy
    clearSelection();
    newItems.forEach(item => {
        selectHierarchyItem(item, true);
    });

    // Ensure the first top-level item is highlighted in the explorer/inspector
    if (newItems.length > 0) {
        state.currentSelectedItem = newItems[0];
        showInspector();
    }
}



const createShape = (isModelTab = false) => {
    const selectorId = isModelTab ? 'shape-selector-m' : 'shape-selector';
    const shapeType = document.getElementById(selectorId).value;
    
    // Using Unit Geometries so the Scale property correctly represents the object's dimensions
    let geometry;
    if (shapeType === 'cube') geometry = new THREE.BoxGeometry(1, 1, 1);
    else if (shapeType === 'sphere') geometry = new THREE.SphereGeometry(0.5, 32, 32);
    else if (shapeType === 'cylinder') geometry = new THREE.CylinderGeometry(0.5, 0.5, 1, 32);

    // Start objects at a standard size of 2x2x2 or similar
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: false, roughness: 0.8 });
    mat.shadowSide = THREE.DoubleSide;
    const mesh = new THREE.Mesh(geometry, mat);
    
    mesh.castShadow = true; 
    mesh.userData.partColor = '#ffffff';

    mesh.receiveShadow = true; 
    const meshName = explorerHierarchy.getNextName('object');
    mesh.name = meshName;

    if (shapeType === 'cube') mesh.scale.set(2, 2, 2);
    else if (shapeType === 'sphere') mesh.scale.set(2.4, 2.4, 2.4);
    else if (shapeType === 'cylinder') mesh.scale.set(2, 2, 2);
    
    mesh.userData.anchored = true;
    mesh.userData.castShadow = true;
    mesh.userData.canCollide = true;
    mesh.userData.density = 10;
    mesh.userData.velocity = new THREE.Vector3(0, 0, 0);

    scene.add(mesh); 
    state.selectableObjects.push(mesh);
    
    // Add to World folder in hierarchy
    const worldFolder = explorerHierarchy.getOrCreateWorld();
    const hierarchyItem = { id: `obj-${Date.now()}`, type: 'object', name: mesh.name, objectRef: mesh, children: [] };
    worldFolder.children.push(hierarchyItem);
    
    placeOnTargetSurface(mesh); 
    updateObjectUVs(mesh);
    attachTool(mesh, false); 
    refreshSceneState();
    updateExplorer();
};

document.getElementById('add-shape').onclick = () => createShape(false);
document.getElementById('add-shape-m').onclick = () => createShape(true);

const shapeSelectGame = document.getElementById('shape-selector'), shapeSelectModel = document.getElementById('shape-selector-m');
shapeSelectGame.onchange = () => { shapeSelectModel.value = shapeSelectGame.value; };
shapeSelectModel.onchange = () => { shapeSelectGame.value = shapeSelectModel.value; };

const toggleTabs = (toModel) => {
    document.getElementById('controls-model').style.display = toModel ? 'flex' : 'none';
    document.getElementById('controls-game').style.display = toModel ? 'none' : 'flex';
    document.getElementById('tab-btn-model').classList.toggle('active-tab', toModel);
    document.getElementById('tab-btn-game').classList.toggle('active-tab', !toModel);
};
document.getElementById('tab-btn-model').onclick = () => toggleTabs(true);
document.getElementById('tab-btn-game').onclick = () => toggleTabs(false);

const snapInput = document.getElementById('snap-amount');
const rotationSnapInput = document.getElementById('rotation-snap-amount');

/**
 * Snaps a value to the nearest increment.
 * @param {number} v - The value to snap.
 * @param {number} [amount] - The snap increment (defaults to global snapAmount).
 */
export const snapValue = (v, amount = state.snapAmount) => (amount > 0 ? Math.round(v / amount) * amount : v);

// Rotation snap helpers

function updateSnaps() {
    // Translation + scale snap (default snap)
    state.snapAmount = parseFloat(snapInput?.value) || 0;
    transformControls.translationSnap = state.snapAmount;

    // Rotation snap is controlled by Rotation Snap ONLY
    const rotationStepDeg = parseFloat(rotationSnapInput?.value) || 0;
    state.rotationSnapAmount = rotationStepDeg;
    state.rotationSnapDegrees = rotationStepDeg;
    transformControls.rotationSnap = THREE.MathUtils.degToRad(rotationStepDeg);
}

if (snapInput) {
    snapInput.oninput = updateSnaps;
}
if (rotationSnapInput) {
    rotationSnapInput.oninput = updateSnaps;
}

// Initialize UI values from state
if (snapInput) snapInput.value = state.snapAmount;
if (rotationSnapInput) rotationSnapInput.value = state.rotationSnapAmount;

updateSnaps();

// --- TAB & IMAGE EDITOR IMPLEMENTATION ---

export function updateTabs() {
    tabContainer.innerHTML = '';
    state.openTabs.forEach(tab => {
        const el = document.createElement('div');
        el.style.cssText = `padding: 4px 15px; background: ${state.activeTabId === tab.id ? '#333' : '#1a1a1a'}; color: #fff; cursor: pointer; border: 1px solid #444; border-bottom: none; border-radius: 4px 4px 0 0; margin-right: 2px; display: flex; align-items: center; gap: 8px; font-size: 12px; height: 24px;`;
        
        const name = document.createElement('span');
        name.innerText = tab.name;
        el.appendChild(name);

        if (tab.id !== 'game-editor') {
            const close = document.createElement('span');
            close.innerText = '✕';
            close.style.fontSize = '10px';
            close.onclick = (e) => {
                e.stopPropagation();
                state.openTabs = state.openTabs.filter(t => t.id !== tab.id);
                if (state.activeTabId === tab.id) switchTab('game-editor');
                updateTabs();
            };
            el.appendChild(close);
        }

        el.onclick = () => {
            makeTabPersistent(tab.id);
            switchTab(tab.id);
        };
        tabContainer.appendChild(el);
    });
}

export function makeTabPersistent(id) {
    const tab = state.openTabs.find(t => t.id === id);
    if (tab) tab.persistent = true;
    updateTabs();
}

export function switchTab(id) {
    state.activeTabId = id;
    if (id === 'game-editor') {
        imageEditorWorkspace.style.display = 'none';
        soundEditorWorkspace.style.display = 'none';
        renderer.domElement.style.display = 'block';
        showInspector();
    } else if (id.startsWith('img-')) {
        imageEditorWorkspace.style.display = 'flex';
        soundEditorWorkspace.style.display = 'none';
        renderer.domElement.style.display = 'none';
        renderImageEditor(id);
    } else if (id.startsWith('snd-')) {
        soundEditorWorkspace.style.display = 'flex';
        imageEditorWorkspace.style.display = 'none';
        renderer.domElement.style.display = 'none';
        renderSoundEditor(id);
    }
    updateTabs();
}

// --- IMAGE EDITOR STATE ---
let onionSkinning = false;
let currentTool = 'pencil';
let brushColor = '#000000';
let brushSize = 1;
let lastPos = null;
let startPos = null;
let isCanvasTransforming = false;

function renderImageEditor(assetId) {
    const asset = state.imageAssets[assetId];
    imageEditorWorkspace.innerHTML = '';
    
    // 1. Toolbar Section
    const toolbar = document.createElement('div');
    toolbar.style.cssText = 'height: 45px; background: #2a2a2a; border-bottom: 1px solid #444; display: flex; align-items: center; padding: 0 15px; gap: 10px; z-index: 10;';
    
    const createToolBtn = (icon, id, title) => {
        const btn = document.createElement('button');
        btn.innerText = icon;
        btn.title = title;
        btn.style.cssText = `padding: 6px 10px; background: ${currentTool === id ? '#00ff88' : '#333'}; color: ${currentTool === id ? '#000' : '#fff'}; border: 1px solid #444; border-radius: 4px; cursor: pointer; font-size: 16px; display: flex; align-items: center; justify-content: center;`;
        btn.onclick = () => { currentTool = id; renderImageEditor(assetId); };
        toolbar.appendChild(btn);
    };

    createToolBtn('✏️', 'pencil', 'Pencil');
    createToolBtn('🧽', 'eraser', 'Eraser');
    createToolBtn('📐', 'canvas', 'Canvas');
    createToolBtn('🪣', 'bucket', 'Flood Fill');
    createToolBtn('📏', 'line', 'Line');
    createToolBtn('▭', 'rect', 'Rectangle');
    createToolBtn('◯', 'circle', 'Circle');

    const divider = () => {
        const d = document.createElement('div');
        d.style.cssText = 'width: 1px; height: 24px; background: #444; margin: 0 5px;';
        return d;
    };
    toolbar.appendChild(divider());

    const picker = document.createElement('input');
    picker.type = 'color';
    picker.value = brushColor;
    picker.style.cssText = 'width: 28px; height: 28px; border: 1px solid #444; background: none; cursor: pointer; padding: 0;';
    picker.oninput = (e) => brushColor = e.target.value;
    toolbar.appendChild(picker);

    if (currentTool !== 'bucket') {
    const sizeLabel = document.createElement('label');
    sizeLabel.style.cssText = 'color: #aaa; font-size: 11px; margin-right: -10px;';
    sizeLabel.innerText = 'Size:';
    toolbar.appendChild(sizeLabel);

    const sizeInput = document.createElement('input');
    sizeInput.type = 'range'; sizeInput.min = '1'; sizeInput.max = '20'; sizeInput.value = brushSize;
    sizeInput.style.cssText = 'width: 80px; cursor: pointer;';
    sizeInput.oninput = (e) => brushSize = parseInt(e.target.value);
    toolbar.appendChild(sizeInput);
    }

    // Canvas Size Controls
    const resLabel = document.createElement('span');
    resLabel.style.cssText = 'color: #aaa; font-size: 11px; margin-left: auto;';
    resLabel.innerText = 'Resolution:';
    toolbar.appendChild(resLabel);

    const createResInput = (val, onSave) => {
        const inp = document.createElement('input');
        inp.type = 'number'; inp.value = val;
        inp.style.cssText = 'width: 50px; background: #111; border: 1px solid #444; color: #fff; font-size: 11px; padding: 2px;';
        inp.onchange = (e) => onSave(parseInt(e.target.value));
        return inp;
    };

    const handleCanvasAction = (newW, newH, shiftX, shiftY) => {
        if (newW < 1 || newH < 1) return;
        const frames = asset.frames;
        const newFrames = [];
        let loadedCount = 0;
        frames.forEach((f, i) => {
            const temp = document.createElement('canvas');
            temp.width = newW; temp.height = newH;
            const tCtx = temp.getContext('2d');
            const img = new Image();
            img.onload = () => {
                tCtx.drawImage(img, Math.round(shiftX), Math.round(shiftY));
                newFrames[i] = temp.toDataURL();
                loadedCount++;
                if (loadedCount === frames.length) {
                    asset.width = newW;
                    asset.height = newH;
                    asset.frames = newFrames;
                    renderImageEditor(assetId);
                }
            };
            img.src = f;
        });
    };

    toolbar.appendChild(createResInput(asset.width, (v) => handleCanvasAction(v, asset.height, 0, 0)));
    const xLabel = document.createElement('span'); xLabel.innerText = '×'; xLabel.style.color = '#777';
    toolbar.appendChild(xLabel);
    toolbar.appendChild(createResInput(asset.height, (v) => handleCanvasAction(asset.width, v, 0, 0)));

    imageEditorWorkspace.appendChild(toolbar);

    // 2. Main Canvas Area (Flexible)
    const canvasArea = document.createElement('div');
    canvasArea.style.cssText = 'flex: 1; display: flex; align-items: center; justify-content: center; background: #111; position: relative; overflow: auto; padding: 40px;';
    
    const mainCanvas = document.createElement('canvas');
    const w = asset.width || 128, h = asset.height || 128;
    mainCanvas.width = w; mainCanvas.height = h;
    
    // High-visibility custom crosshair cursor (black and white outline)
    const cursorSvg = `<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 32 32'><path d='M16 4v24M4 16h24' stroke='white' stroke-width='3' fill='none'/><path d='M16 4v24M4 16h24' stroke='black' stroke-width='1' fill='none'/></svg>`;
    const cursorUrl = `url("data:image/svg+xml;base64,${btoa(cursorSvg)}") 16 16, crosshair`;

    mainCanvas.style.cssText = `background: white; border: 1px solid #555; image-rendering: pixelated; cursor: ${cursorUrl}; box-shadow: 0 0 30px rgba(0,0,0,0.8); transition: transform 0.1s;`;
    
    // Scale the display size based on dimensions (e.g., zoom pixel art)
    const displaySize = Math.min(window.innerWidth * 0.9, window.innerHeight * 0.75);
    const aspect = w / h;
    if (aspect >= 1) {
        mainCanvas.style.width = displaySize + 'px';
        mainCanvas.style.height = (displaySize / aspect) + 'px';
    } else {
        mainCanvas.style.height = displaySize + 'px';
        mainCanvas.style.width = (displaySize * aspect) + 'px';
    }

    const ctx = mainCanvas.getContext('2d');
    // Internal drawing canvas to maintain clean transparent image data
    const drawCanvas = document.createElement('canvas');
    drawCanvas.width = w; drawCanvas.height = h;
    const drawCtx = drawCanvas.getContext('2d', { alpha: true });

    const onionImg = new Image();
    if (onionSkinning && asset.currentFrame > 0) {
        onionImg.src = asset.frames[asset.currentFrame - 1];
    }

    const img = new Image();
    img.onload = () => {
        drawCtx.drawImage(img, 0, 0);
        redraw();
    };
    img.src = asset.frames[asset.currentFrame];

    const redraw = () => {
        ctx.clearRect(0, 0, w, h);
        if (onionSkinning && asset.currentFrame > 0 && onionImg.complete) {
            ctx.save();
            ctx.globalAlpha = 0.3;
            ctx.drawImage(onionImg, 0, 0);
            ctx.restore();
        }
        ctx.drawImage(drawCanvas, 0, 0);
    };

    const floodFill = (startX, startY, fillColor) => {
        const imageData = drawCtx.getImageData(0, 0, drawCanvas.width, drawCanvas.height);
        const data = imageData.data;
        const targetColor = getPixel(Math.floor(startX), Math.floor(startY));
        const fillRGB = hexToRgb(fillColor);

        if (!targetColor || colorsMatch(targetColor, [fillRGB.r, fillRGB.g, fillRGB.b, 255])) return;

        const stack = [[Math.floor(startX), Math.floor(startY)]];
        while (stack.length > 0) {
            const [x, y] = stack.pop();
            const currentColor = getPixel(x, y);
            if (colorsMatch(currentColor, targetColor)) {
                setPixel(x, y, fillRGB);
                if (x > 0) stack.push([x - 1, y]);
                if (x < drawCanvas.width - 1) stack.push([x + 1, y]);
                if (y > 0) stack.push([x, y - 1]);
                if (y < drawCanvas.height - 1) stack.push([x, y + 1]);
            }
        }
        drawCtx.putImageData(imageData, 0, 0);

        function getPixel(x, y) {
            const i = (y * drawCanvas.width + x) * 4;
            return [data[i], data[i+1], data[i+2], data[i+3]];
        }
        function setPixel(x, y, rgb) {
            const i = (y * drawCanvas.width + x) * 4;
            data[i] = rgb.r; data[i+1] = rgb.g; data[i+2] = rgb.b; data[i+3] = 255;
        }
        function colorsMatch(c1, c2) {
            return c1[0] === c2[0] && c1[1] === c2[1] && c1[2] === c2[2] && c1[3] === c2[3];
        }
        function hexToRgb(hex) {
            const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
            return result ? { r: parseInt(result[1], 16), g: parseInt(result[2], 16), b: parseInt(result[3], 16) } : null;
        }
    };

    let painting = false;
    const paint = (e) => {
        const rect = mainCanvas.getBoundingClientRect();
        const scaleX = w / rect.width;
        const scaleY = h / rect.height;
        const x = (e.clientX - rect.left) * scaleX;
        const y = (e.clientY - rect.top) * scaleY;

        if (currentTool === 'bucket') {
            floodFill(x, y, brushColor);
            redraw();
            // Save state immediately for the bucket tool
            asset.frames[asset.currentFrame] = drawCanvas.toDataURL();
            refreshSceneState();
            return;
        }

        if (['line', 'rect', 'circle'].includes(currentTool)) {
            if (!startPos) return;
            redraw(); // Clear the main canvas to show preview
            ctx.strokeStyle = brushColor;
            ctx.lineWidth = brushSize;
            ctx.lineCap = 'round';
            
            if (currentTool === 'line') {
                ctx.beginPath();
                ctx.moveTo(startPos.x, startPos.y);
                ctx.lineTo(x, y);
                ctx.stroke();
            } else if (currentTool === 'rect') {
                ctx.strokeRect(startPos.x, startPos.y, x - startPos.x, y - startPos.y);
            } else if (currentTool === 'circle') {
                const cx = startPos.x + (x - startPos.x) / 2;
                const cy = startPos.y + (y - startPos.y) / 2;
                const rx = Math.abs(x - startPos.x) / 2;
                const ry = Math.abs(y - startPos.y) / 2;
                ctx.beginPath();
                ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
                ctx.stroke();
            }
            return;
        }

        drawCtx.lineCap = 'round';
        drawCtx.lineJoin = 'round';
        drawCtx.lineWidth = brushSize;

        if (currentTool === 'pencil') {
            drawCtx.globalCompositeOperation = 'source-over';
            drawCtx.strokeStyle = brushColor;
            drawCtx.fillStyle = brushColor;
        } else if (currentTool === 'eraser') {
            drawCtx.globalCompositeOperation = 'destination-out';
        }

        drawCtx.beginPath();
        if (lastPos) {
            drawCtx.moveTo(lastPos.x, lastPos.y);
            drawCtx.lineTo(x, y);
        } else {
            drawCtx.moveTo(x, y);
            drawCtx.lineTo(x, y);
        }
        drawCtx.stroke();
        
        lastPos = { x, y };
        redraw();
    };

    mainCanvas.onmousedown = (e) => { 
        if (currentTool === 'canvas') {
            e.stopPropagation();
            isCanvasTransforming = 'move';
            const rect = mainCanvas.getBoundingClientRect();
            const areaRect = canvasArea.getBoundingClientRect();
            startPos = { 
                x: e.clientX, y: e.clientY, 
                w: asset.width, h: asset.height,
                wrapperL: rect.left - areaRect.left,
                wrapperT: rect.top - areaRect.top,
                wrapperW: rect.width,
                wrapperH: rect.height
            };
            return;
        }
        const rect = mainCanvas.getBoundingClientRect();
        const scaleX = w / rect.width;
        const scaleY = h / rect.height;
        const x = (e.clientX - rect.left) * scaleX;
        const y = (e.clientY - rect.top) * scaleY;
        startPos = { x, y };

        if (currentTool === 'bucket') {
            paint(e);
        } else {
            painting = true; lastPos = null; paint(e); 
        }
    };

    window.onmouseup = (e) => {
        if (isCanvasTransforming) {
            const scaleX = asset.width / startPos.wrapperW;
            const scaleY = asset.height / startPos.wrapperH;
            const dx = (e.clientX - startPos.x) * scaleX;
            const dy = (e.clientY - startPos.y) * scaleY;

            let nW = asset.width, nH = asset.height, sX = 0, sY = 0;
            const side = isCanvasTransforming;

            if (side === 'move') { sX = -dx; sY = -dy; }
            else {
                if (side.includes('e')) nW = startPos.w + dx;
                if (side.includes('w')) { nW = startPos.w - dx; sX = -dx; }
                if (side.includes('s')) nH = startPos.h + dy;
                if (side.includes('n')) { nH = startPos.h - dy; sY = -dy; }
            }

            if (nW > 0 && nH > 0) {
                handleCanvasAction(Math.round(nW), Math.round(nH), sX, sY);
            }
            isCanvasTransforming = false;
            return;
        }
        if (painting) {
            // If we were drawing a shape, commit it to the actual drawing context
            if (['line', 'rect', 'circle'].includes(currentTool) && startPos) {
                const rect = mainCanvas.getBoundingClientRect();
                const scaleX = w / rect.width;
                const scaleY = h / rect.height;
                const endX = (e.clientX - rect.left) * scaleX;
                const endY = (e.clientY - rect.top) * scaleY;

                drawCtx.strokeStyle = brushColor;
                drawCtx.lineWidth = brushSize;
                drawCtx.lineCap = 'round';

                if (currentTool === 'line') {
                    drawCtx.beginPath();
                    drawCtx.moveTo(startPos.x, startPos.y);
                    drawCtx.lineTo(endX, endY);
                    drawCtx.stroke();
                } else if (currentTool === 'rect') {
                    drawCtx.strokeRect(startPos.x, startPos.y, endX - startPos.x, endY - startPos.y);
                } else if (currentTool === 'circle') {
                    const cx = startPos.x + (endX - startPos.x) / 2;
                    const cy = startPos.y + (endY - startPos.y) / 2;
                    const rx = Math.abs(endX - startPos.x) / 2;
                    const ry = Math.abs(endY - startPos.y) / 2;
                    drawCtx.beginPath();
                    drawCtx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
                    drawCtx.stroke();
                }
            }
            asset.frames[asset.currentFrame] = drawCanvas.toDataURL();
            refreshSceneState();
            redraw(); // Final sync of preview canvas
        }
        painting = false; lastPos = null; startPos = null;
    };
    const onMouseMove = (e) => { 
        if (isCanvasTransforming) {
            const dx = e.clientX - startPos.x;
            const dy = e.clientY - startPos.y;
            const wrapper = canvasArea.querySelector('#canvas-transform-wrapper');
            if (wrapper) {
                let nL = startPos.wrapperL, nT = startPos.wrapperT, nW = startPos.wrapperW, nH = startPos.wrapperH;
                if (isCanvasTransforming === 'move') { nL += dx; nT += dy; }
                else {
                    if (isCanvasTransforming.includes('e')) nW += dx;
                    if (isCanvasTransforming.includes('w')) { nW -= dx; nL += dx; }
                    if (isCanvasTransforming.includes('s')) nH += dy;
                    if (isCanvasTransforming.includes('n')) { nH -= dy; nT += dy; }
                }
                wrapper.style.left = nL + 'px'; wrapper.style.top = nT + 'px';
                wrapper.style.width = nW + 'px'; wrapper.style.height = nH + 'px';
            }
            return;
        }
        if (painting && currentTool !== 'bucket') paint(e); 
    };
    mainCanvas.onmousemove = onMouseMove;
    canvasArea.onmousemove = (e) => { if (isCanvasTransforming) onMouseMove(e); };
    
    canvasArea.appendChild(mainCanvas);
    imageEditorWorkspace.appendChild(canvasArea);

    if (currentTool === 'canvas') {
        // Force a layout reflow so getBoundingClientRect provides accurate screen positions
        imageEditorWorkspace.offsetHeight;

        const hSize = 10;
        const canvasRect = mainCanvas.getBoundingClientRect();
        const areaRect = canvasArea.getBoundingClientRect();
        const l = canvasRect.left - areaRect.left, t = canvasRect.top - areaRect.top;
        const wC = canvasRect.width, hC = canvasRect.height;

        const wrapper = document.createElement('div');
        wrapper.id = 'canvas-transform-wrapper';
        wrapper.style.cssText = `position: absolute; left: ${l}px; top: ${t}px; width: ${wC}px; height: ${hC}px; border: 2px dashed #00ff88; z-index: 1000; pointer-events: none;`;
        canvasArea.appendChild(wrapper);

        const createHandle = (side, cursor, posStyle) => {
            const h = document.createElement('div');
            h.style.cssText = `position: absolute; width: ${hSize}px; height: ${hSize}px; background: #00ff88; border: 1px solid #000; cursor: ${cursor}; pointer-events: auto; ${posStyle}`;
            h.onmousedown = (e) => {
                e.stopPropagation();
                isCanvasTransforming = side;
                startPos = { x: e.clientX, y: e.clientY, w: asset.width, h: asset.height, wrapperL: l, wrapperT: t, wrapperW: wC, wrapperH: hC };
            };
            wrapper.appendChild(h);
        };

        createHandle('nw', 'nwse-resize', `left: ${-hSize/2}px; top: ${-hSize/2}px;`);
        createHandle('n', 'ns-resize', `left: calc(50% - ${hSize/2}px); top: ${-hSize/2}px;`);
        createHandle('ne', 'nesw-resize', `right: ${-hSize/2}px; top: ${-hSize/2}px;`);
        createHandle('w', 'ew-resize', `left: ${-hSize/2}px; top: calc(50% - ${hSize/2}px);`);
        createHandle('e', 'ew-resize', `right: ${-hSize/2}px; top: calc(50% - ${hSize/2}px);`);
        createHandle('sw', 'nesw-resize', `left: ${-hSize/2}px; bottom: ${-hSize/2}px;`);
        createHandle('s', 'ns-resize', `left: calc(50% - ${hSize/2}px); bottom: ${-hSize/2}px;`);
        createHandle('se', 'nwse-resize', `right: ${-hSize/2}px; bottom: ${-hSize/2}px;`);
    }

    // 3. Animation Timeline (Bottom)
    const timeline = document.createElement('div');
    timeline.style.cssText = 'position: absolute; bottom: 0; left: 0; width: 100%; height: 110px; background: #222; border-top: 1px solid #444; display: flex; flex-direction: column;';

    const timelineControls = document.createElement('div');
    timelineControls.style.cssText = 'height: 30px; border-bottom: 1px solid #333; display: flex; align-items: center; padding: 0 20px;';

    const skinToggle = document.createElement('button');
    skinToggle.innerText = '🧅';
    skinToggle.title = 'Onion Skin';
    skinToggle.style.cssText = `padding: 0 10px; height: 24px; background: ${onionSkinning ? '#00ff88' : '#444'}; color: ${onionSkinning ? '#000' : '#fff'}; border: 1px solid #444; border-radius: 4px; font-size: 18px; cursor: pointer; transition: all 0.2s; display: flex; align-items: center; justify-content: center;`;
    skinToggle.onclick = () => { onionSkinning = !onionSkinning; renderImageEditor(assetId); };
    timelineControls.appendChild(skinToggle);
    timeline.appendChild(timelineControls);
    
    const framesArea = document.createElement('div');
    framesArea.style.cssText = 'flex: 1; display: flex; align-items: center; gap: 10px; padding: 0 20px; overflow-x: auto;';

    asset.frames.forEach((f, i) => {
        const thumbWrap = document.createElement('div');
        thumbWrap.style.cssText = `flex-shrink: 0; width: 60px; height: 60px; border: 2px solid ${asset.currentFrame === i ? '#00ff88' : '#444'}; background: #fff; cursor: pointer; position: relative;`;
        const img = document.createElement('img');
        img.src = f; img.style.width = '100%'; img.style.height = '100%'; img.style.objectFit = 'contain';
        thumbWrap.appendChild(img);
        
        const del = document.createElement('div');
        del.innerText = '×';
        del.style.cssText = 'position: absolute; top: -5px; right: -5px; background: red; color: #fff; width: 15px; height: 15px; border-radius: 50%; font-size: 10px; display: flex; align-items: center; justify-content: center;';
        del.onclick = (e) => {
            e.stopPropagation();
            if (asset.frames.length > 1) {
                asset.frames.splice(i, 1);
                asset.currentFrame = Math.max(0, i - 1);
                renderImageEditor(assetId);
            }
        };
        thumbWrap.appendChild(del);

        thumbWrap.onclick = () => { asset.currentFrame = i; renderImageEditor(assetId); };
        framesArea.appendChild(thumbWrap);
    });

    const addFrame = document.createElement('button');
    addFrame.innerText = '+';
    addFrame.style.cssText = 'width: 40px; height: 40px; border-radius: 50%; background: #00ff88; border: none; font-size: 20px; cursor: pointer; flex-shrink: 0;';
    addFrame.onclick = () => {
        asset.frames.push(createBlankFrame(w, h));
        asset.currentFrame = asset.frames.length - 1;
        renderImageEditor(assetId);
    };
    framesArea.appendChild(addFrame);

    timeline.appendChild(framesArea);
    imageEditorWorkspace.appendChild(timeline);
}

// Initialize workspace
updateTabs();
