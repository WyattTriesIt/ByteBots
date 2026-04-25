import * as CANNON from 'cannon-es';
import * as THREE from 'three';
import { scene, camera, renderer, raycaster, mouse, keys, baseplate, state } from './setup.js';
import { 
    selectionGroup, scaleHandles, transformControls, attachTool, clearSelection, showRightClickMenu,
    showInspector, updateScaleHandles, updatePropertyValues, getSurfacePosition, snapValue, 
    setMode, updateExplorer, updateToolUI, placeOnTargetSurface,
    copySelection, pasteSelection, findItemIdForObject, explorerHierarchy
} from './editor.js';

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
    
    return (rightClickMenu && rightClickMenu.contains(e.target)) ||
           (explorerMenu && explorerMenu.contains(e.target)) ||
           (rightSidebar && rightSidebar.contains(e.target)) ||
           (topBar && topBar.contains(e.target));
}

window.addEventListener('mousedown', (e) => {
    // Ignore left-clicks on UI elements
    if (e.button === 0 && isClickOnUI(e)) {
        return;
    }
    
    if (e.button === 0) {
        if (state.currentMode === 'scale' && scaleHandles.visible) {
            raycaster.setFromCamera(mouse, camera);
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

        raycaster.setFromCamera(mouse, camera);
        const intersects = raycaster.intersectObjects(state.selectableObjects);
        if (intersects.length > 0) {
            const hit = intersects[0].object;
            if (state.currentMode === 'select' && hit !== baseplate) {
                if (!state.selectedObjects.includes(hit)) attachTool(hit, e.shiftKey);
                state.isDraggingObject = true;
            } else { attachTool(hit, e.shiftKey); }
        } else if (e.target.tagName === 'CANVAS') {
            clearSelection(); showInspector();
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

window.addEventListener('mouseup', (e) => {
    // Don't process canvas logic if clicking on UI
    if (isClickOnUI(e)) {
        return;
    }
    
    state.isDraggingObject = false;
    state.activeHandle = null;
    renderer.domElement.style.cursor = 'default';
    
    if (e.button === 2) {
        const duration = Date.now() - rightClickStartTime;

        // Detect a "Click" (not a camera drag)
        if (!isRightClickDragging && duration < 300) {
            raycaster.setFromCamera(mouse, camera);
            const intersects = raycaster.intersectObjects(state.selectableObjects);
            let hitObject = intersects.length > 0 ? intersects[0].object : null;
            if (hitObject === baseplate) hitObject = null;

            // Logical selection update for right-click:
            if (hitObject) {
                // If we right-clicked an object NOT in the current selection, 
                // we select ONLY that object (standard editor behavior)
                if (!state.selectedObjects.includes(hitObject)) {
                    clearSelection();
                    attachTool(hitObject, false);
                }
            } 
            // If we right-clicked the background and have no selection, do nothing.
            // If we have a selection, the menu will show actions for that selection.

            const contextId = hitObject ? findItemIdForObject(hitObject) : null;
            
            showRightClickMenu(e.pageX, e.pageY, contextId);
        }
        if (document.pointerLockElement) document.exitPointerLock();
    }
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
        const ray = new THREE.Raycaster();
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

            updateScaleHandles(); updatePropertyValues();
        }
        return;
    }

    if (state.isDraggingObject && state.selectedObjects.length > 0 && state.currentMode === 'select') {
        raycaster.setFromCamera(mouse, camera);
        const targets = state.selectableObjects.filter(o => !state.selectedObjects.includes(o));
        const intersects = raycaster.intersectObjects(targets);
        if (intersects.length > 0) {
            const hit = intersects[0];
            let newPos = getSurfacePosition(hit, selectionGroup);
            newPos.x = snapValue(newPos.x); newPos.y = snapValue(newPos.y); newPos.z = snapValue(newPos.z);
            selectionGroup.position.copy(newPos);
            if (state.selectedObjects.length === 1) updatePropertyValues();
        }
    }
});

// --- DUPLICATION ---
export function duplicateSelection() {
    if (state.selectedObjects.length === 0) return;
    const newSelections = [];
    state.selectedObjects.forEach(original => {
        if (original === baseplate) return;
        const worldPos = new THREE.Vector3();
        const worldQuat = new THREE.Quaternion();
        const worldScale = new THREE.Vector3();
        original.getWorldPosition(worldPos);
        original.getWorldQuaternion(worldQuat);
        original.getWorldScale(worldScale);

        const clonedMesh = original.clone();
        clonedMesh.material = original.material.clone();
        clonedMesh.name = original.name + " (Duplicate)";
        
        scene.add(clonedMesh);
        clonedMesh.position.copy(worldPos);
        clonedMesh.quaternion.copy(worldQuat);
        clonedMesh.scale.copy(worldScale);

        state.selectableObjects.push(clonedMesh);
        newSelections.push(clonedMesh);
        
        // Add to hierarchy so the editor knows this object exists
        const worldFolder = explorerHierarchy.getOrCreateWorld();
        const hierarchyItem = { id: `obj-${Date.now()}-${Math.floor(Math.random() * 1000)}`, type: 'object', name: clonedMesh.name, objectRef: clonedMesh };
        worldFolder.children.push(hierarchyItem);
    });

    if (newSelections.length > 0) {
        clearSelection();
        newSelections.forEach((obj, index) => attachTool(obj, index > 0));
        updateExplorer();
    }
}

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
    if (!e.ctrlKey && !e.metaKey) keys[e.code] = true;
    if (document.activeElement.tagName === 'INPUT') return;

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
            case 'KeyC': copySelection(); break;
            case 'KeyX':
                e.preventDefault();
                copySelection();
                const delBtn = document.getElementById('prop-delete');
                if (delBtn) delBtn.click();
                break;
            case 'KeyV': pasteSelection(); break;
            case 'KeyD':
                e.preventDefault(); 
                duplicateSelection();
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
const gravity = -0.015;
const jumpStrength = 0.3;
const moveSpeed = 0.1;
let physicsWorld;
const physicsBodies = new Map();

function initPhysics() {
    physicsWorld = new CANNON.World({ gravity: new CANNON.Vec3(0, -60, 0) });
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
        material: playerMaterial
    });
    
    state.playerPhysicsBody.position.copy(state.playerGroup.position);
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
            // Absolute fallback just in case
            shape = new CANNON.Box(new CANNON.Vec3(worldScale.x/2, worldScale.y/2, worldScale.z/2));
        }

        const body = new CANNON.Body({
            mass: isAnchored ? 0 : Math.max(1, (worldScale.x * worldScale.y * worldScale.z) * 10),
            position: new CANNON.Vec3(worldPos.x, worldPos.y, worldPos.z),
            quaternion: new CANNON.Quaternion(worldQuat.x, worldQuat.y, worldQuat.z, worldQuat.w),
            shape: shape,
            material: groundMaterial // Everything else is "ground"
        });

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
            obj.userData.velocity = new THREE.Vector3(0, 0, 0);
        });

        clearSelection();
        state.editorCameraTransform.position.copy(camera.position);
        state.editorCameraTransform.rotation.copy(camera.rotation);
        createAvatar();
        initPhysics();
    } else {
        btn.innerText = "Play Test";
        btn.style.background = "#2d5a3f";
        
        state.selectableObjects.forEach(obj => {
            if (obj.userData.originalTransform) {
                obj.position.copy(obj.userData.originalTransform.position);
                obj.rotation.copy(obj.userData.originalTransform.rotation);
                obj.scale.copy(obj.userData.originalTransform.scale);
                obj.userData.velocity.set(0, 0, 0);
                obj.updateMatrixWorld();
            }
        });

        physicsBodies.clear();
        physicsWorld = null;
        scene.remove(state.playerGroup);
        state.playerGroup = null;
        camera.position.copy(state.editorCameraTransform.position);
        camera.rotation.set(state.editorCameraTransform.rotation.x, state.editorCameraTransform.rotation.y, state.editorCameraTransform.rotation.z);
    }
}

if (playTestBtn) playTestBtn.onclick = togglePlayTest;

function animate() {
    requestAnimationFrame(animate);
    const isTyping = document.activeElement.tagName === 'INPUT';

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

// --- 2. PLAYER MOVEMENT ---
        const moveDir = new THREE.Vector3();
        if (!isTyping) {
            if (keys['KeyW']) moveDir.z -= 1; if (keys['KeyS']) moveDir.z += 1;
            if (keys['KeyA']) moveDir.x -= 1; if (keys['KeyD']) moveDir.x += 1;
        }

        if (moveDir.length() > 0) {
            // Face the camera's yaw direction before moving
            moveDir.normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), state.yaw);
            state.playerPhysicsBody.velocity.x = moveDir.x * (moveSpeed * 65);
            state.playerPhysicsBody.velocity.z = moveDir.z * (moveSpeed * 65);

          // --- PLAYER ROTATION ---
            const targetRotY = state.isFirstPerson 
                ? state.yaw 
                : Math.atan2(moveDir.x, moveDir.z) + Math.PI;
            
            // MATH TRICK: Find the shortest path to the target angle
            let angleDiff = targetRotY - state.playerGroup.rotation.y;
            angleDiff = Math.atan2(Math.sin(angleDiff), Math.cos(angleDiff)); 
            
            state.playerGroup.rotation.y += angleDiff * 0.15;
            
        } else {
            state.playerPhysicsBody.velocity.x = 0;
            state.playerPhysicsBody.velocity.z = 0;
        }

        // --- 3. GROUND CHECK (Updated for Tall Box) ---
        // Ray starts at center and goes down 1.9 units (1.8 height + 0.1 buffer)
        const from = state.playerPhysicsBody.position;
        const to = new CANNON.Vec3(from.x, from.y - 1.9, from.z);
        const raycastResult = new CANNON.RaycastResult();
        physicsWorld.raycastClosest(from, to, { skipBackfaces: true }, raycastResult);
        state.isGrounded = raycastResult.hasHit;

        if (keys['Space'] && state.isGrounded && !isTyping) {
            state.playerPhysicsBody.velocity.y = jumpStrength * 75;
            state.isGrounded = false;
        }

        // --- 4. STEP & SYNC ---
        physicsWorld.fixedStep(); 
        state.playerGroup.position.copy(state.playerPhysicsBody.position);

        physicsBodies.forEach((body, mesh) => {
            if (body.mass > 0) {
                mesh.position.copy(body.position);
                mesh.quaternion.copy(body.quaternion);
            }
        });

        // --- 5. CAMERA (Look at the Head at Y = 1.2) ---
        const headPos = state.playerGroup.position.clone().add(new THREE.Vector3(0, 1.2, 0));
        if (state.isFirstPerson) {
            camera.position.copy(headPos);
            camera.rotation.set(state.pitch, state.yaw, 0, 'YXZ');
        } else {
            const camOffset = new THREE.Vector3(
                state.cameraZoom * Math.sin(state.yaw) * Math.cos(state.pitch),
                state.cameraZoom * Math.sin(state.pitch),
                state.cameraZoom * Math.cos(state.yaw) * Math.cos(state.pitch)
            );
            camera.position.copy(headPos.clone().add(camOffset));
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

    renderer.render(scene, camera);
}

window.addEventListener('contextmenu', e => e.preventDefault());
updateExplorer();
updateToolUI('mode-select');
animate();