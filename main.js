import * as CANNON from 'cannon-es';
import * as THREE from 'three';
import { scene, camera, renderer, raycaster, mouse, keys, baseplate, state, composer, uiScene, uiCamera, audioListener, sun, sunDisk, moon } from './setup.js';
import { 
    selectionGroup, scaleHandles, transformControls, attachTool, clearSelection, showRightClickMenu,
    showInspector, updateScaleHandles, updatePropertyValues, getSurfacePosition, snapValue, 
    setMode, updateExplorer, updateToolUI, placeOnTargetSurface, refreshSceneState,
    copySelection, pasteSelection, findItemIdForObject, explorerHierarchy, selectHierarchyItem,
    updateObjectUVs, clipboard, findParentItem, duplicateSelected, findModelParent,
    switchTab, makeTabPersistent,
    updateParticles
} from './editor.js';
import { renderSSRPrepass, godRaysPass } from './setup.js';

function updateSunShadowCameraToCameraView() {
    if (!sun || !sun.target || !moon || !moon.target) return;
    
    // Get the point in front of the camera where we want the shadow box to be centered
    const center = camera.position.clone().add(camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(30));
    
    // Snap the center to the nearest unit to prevent shadow shimmering/jittering as the camera moves
    center.set(Math.floor(center.x), Math.floor(center.y), Math.floor(center.z));

    // Update sun and target positions to maintain light direction while shifting the shadow volume
    sun.position.copy(center).add(state.sunLightOffset);
    sun.target.position.copy(center);
    sun.target.updateMatrixWorld();

    // Update moon and target (Moon is always opposite the sun)
    moon.position.copy(center).sub(state.sunLightOffset);
    moon.target.position.copy(center);

    // Position the Sun Disk very far away in the direction of the light
    const sunDir = state.sunLightOffset.clone().normalize();
    sunDisk.position.copy(camera.position).add(sunDir.multiplyScalar(500));
}

/**
 * Prioritizes lights based on distance to the camera to support "infinite" light counts.
 * Enforces a hard cap of 32 active lights with smooth budget-based fading.
 */
function manageLightPriority() {
    const lightCount = state.allLights.length;
    if (lightCount === 0) return;

    const cameraPos = camera.position;
    const worldPos = new THREE.Vector3();

    // 1. Throttle for expensive distance calculations and sorting (less frequent)
    state._lightDistanceUpdateCounter = (state._lightDistanceUpdateCounter || 0) + 1;
    const shouldRecalculateDistances = (state._lightDistanceUpdateCounter % 60 === 0) || state.isDraggingObject;

    if (shouldRecalculateDistances) {
        for (let i = 0; i < lightCount; i++) {
            const item = state.allLights[i];
            if (item.objectRef) {
                item._distSq = item.objectRef.getWorldPosition(worldPos).distanceToSquared(cameraPos);
                item._dist = Math.sqrt(item._distSq);
            }
        }
        state.allLights.sort((a, b) => a._distSq - b._distSq);
    }

    // 2. Throttle for applying light properties (more frequent, uses last known distances)
    state._lightPropertyUpdateCounter = (state._lightPropertyUpdateCounter || 0) + 1;
    const shouldUpdateLightProperties = (state._lightPropertyUpdateCounter % 10 === 0) || shouldRecalculateDistances;

    if (!shouldUpdateLightProperties) return;

    let dynamicLightPool = 0;
    const shadowLimit = state.maxShadowLights || 8;
    const dynamicLimit = state.maxVisibleLights || 32;
    const diffuseThreshold = state.diffuseRange || 350;
    const visualThreshold = state.lightVisibilityRange || 3000;

    for (let i = 0; i < lightCount; i++) {
        const item = state.allLights[i];
        const light = item.objectRef;
        if (!light) continue;

        const lp = item.properties || {};
        const dist = item._dist;
        const baseIntensity = (lp.intensity ?? 1) * 40;

        // --- TIER 1 & 2: DYNAMIC LIGHTING (NEAR-MID RANGE) ---
        const isCandidate = dynamicLightPool < dynamicLimit && dist < diffuseThreshold;
        
        if (isCandidate) {
            light.visible = true;
            dynamicLightPool++;

            // 1. Double-Layer Smooth Fading
            // A: Distance Fading (Fades as you walk away)
            const distFadeStart = 150;
            const distFade = 1.0 - Math.max(0, Math.min(1.0, (dist - distFadeStart) / (diffuseThreshold - distFadeStart)));
            
            // B: Budget Fading (Fades the 24th through 32nd light so the 33rd doesn't "pop" off)
            const budgetFadeStart = 24;
            const budgetFade = 1.0 - Math.max(0, Math.min(1.0, (dynamicLightPool - budgetFadeStart) / (dynamicLimit - budgetFadeStart)));

            light.intensity = baseIntensity * Math.pow(distFade * budgetFade, 2);

            // 2. Continuous Shadow Management (Fixes Jitter)
            const shouldCastShadow = dynamicLightPool <= shadowLimit && lp.castShadow !== false && dist < (state.lightShadowRange || 120);
            
            if (light.castShadow !== shouldCastShadow) {
                light.castShadow = shouldCastShadow;
                if (light.shadow) {
                    light.shadow.autoUpdate = shouldCastShadow;
                    light.shadow.needsUpdate = true;
                }
            }

        } else {
            light.visible = false;
            light.intensity = 0;
            if (light.castShadow) light.castShadow = false;
        }

        // --- TIER 3: BILLBOARD LOD (THE DISTANT GLOW) ---
        if (item.billboardRef) {
            const isWithinBillboardRange = dist < visualThreshold;
            
            if (item.billboardRef) {
                item.billboardRef.visible = isWithinBillboardRange;
                
                if (isWithinBillboardRange) {
                    const billboardScale = Math.max(0.5, dist * 0.015);
                    item.billboardRef.scale.set(billboardScale, billboardScale, 1);

                    // Seamless Cross-fade:
                    // Billboard fades IN as the dynamic light fades OUT (between 100 and 250 units)
                    const bFadeInStart = 100;
                    const bFadeInEnd = 250;
                    const fadeIn = Math.max(0, Math.min(1.0, (dist - bFadeInStart) / (bFadeInEnd - bFadeInStart)));

                    // Billboard fades OUT at the edge of the world
                    const bFadeOutStart = visualThreshold * 0.8;
                    const bFadeOutEnd = visualThreshold;
                    const fadeOut = 1.0 - Math.max(0, Math.min(1.0, (dist - bFadeOutStart) / (bFadeOutEnd - bFadeOutStart)));

                    item.billboardRef.material.opacity = fadeIn * fadeOut;
                }
            }
        }
    }
}


// --- MOUSE & SHORTCUTS ---
let rightClickStartTime = 0;
let rightClickStartPos = { x: 0, y: 0 };
let isRightClickDragging = false;

// Helper function to check if a click is on the UI (menu, sidebar, etc)
function isClickOnUI(e) {
    const rightClickMenu = document.getElementById('right-click-menu');
    const explorerMenu = document.getElementById('explorer-menu');
    const rightSidebar = document.getElementById('right-sidebar');
    const topBar = document.getElementById('top-bar');
    const gameUI = document.getElementById('game-ui-container');
    
    return (rightClickMenu && rightClickMenu.contains(e.target)) ||
           (explorerMenu && explorerMenu.contains(e.target)) ||
           (rightSidebar && rightSidebar.contains(e.target)) ||
           (topBar && topBar.contains(e.target)) ||
           (gameUI && gameUI.contains(e.target));
}

window.addEventListener('mousedown', (e) => {
    // Ensure audio context is active on first user interaction
    if (audioListener.context.state === 'suspended') audioListener.context.resume();

    // Ignore left-clicks on UI elements
    if (e.button === 0 && isClickOnUI(e)) {
        return;
    }
    
    if (e.button === 0) {
        if (state.currentMode === 'scale' && scaleHandles.visible) {
            // Use uiCamera if selecting UI handles
            const rayCamera = state.selectedObjects.some(o => o.userData.isUI) ? uiCamera : camera;
            raycaster.setFromCamera(mouse, rayCamera);
            const handleHits = raycaster.intersectObjects(scaleHandles.children);
            if (handleHits.length > 0) {
                state.activeHandle = handleHits[0].object;
                state.initialDragPoint.copy(handleHits[0].point);
                state.initialScale.copy(selectionGroup.scale);
                state.initialPosition.copy(selectionGroup.position);
                renderer.domElement.style.cursor = 'grabbing';
                return;
            }
        }

        if (transformControls.dragging || (transformControls.axis !== null)) return;

        // First check UI selection
        raycaster.setFromCamera(mouse, uiCamera);
        const uiIntersects = raycaster.intersectObjects(state.uiObjects);
        if (uiIntersects.length > 0) {
            const hit = uiIntersects[0].object;
            const itemId = findItemIdForObject(hit);
            const item = explorerHierarchy.findItemById(itemId);
            if (item) selectHierarchyItem(item, e.shiftKey);
            return;
        }

        // Fallback to World selection
        raycaster.setFromCamera(mouse, camera);
        const intersects = raycaster.intersectObjects(state.selectableObjects, true);
        if (intersects.length > 0) {
            let hit = intersects[0].object;
            // Support selecting the parent object when clicking a surface texture/UI
            if (hit.userData.isSurfaceOverlay && hit.parent) hit = hit.parent;
            const itemId = findItemIdForObject(hit);
            const item = explorerHierarchy.findItemById(itemId);
            const modelParent = findModelParent(itemId);
            const finalItem = modelParent || item;

            const now = Date.now();
            const isSelected = state.currentSelectedItem === finalItem;

            // Sound tab logic
            if (finalItem && finalItem.type === 'sound' && isSelected && !e.shiftKey) {
                if (now - state.lastClickTime < 2000) {
                    const assetId = finalItem.properties?.soundId;
                    if (assetId) { makeTabPersistent(assetId); switchTab(assetId); state.lastClickTime = 0; return; }
                }
            }

            // If an image or texture object is already selected, clicking it again within 2 seconds opens the tab
            const isAssetType = (i) => i.type === 'image' || i.type === 'texture' || (i.type === 'effect' && i.subType === 'particle');
            if (finalItem && isAssetType(finalItem) && isSelected && !e.shiftKey) {
                if (now - state.lastClickTime < 2000) {
                    const assetId = finalItem.properties?.imageId;
                    if (assetId) {
                        makeTabPersistent(assetId);
                        switchTab(assetId);
                        state.lastClickTime = 0;
                        return;
                    }
                }
            }
            state.lastClickTime = now;

            selectHierarchyItem(finalItem, e.shiftKey);
            
            if (state.currentMode === 'select' && hit !== baseplate) state.isDraggingObject = true;
        } else if (e.target.tagName === 'CANVAS') {
            clearSelection(); showInspector(); updateExplorer();
        }
    }
    if (e.button === 2) {
        // Just track the start of the right-click to distinguish between a click and a camera drag
        e.preventDefault();
        rightClickStartTime = Date.now();
        rightClickStartPos = { x: e.clientX, y: e.clientY };
        isRightClickDragging = false;
    }
});

window.addEventListener('dblclick', (e) => {
    if (isClickOnUI(e)) return;

    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObjects(state.selectableObjects, true);
    if (intersects.length > 0) {
        let hit = intersects[0].object;
        if (hit.userData.isSurfaceOverlay && hit.parent) hit = hit.parent;

        const itemId = findItemIdForObject(hit);
        const item = explorerHierarchy.findItemById(itemId);
        const isAssetType = (i) => i.type === 'image' || i.type === 'texture' || (i.type === 'effect' && i.subType === 'particle');
        if (item && isAssetType(item) && item.properties?.imageId) {
            selectHierarchyItem(item, false);
            const assetId = item.properties.imageId;
            makeTabPersistent(assetId);
            switchTab(assetId);
        } else if (item && item.type === 'sound' && item.properties?.soundId) {
            selectHierarchyItem(item, false);
            const assetId = item.properties.soundId;
            makeTabPersistent(assetId);
            switchTab(assetId);
        }
    }
});

window.addEventListener('mouseup', (e) => {
    // Don't process canvas logic if clicking on UI
    if (isClickOnUI(e)) {
        return;
    }
    
    const wasScaling = !!state.activeHandle;
    state.isDraggingObject = false;
    state.activeHandle = null;
    renderer.domElement.style.cursor = 'default';
    
    if (e.button === 2) {
        const duration = Date.now() - rightClickStartTime;

        // Detect a "Click" (not a camera drag)
        if (!isRightClickDragging && duration < 300) {
            raycaster.setFromCamera(mouse, camera);
            const intersects = raycaster.intersectObjects(state.selectableObjects, true);
            let hitObject = intersects.length > 0 ? intersects[0].object : null;
            if (hitObject && hitObject.userData.isSurfaceOverlay && hitObject.parent) hitObject = hitObject.parent;
            if (hitObject === baseplate) hitObject = null;

            // Logical selection update for right-click:
            if (hitObject) {
                // If we right-clicked an object NOT in the current selection, we select ONLY that object.
                // If it IS already in the selection (even part of a multi-selection), we do nothing
                // to preserve the existing selection while opening the context menu.
                if (!state.selectedObjects.includes(hitObject)) {
                    const itemId = findItemIdForObject(hitObject);
                    const item = explorerHierarchy.findItemById(itemId);
                    const modelParent = findModelParent(itemId);
                    selectHierarchyItem(modelParent || item, false);
                }
            } 
            // If we right-clicked the background and have no selection, do nothing.
            // If we have a selection, the menu will show actions for that selection.

            const contextId = hitObject ? findItemIdForObject(hitObject) : null;
            
            showRightClickMenu(e.pageX, e.pageY, contextId);
        }
        if (document.pointerLockElement) document.exitPointerLock();
    }

    if (wasScaling) refreshSceneState();
});

window.addEventListener('mousemove', (e) => {
    mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;

    if (e.buttons === 2) {
        const dist = Math.hypot(e.clientX - rightClickStartPos.x, e.clientY - rightClickStartPos.y);
        
        // If the mouse moved more than 5px, assume camera rotation and lock pointer
        if (dist > 5 && !isRightClickDragging) {
            isRightClickDragging = true;
            renderer.domElement.requestPointerLock();
        }

        if (document.pointerLockElement === renderer.domElement) {
            const sensitivity = 0.002;
            state.yaw -= e.movementX * sensitivity;
            if (state.isPlayTesting) state.pitch += e.movementY * sensitivity; 
            else state.pitch -= e.movementY * sensitivity; 
            state.pitch = Math.max(-Math.PI / 2.2, Math.min(Math.PI / 2.2, state.pitch));
        }
    }

    if (state.activeHandle) {
        const planeNormal = new THREE.Vector3();
        camera.getWorldDirection(planeNormal);
        const dragPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(planeNormal, state.initialDragPoint);
        const ray = new THREE.Raycaster(); // Use a new raycaster for this specific interaction
        const rayCamera = state.selectedObjects.some(obj => obj.userData.isUI) ? uiCamera : camera;
        ray.setFromCamera(mouse, camera);
        const intersectPoint = new THREE.Vector3();
        
        if (ray.ray.intersectPlane(dragPlane, intersectPoint)) {
            const dragDelta = new THREE.Vector3().subVectors(intersectPoint, state.initialDragPoint);
            const direction = state.activeHandle.userData.direction.clone().applyQuaternion(selectionGroup.quaternion);
            const distance = dragDelta.dot(direction);
            const axis = state.activeHandle.userData.direction.x !== 0 ? 'x' : (state.activeHandle.userData.direction.y !== 0 ? 'y' : 'z');
            const sizeOnAxis = state.initialSize[axis];
            
            let targetTotalSize = (state.initialScale[axis] * sizeOnAxis) + distance;
            targetTotalSize = Math.max(0.1, snapValue(targetTotalSize)); 
            
            const newScaleFactor = targetTotalSize / sizeOnAxis;
            const actualChangeInSize = (newScaleFactor - state.initialScale[axis]) * sizeOnAxis;

            selectionGroup.scale[axis] = newScaleFactor;
            const moveVec = direction.clone().multiplyScalar(actualChangeInSize / 2);
            selectionGroup.position.copy(state.initialPosition).add(moveVec);
            
            // Trigger shadow updates for lights inside the selection while moving
            state.selectedObjects.forEach(obj => { if (obj.shadow) obj.shadow.needsUpdate = true; });

            updateScaleHandles(); 
            updatePropertyValues();
            // Recalculate UVs in real-time to prevent texture stretching during scaling
            state.selectedObjects.forEach(obj => { if (obj.isMesh) updateObjectUVs(obj); });
        }
        return;
    }

    if (state.isDraggingObject && state.selectedObjects.length > 0 && state.currentMode === 'select') {
        raycaster.setFromCamera(mouse, camera);
        const targets = state.selectableObjects.filter(o => !state.selectedObjects.includes(o));
        const intersects = raycaster.intersectObjects(targets, true);
        if (intersects.length > 0) {
            const hit = intersects[0];
            let newPos = getSurfacePosition(hit, selectionGroup);
            newPos.x = snapValue(newPos.x); newPos.y = snapValue(newPos.y); newPos.z = snapValue(newPos.z);
            selectionGroup.position.copy(newPos);
            if (state.selectedObjects.length === 1) updatePropertyValues();

            // Trigger shadow updates for lights/meshes during drag
            state.selectedObjects.forEach(obj => { if (obj.shadow) obj.shadow.needsUpdate = true; });
        }
    }
});

function focusSelection() {
    if (state.selectedObjects.length === 0) return;
    const box = new THREE.Box3().setFromObject(selectionGroup);
    const center = new THREE.Vector3(); box.getCenter(center);
    const size = new THREE.Vector3(); box.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z);
    const fov = camera.fov * (Math.PI / 180);
    let cameraZ = Math.abs(maxDim / 2 / Math.tan(fov / 2)) * 2.5;

    const direction = new THREE.Vector3().subVectors(camera.position, center).normalize();
    camera.position.copy(center.clone().add(direction.multiplyScalar(cameraZ)));
    camera.lookAt(center);
    
    const dir = new THREE.Vector3().subVectors(center, camera.position).normalize();
    state.yaw = Math.atan2(-dir.x, -dir.z);
    state.pitch = Math.asin(dir.y);
}

// --- KEYBOARD HANDLING ---
window.addEventListener('keydown', e => {
    const isCtrl = e.ctrlKey || e.metaKey;
    

    if (!e.ctrlKey && !e.metaKey) keys[e.code] = true;
    // Allow Ctrl/Cmd shortcuts even when an input is focused to improve UX
    if (document.activeElement.tagName === 'INPUT' && e.code !== 'Escape' && !e.ctrlKey && !e.metaKey) return;

    if (e.code === 'Digit1') setMode('select');
    if (e.code === 'Digit2') setMode('move');
    if (e.code === 'Digit3') setMode('rotate');
    if (e.code === 'Digit4') setMode('scale');
    if (e.code === 'KeyF') focusSelection();
    if (e.code === 'KeyP') togglePlayTest();
    
    if (e.code === 'Delete' || e.code === 'Backspace') {
        const delBtn = document.getElementById('prop-delete');
        if (delBtn) delBtn.click();
    }

    if (e.ctrlKey || e.metaKey) {
        switch(e.code) {
            case 'KeyC': 
                e.preventDefault();
                copySelection(); 
                break;
            case 'KeyX':
                e.preventDefault();
                copySelection();
                const delBtn = document.getElementById('prop-delete');
                if (delBtn) delBtn.click();
                break;
            case 'KeyV': 
                e.preventDefault();
                pasteSelection(); 
                break;
            case 'KeyD':
                e.preventDefault(); 
                duplicateSelected();
                keys['KeyD'] = false; 
                break;
        }
    }
});

window.addEventListener('keyup', e => {
    keys[e.code] = false;
    if (e.code === 'ControlLeft' || e.code === 'ControlRight') keys['KeyD'] = false;
});

window.addEventListener('wheel', (e) => {
    // Don't move camera if scrolling over GUI elements
    if (isClickOnUI(e)) {
        return;
    }
    
    if (state.isPlayTesting) {
        state.cameraZoom += e.deltaY * 0.02;
        state.cameraZoom = Math.max(0, Math.min(state.cameraZoom, 30)); 
    } else {
        const vector = new THREE.Vector3(mouse.x, mouse.y, 0.5).unproject(camera);
        const dir = vector.sub(camera.position).normalize();
        camera.position.addScaledVector(dir, e.deltaY > 0 ? -3 : 3);
    }
}, { passive: true });

// --- PLAYTESTING SETUP ---
const jumpStrength = 0.3;
const moveSpeed = 0.1;
let physicsWorld;
const physicsBodies = new Map();

function initPhysics() {
    physicsWorld = new CANNON.World();
    physicsWorld.broadphase = new CANNON.SAPBroadphase(physicsWorld);
    physicsWorld.solver.iterations = 10;

    const groundMaterial = new CANNON.Material("ground");
    const playerMaterial = new CANNON.Material("player");
    
    physicsWorld.addContactMaterial(new CANNON.ContactMaterial(playerMaterial, groundMaterial, {
        friction: 0.0,
        restitution: 0.0
    }));

    // Taller Box shape: Width 1.2, Height 3.6, Depth 0.6
    // Cannon uses half-extents: [0.6, 1.8, 0.3]
    const playerShape = new CANNON.Box(new CANNON.Vec3(0.6, 1.8, 0.3)); 
    
    state.playerPhysicsBody = new CANNON.Body({
        mass: 1,
        shape: playerShape,
        fixedRotation: true, 
        material: playerMaterial,
        linearDamping: 0.1 // Lower damping allows for natural gravitational acceleration
    });
    
    const localUp = new THREE.Vector3().copy(state.gravityDirection).multiplyScalar(-1).normalize();
    state.playerPhysicsBody.position.copy(state.playerGroup.position);
    // Orient the physics box to match gravity direction
    state.playerPhysicsBody.quaternion.setFromVectors(new CANNON.Vec3(0, 1, 0), new CANNON.Vec3(localUp.x, localUp.y, localUp.z));
    physicsWorld.addBody(state.playerPhysicsBody);

    // Setup other objects (Keep your existing object loop here...)
    const allObjects = [...state.selectableObjects, baseplate];
    allObjects.forEach(obj => {
        if (!obj || !obj.geometry) return;
        
        // Skip creating physics body if canCollide is false
        if (obj.userData.canCollide === false) return;
        
        const isAnchored = obj === baseplate || obj.userData.anchored;
        obj.updateMatrixWorld(true);
        const worldPos = new THREE.Vector3();
        const worldQuat = new THREE.Quaternion();
        const worldScale = new THREE.Vector3();
        obj.matrixWorld.decompose(worldPos, worldQuat, worldScale);

let shape;
        const type = obj.geometry.type;

        if (type === 'BoxGeometry') {
            const p = obj.geometry.parameters;
            shape = new CANNON.Box(new CANNON.Vec3(
                (p.width * worldScale.x) / 2, 
                (p.height * worldScale.y) / 2, 
                (p.depth * worldScale.z) / 2
            ));
        } else if (type === 'SphereGeometry') {
            shape = new CANNON.Sphere(obj.geometry.parameters.radius * worldScale.x);
        } else if (obj.geometry.isBufferGeometry) {
            // --- CUSTOM MESH COLLISIONS (The Banana Fix!) ---
            const positions = obj.geometry.attributes.position.array;
            const vertices = [];
            
            // Cannon doesn't auto-scale shapes, so we multiply the vertices by your worldScale
            for (let i = 0; i < positions.length; i += 3) {
                vertices.push(
                    positions[i] * worldScale.x,
                    positions[i + 1] * worldScale.y,
                    positions[i + 2] * worldScale.z
                );
            }

            const indices = [];
            if (obj.geometry.index) {
                const indexArray = obj.geometry.index.array;
                for (let i = 0; i < indexArray.length; i++) indices.push(indexArray[i]);
            } else {
                // If the model doesn't have an index array, generate a basic one
                for (let i = 0; i < positions.length / 3; i++) indices.push(i);
            }
            
            shape = new CANNON.Trimesh(vertices, indices);
        } else {
            // Absolute fallback: create a box with minimum safe dimensions
            const minSize = 0.1;
            shape = new CANNON.Box(new CANNON.Vec3(
                Math.max(minSize, worldScale.x/2),
                Math.max(minSize, worldScale.y/2),
                Math.max(minSize, worldScale.z/2)
            ));
        }

        // Calculate mass based on volume (scale) and density.
        // If density is 0, mass is 0, making the object static (weightless).
        // We use a multiplier of 0.02 so that a density of 10 = 0.2 mass multiplier.
        const density = (obj.userData.density !== undefined) ? obj.userData.density : 10;
        const mass = isAnchored ? 0 : (worldScale.x * worldScale.y * worldScale.z) * (density * 0.02);

        const body = new CANNON.Body({
            mass: mass,
            position: new CANNON.Vec3(worldPos.x, worldPos.y, worldPos.z),
            quaternion: new CANNON.Quaternion(worldQuat.x, worldQuat.y, worldQuat.z, worldQuat.w),
            shape: shape,
            material: groundMaterial // Everything else is "ground"
        });

        if (mass > 0) {
            body.linearDamping = 0.05; // Reduces jittering/skittishness for light objects
            body.angularDamping = 0.05;
        }

        physicsWorld.addBody(body);
        physicsBodies.set(obj, body);
    });
}

function createAvatar() {
    state.playerGroup = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0xe0e0e0 }); 
    const addShadows = (mesh) => { mesh.castShadow = true; mesh.receiveShadow = true; return mesh; };

    // Total height is ~3.6 units. We center everything so (0,0,0) is the middle of the torso.
    const head = addShadows(new THREE.Mesh(new THREE.SphereGeometry(0.6, 16, 16), mat)); 
    head.position.y = 1.2; // Top of head at 1.8
    state.playerGroup.add(head);

    const torso = addShadows(new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 0.6), mat)); 
    torso.position.y = 0; 
    state.playerGroup.add(torso);
    
    const limbGeo = new THREE.BoxGeometry(0.4, 1.2, 0.4);
    const leftArm = addShadows(new THREE.Mesh(limbGeo, mat)); 
    leftArm.position.set(-0.8, 0, 0); 
    state.playerGroup.add(leftArm);

    const rightArm = addShadows(new THREE.Mesh(limbGeo, mat)); 
    rightArm.position.set(0.8, 0, 0); 
    state.playerGroup.add(rightArm);

    const leftLeg = addShadows(new THREE.Mesh(limbGeo, mat)); 
    leftLeg.position.set(-0.3, -1.2, 0); // Bottom of feet at -1.8
    state.playerGroup.add(leftLeg);

    const rightLeg = addShadows(new THREE.Mesh(limbGeo, mat)); 
    rightLeg.position.set(0.3, -1.2, 0); 
    state.playerGroup.add(rightLeg);

    state.playerGroup.position.set(0, 5, 0); // Spawn slightly higher
    scene.add(state.playerGroup);
}

const playTestBtn = document.getElementById('btn-playtest');
function togglePlayTest() {
    state.isPlayTesting = !state.isPlayTesting;
    const btn = document.getElementById('btn-playtest');
    
    if (state.isPlayTesting) {
        btn.innerText = "Stop";
        btn.style.background = "#ff4444";
        
        state.selectableObjects.forEach(obj => {
            if (obj === baseplate) return;
            obj.userData.originalTransform = {
                position: obj.position.clone(),
                rotation: obj.rotation.clone(),
                scale: obj.scale.clone()
            };
        });

        clearSelection();
        state.editorCameraTransform.position.copy(camera.position);
        state.editorCameraTransform.rotation.copy(camera.rotation);
        createAvatar();

        // --- PLAYER SPAWN LOGIC ---
        const spawns = state.selectableObjects.filter(obj => {
            if (!obj.userData.isPlayerSpawn) return false;
            const itemId = findItemIdForObject(obj);
            const item = explorerHierarchy.findItemById(itemId);
            return item && item.properties && item.properties.enabled !== false;
        });
        let spawnPos = new THREE.Vector3(0, 10, 0); // Default fallback

        if (spawns.length > 0) {
            // Pick a random spawn location if multiple exist
            const spawn = spawns[Math.floor(Math.random() * spawns.length)];
            spawn.updateMatrixWorld();
            
            // Calculate a random point on the top surface
            // We use 0.5 as local Y because the box geometry is 1 unit tall centered at 0
            const localRandomPoint = new THREE.Vector3(
                (Math.random() - 0.5), 
                0.5, 
                (Math.random() - 0.5)
            );
            
            // Transform local point to world space and add player half-height (1.8)
            spawnPos.copy(localRandomPoint.applyMatrix4(spawn.matrixWorld));
            spawnPos.y += 1.8; 
        }
        state.playerGroup.position.copy(spawnPos);

        initPhysics();
    } else {
        btn.innerText = "Play Test";
        btn.style.background = "#2d5a3f";
        
        // CRITICAL FIX: Clear selection FIRST to detach objects from selectionGroup
        clearSelection();
        
        // Reset all objects to their original positions
        state.selectableObjects.forEach(obj => {
            if (obj && obj.userData.originalTransform) {
                obj.position.copy(obj.userData.originalTransform.position);
                obj.rotation.copy(obj.userData.originalTransform.rotation);
                obj.scale.copy(obj.userData.originalTransform.scale);
                obj.updateMatrixWorld();
            }
        });

        // Clean up physics properly
        physicsBodies.clear();
        if (physicsWorld) {
            physicsWorld.bodies.forEach(body => physicsWorld.removeBody(body));
            physicsWorld = null;
        }
        if (state.playerGroup && scene) scene.remove(state.playerGroup);
        state.playerGroup = null;
        
        // Restore editor camera and Up vector
        camera.up.set(0, 1, 0);
        camera.position.copy(state.editorCameraTransform.position);
        camera.rotation.set(state.editorCameraTransform.rotation.x, state.editorCameraTransform.rotation.y, state.editorCameraTransform.rotation.z);
    }
}

if (playTestBtn) playTestBtn.onclick = togglePlayTest;

const clock = new THREE.Clock();
function animate() {
    requestAnimationFrame(animate);
    const isTyping = document.activeElement.tagName === 'INPUT';
    const dt = Math.min(0.05, clock.getDelta()); // Cap delta to prevent huge jumps

    // Update active particle systems every frame regardless of state
    updateParticles(dt);

    if (state.isPlayTesting && state.playerGroup && state.playerPhysicsBody) {
        
        // --- 1. SYNC ANCHORED OBJECTS (Real-time Pushing) ---
        physicsBodies.forEach((body, mesh) => {
            if (body.mass === 0) { // Anchored/Static objects
                mesh.updateMatrixWorld();
                const worldPos = new THREE.Vector3();
                const worldQuat = new THREE.Quaternion();
                mesh.getWorldPosition(worldPos);
                mesh.getWorldQuaternion(worldQuat);
                body.position.copy(worldPos);
                body.quaternion.copy(worldQuat);
            }
        });

        // --- 2. PLAYER MOVEMENT (Omni-directional) ---
        const localUp = new THREE.Vector3().copy(state.gravityDirection).multiplyScalar(-1).normalize();
        const cannonUp = new CANNON.Vec3(localUp.x, localUp.y, localUp.z);

        // Calculate movement basis relative to camera and gravity
        const camForward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
        let forward = camForward.clone().projectOnPlane(localUp).normalize();
        // Fallback if looking straight at gravity
        if (forward.lengthSq() < 0.01) {
            const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
            forward = camUp.projectOnPlane(localUp).normalize();
        }
        const right = new THREE.Vector3().crossVectors(forward, localUp).normalize();

        const moveVec = new THREE.Vector3(0, 0, 0);
        if (!isTyping) {
            if (keys['KeyW']) moveVec.add(forward);
            if (keys['KeyS']) moveVec.sub(forward);
            if (keys['KeyA']) moveVec.sub(right); // Fixed: Left/Right were flipped
            if (keys['KeyD']) moveVec.add(right);
        }

        const currentVel = state.playerPhysicsBody.velocity;
        const verticalVelocity = currentVel.dot(cannonUp);

        if (moveVec.length() > 0) {
            moveVec.normalize().multiplyScalar(moveSpeed * 65);
            // Apply movement while preserving gravity-induced vertical velocity
            state.playerPhysicsBody.velocity.set(
                moveVec.x + localUp.x * verticalVelocity,
                moveVec.y + localUp.y * verticalVelocity,
                moveVec.z + localUp.z * verticalVelocity
            );

            // --- PLAYER VISUAL ROTATION ---
            const lookTarget = state.playerGroup.position.clone().add(moveVec);
            const targetQuat = new THREE.Quaternion();
            const m = new THREE.Matrix4().lookAt(state.playerGroup.position, lookTarget, localUp);
            targetQuat.setFromRotationMatrix(m);
            state.playerGroup.quaternion.slerp(targetQuat, 0.2);
        } else {
            // Maintain only vertical velocity when not moving
            state.playerPhysicsBody.velocity.set(
                localUp.x * verticalVelocity,
                localUp.y * verticalVelocity,
                localUp.z * verticalVelocity
            );
            
            // Align "Up" with anti-gravity while preserving current facing direction
            const currentQuat = state.playerGroup.quaternion.clone();
            const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(currentQuat).projectOnPlane(localUp).normalize();
            if (fwd.lengthSq() > 0.01) {
                const targetQuat = new THREE.Quaternion();
                const m = new THREE.Matrix4().lookAt(new THREE.Vector3(0,0,0), fwd, localUp);
                targetQuat.setFromRotationMatrix(m);
                state.playerGroup.quaternion.slerp(targetQuat, 0.1);
            }
        }

        // --- 3. GROUND CHECK (Updated for Tall Box) ---
        // Raycast in the direction of gravity to detect ground
        const from = state.playerPhysicsBody.position;
        const to = new CANNON.Vec3(
            from.x + state.gravityDirection.x * 1.9,
            from.y + state.gravityDirection.y * 1.9,
            from.z + state.gravityDirection.z * 1.9
        );
        const raycastResult = new CANNON.RaycastResult();
        physicsWorld.raycastClosest(from, to, { skipBackfaces: true }, raycastResult);
        state.isGrounded = raycastResult.hasHit;

        if (keys['Space'] && state.isGrounded && !isTyping) {
            const jumpImpulse = jumpStrength * 75;
            
            // Clear existing vertical velocity before jumping to ensure consistent height
            const vDot = state.playerPhysicsBody.velocity.dot(cannonUp);
            state.playerPhysicsBody.velocity.x -= cannonUp.x * vDot;
            state.playerPhysicsBody.velocity.y -= cannonUp.y * vDot;
            state.playerPhysicsBody.velocity.z -= cannonUp.z * vDot;

            // Apply the jump impulse opposite to gravity
            state.playerPhysicsBody.velocity.x += localUp.x * jumpImpulse;
            state.playerPhysicsBody.velocity.y += localUp.y * jumpImpulse;
            state.playerPhysicsBody.velocity.z += localUp.z * jumpImpulse;

            state.isGrounded = false;
        }

        // --- 4. STEP & SYNC ---
        if (physicsWorld && state.playerPhysicsBody) {
            physicsWorld.gravity.set(
                state.gravityDirection.x * state.gravityStrength,
                state.gravityDirection.y * state.gravityStrength,
                state.gravityDirection.z * state.gravityStrength
            );
            physicsWorld.fixedStep();
            state.playerGroup.position.copy(state.playerPhysicsBody.position);

            physicsBodies.forEach((body, mesh) => {
                if (body.mass > 0 && mesh && body) {
                    mesh.position.copy(body.position);
                    mesh.quaternion.copy(body.quaternion);
                }
            });
        }

        // --- 5. CAMERA (Gravity-Aligned) ---
        // Find the player's head position based on current gravity orientation
        const headPos = new THREE.Vector3(0, 1.2, 0)
            .applyQuaternion(state.playerGroup.quaternion)
            .add(state.playerGroup.position);

        // Calculate a rotation that aligns World-Up to our Local-Up
        const gravityAlignQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), localUp);

        if (state.isFirstPerson) {
            camera.position.copy(headPos);
            
            // Combine Gravity Alignment with user Yaw and Pitch
            const yawQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), state.yaw);
            const pitchQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), state.pitch);
            
            camera.quaternion.copy(gravityAlignQuat).multiply(yawQuat).multiply(pitchQuat);
        } else {
            // Keep camera Up vector consistent with gravity for lookAt stability
            camera.up.copy(localUp);

            // Calculate orbital position based on yaw/pitch in local gravity frame
            const localOffset = new THREE.Vector3(
                state.cameraZoom * Math.sin(state.yaw) * Math.cos(state.pitch),
                state.cameraZoom * Math.sin(state.pitch),
                state.cameraZoom * Math.cos(state.yaw) * Math.cos(state.pitch)
            );
            
            // Rotate the offset into world space relative to gravity and apply
            const worldOffset = localOffset.applyQuaternion(gravityAlignQuat);
            camera.position.copy(headPos.clone().add(worldOffset));
            camera.lookAt(headPos);
        }

    } else if (!isTyping) {
        // Editor Camera
        const eMove = new THREE.Vector3();
        if (keys['KeyW']) eMove.z -= 1; if (keys['KeyS']) eMove.z += 1;
        if (keys['KeyA']) eMove.x -= 1; if (keys['KeyD']) eMove.x += 1;
        camera.position.add(eMove.applyQuaternion(camera.quaternion).multiplyScalar(0.5));
        camera.rotation.set(state.pitch, state.yaw, 0, 'YXZ');
    }

    // Constantly update scale gizmo to account for camera movement and zooming
    if (state.currentMode === 'scale' && !state.isPlayTesting) {
        updateScaleHandles();
    }

    // Keep shadows centered around the user's camera view
    updateSunShadowCameraToCameraView();

    // Manage light budget for performance and stability
    manageLightPriority();

    // --- SUN RAYS UPDATE ---
    if (godRaysPass && godRaysPass.enabled) {
        // Project the physical sun disk, not the light source position
        const sunProj = sunDisk.position.clone().project(camera);
        
        // z < 1 means the sun is in front of the camera's far plane
        // We also check if it's within a reasonable range to avoid "inverted" rays when looking away
        if (sunProj.z < 1 && sunProj.z > -1) {
            godRaysPass.uniforms.sunPosition.value.set((sunProj.x + 1) / 2, (sunProj.y + 1) / 2);
        }
    }

    // --- SSR RAYTRACING UPDATE ---
    // Renders normals, depth, and masks to trace rays in screen space
    renderSSRPrepass();

    composer.render();

    // Render UI on top
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(uiScene, uiCamera);
    renderer.autoClear = true;
}

window.addEventListener('contextmenu', e => e.preventDefault());
updateExplorer();
refreshSceneState();
updateToolUI('mode-select');
animate();