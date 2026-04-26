import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { scene, camera, renderer, baseplate, state, raycaster, composer, bloomPass, sun, gameUIContainer } from './setup.js';

export const transformControls = new TransformControls(camera, renderer.domElement);
scene.add(transformControls);

export const selectionGroup = new THREE.Group(); 
scene.add(selectionGroup);

export const selectionBox = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), 
    new THREE.LineBasicMaterial({ color: 0x00ff88, depthTest: false, transparent: true, opacity: 0.8 })
);
selectionBox.visible = false;
selectionBox.renderOrder = 1000;
selectionGroup.add(selectionBox); 

export const scaleHandles = new THREE.Group();
selectionGroup.add(scaleHandles); 

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
    sphere.renderOrder = 1000;
    sphere.userData.direction = data.dir;
    scaleHandles.add(sphere);
});
scaleHandles.visible = false;

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
        if (state.currentMode === 'scale') updateScaleHandles();
        updatePropertyValues();
    }
});

// --- SYSTEM REFRESH LOGIC ---
/**
 * Updates the entire scene based on where items are in the explorer.
 */
export function refreshSceneState() {
    // 1. Reset Global Environment Effects
    if (scene.fog) scene.fog = null;
    if (bloomPass) bloomPass.strength = 0;
    if (sun) sun.intensity = 1.2;
    gameUIContainer.innerHTML = ''; 

    const processItem = (item, inWorld = false, inLighting = false, inUI = false) => {
        const isWorld = inWorld || item.id === 'world-folder';
        const isLighting = inLighting || item.id === 'folder-lighting';
        const isUI = inUI || item.id === 'folder-ui';

        // Handle Physical Objects & Lights (Only functional in the World)
        if (item.objectRef) {
            const parentItem = findParentItem(item.id);
            const parentObj = (parentItem && parentItem.objectRef) ? parentItem.objectRef : scene;
            
            if (isWorld) {
                // Ensure the 3D object is in the scene and parented correctly
                if (item.objectRef.parent !== parentObj && !state.selectedObjects.includes(item.objectRef)) {
                    parentObj.add(item.objectRef);
                }
                
                if (item.objectRef.isMesh) item.objectRef.visible = true;

                // Special Light Logic
                if (item.type === 'light') {
                    const isInsidePart = parentItem && parentItem.type === 'object';
                    
                    // Toggle the "bulb" helper: Hide it if parented to a part
                    const helper = item.objectRef.children.find(c => c.isMesh);
                    if (helper) helper.visible = !isInsidePart;
                    
                    // If inside a part, center the light source within it
                    if (isInsidePart) item.objectRef.position.set(0, 0, 0);
                    
                    const lp = item.properties || {};
                    const light = item.objectRef.children.find(c => c.isLight);
                    if (light) {
                        light.intensity = lp.intensity ?? 1;
                        light.distance = lp.range ?? 100;
                        light.color.set(lp.color || '#ffffff');
                    }
                }
            } else {
                // Remove from scene if moved out of World
                if (item.objectRef.parent) item.objectRef.parent.remove(item.objectRef);
                if (item.objectRef.isMesh) item.objectRef.visible = false;
            }
        }

        // Handle UI Elements
        if (isUI && (item.type === 'textlabel' || item.type === 'textbutton')) {
            const p = item.properties || {};
            const el = document.createElement(item.type === 'textbutton' ? 'button' : 'div');
            el.innerText = p.text || 'UI Element';
            el.style.cssText = `
                position: absolute; pointer-events: auto; padding: 5px 10px;
                background: ${p.color || '#444444'}; color: ${p.textColor || '#ffffff'};
                font-size: ${p.fontSize || 14}px; border: none; border-radius: 4px;
                display: ${p.visible === false ? 'none' : 'block'};
            `;
            // Dummy position for demo
            el.style.top = '20px'; el.style.left = '20px';
            gameUIContainer.appendChild(el);
        }

        // Handle Effects (Only in Lighting)
        if (isLighting && item.type === 'effect') {
            const p = item.properties || {};
            if (item.subType === 'bloom') {
                bloomPass.strength = p.strength || 0;
                bloomPass.radius = p.radius || 0.4;
            } else if (item.subType === 'fog') {
                scene.fog = new THREE.FogExp2(p.color || 0x87CEEB, p.density || 0.01);
            } else if (item.subType === 'sunrays') {
                if (sun) sun.intensity = p.intensity || 2;
            }
        }

        if (item.children) {
            item.children.forEach(child => processItem(child, isWorld, isLighting, isUI));
        }
    };

    explorerHierarchy.items.forEach(item => processItem(item));
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
    propertyControls.appendChild(dynamicProps);
}

const colorPicker = document.getElementById('prop-color');
const deleteBtn = document.getElementById('prop-delete');
const posInputs = { x: document.getElementById('prop-pos-x'), y: document.getElementById('prop-pos-y'), z: document.getElementById('prop-pos-z') };
const rotInputs = { x: document.getElementById('prop-rot-x'), y: document.getElementById('prop-rot-y'), z: document.getElementById('prop-rot-z') };
const scaleInputs = { x: document.getElementById('prop-scale-x'), y: document.getElementById('prop-scale-y'), z: document.getElementById('prop-scale-z') };
const anchoredInput = document.getElementById('prop-anchored');
const collideInput = document.getElementById('prop-collide');
const opacityInput = document.getElementById('prop-opacity');
const roughnessInput = document.getElementById('prop-roughness');
const explorerMenu = document.getElementById('explorer-menu');

document.getElementById('right-sidebar').addEventListener('mousedown', (e) => e.stopPropagation());

// --- HIERARCHICAL EXPLORER SYSTEM ---
export const explorerHierarchy = {
    items: [],
    expanded: {},
    objectCounter: { 'object': 1, 'folder': 1, 'model': 1, 'light': 1, 'effect': 1, 'sound': 1 },
    
    getOrCreateWorld() {
        let world = this.items.find(item => item.type === 'folder' && item.name === 'World');
        if (!world) {
            world = { id: 'world-folder', type: 'folder', name: 'World', children: [], isProtected: true };
            this.items.push(world);
            // Add Baseplate to explorer
            const bpItem = { id: 'obj-baseplate', type: 'object', name: 'Baseplate', objectRef: baseplate, isProtected: false };
            world.children.push(bpItem);
            this.expanded['world-folder'] = true;
        }
        return world;
    },

    initializeDefaultFolders() {
        const defaultFolders = [
            { name: 'Lighting', icon: '💡', properties: { brightness: 1, ambient: 0.4, sunDirection: { x: 50, y: 100, z: 50 } } },
            { name: 'Camera', icon: '📷', properties: { viewDistance: 500, fov: 75 } },
            { name: 'UI', icon: '🎨', properties: { scaleMode: 'scale', enabled: true } },
            { name: 'Terrain', icon: '🏔️', properties: { material: 'Grass' } },
            { name: 'Audio', icon: '🔊', properties: {} },
            { name: 'Effects', icon: '✨', properties: {} },
            { name: 'Scripting', icon: '📝', properties: {} }
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
            'effect': 'Effect',
            'sound': 'Sound',
            'bloom': 'Bloom',
            'sunrays': 'SunRays',
            'fog': 'Fog',
            'particle': 'Particle',
            'decal': 'Decal',
            'textlabel': 'TextLabel',
            'imagebutton': 'ImageButton',
            'textbutton': 'TextButton'
        };
        const key = type.toLowerCase();
        return `${names[key] || type} ${this.objectCounter[key] || this.objectCounter['object']++}`;
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
        if (newParent && newParent.children) {
            newParent.children.push(item);
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
    itemEl.style.marginLeft = (depth * 10) + 'px';
    itemEl.draggable = true; // All items (Objects, Folders, Models) can now be dragged
    itemEl.dataset.itemId = item.id;
    
    const isObjectSelected = item.objectRef && state.selectedObjects.includes(item.objectRef);
    const isItemSelected = state.currentSelectedItem === item;
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
    
    // Icon for the item
    const iconSpan = document.createElement('span');
    iconSpan.style.marginRight = '5px';
    const icons = {
        'folder': '📁',
        'model': '🎁',
        'object': '🟦',
        'light': '💡',
        'effect': '✨',
        'sound': '🔊'
    };
    iconSpan.innerText = icons[item.type] || icons['object'];
    itemEl.appendChild(iconSpan);
    
    // Item name
    const nameSpan = document.createElement('span');
    nameSpan.innerText = item.name;
    nameSpan.style.flex = '1';
    itemEl.appendChild(nameSpan);
    
    // Plus button
    const plus = document.createElement('div');
    plus.className = 'exp-plus';
    plus.innerText = '+';
    plus.onclick = (e) => {
        e.stopPropagation();
        currentContextId = item.id;
        
        // Show all possible items regardless of context
        const menuItems = [
            { type: 'create', label: 'Part', objectType: 'Object' },
            { type: 'create', label: 'Folder', objectType: 'Folder' },
            { type: 'create', label: 'Model', objectType: 'Model' },
            { type: 'divider' },
            { type: 'create', label: '💡 Light', objectType: 'Light' },
            { type: 'create', label: '🔊 Sound', objectType: 'Sound' },
            { type: 'divider' },
            { type: 'create', label: '✨ Bloom', objectType: 'Bloom' },
            { type: 'create', label: '🌫️ Fog', objectType: 'Fog' },
            { type: 'create', label: '☀️ Sun Rays', objectType: 'SunRays' },
            { type: 'create', label: '💫 Particles', objectType: 'ParticleEmitter' },
            { type: 'divider' },
            { type: 'create', label: 'Text Label', objectType: 'TextLabel' },
            { type: 'create', label: 'Image Button', objectType: 'ImageButton' },
            { type: 'create', label: 'Text Button', objectType: 'TextButton' }
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
        
        showRightClickMenu(e.pageX, e.pageY, item.id);
    });
    
    // Click to select object (or select all in container)
    itemEl.onclick = (e) => {
        e.stopPropagation();
        
        if (item.type === 'folder' || item.type === 'model' || item.type === 'light' || item.type === 'effect' || item.type === 'sound') {
            // Select the folder/model itself for property editing
            state.currentSelectedItem = item;
            
            // Also select all objects inside this folder/model if it's a container
            if (item.children) {
                const allObjects = explorerHierarchy.getAllObjectsInItem(item.id);
                if (allObjects.length > 0) {
                    clearSelection();
                    allObjects.forEach((obj, i) => attachTool(obj, i > 0));
                }
            }
            showInspector();
        } else if (item.objectRef) {
            // For objects, check if they're inside a model - if so, select all in that model
            state.currentSelectedItem = null;
            const modelParent = findModelParent(item.id);
            if (modelParent) {
                const allInModel = explorerHierarchy.getAllObjectsInItem(modelParent.id);
                clearSelection();
                allInModel.forEach((obj, i) => attachTool(obj, i > 0));
                showInspector();
            } else {
                // Regular object selection
                attachTool(item.objectRef, e.shiftKey);
            }
        }
    };
    
    // Drag and drop
    itemEl.addEventListener('dragstart', (e) => {
        draggedItemId = item.id;
        e.dataTransfer.effectAllowed = 'move';
    });
    
    itemEl.addEventListener('dragover', (e) => {
        if (item.children) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            itemEl.style.backgroundColor = 'rgba(0, 255, 136, 0.2)';
        }
    });
    
    itemEl.addEventListener('dragleave', () => {
        itemEl.style.backgroundColor = '';
    });
    
    itemEl.addEventListener('drop', (e) => {
        e.stopPropagation();
        itemEl.style.backgroundColor = '';
        
        if (draggedItemId && draggedItemId !== item.id && item.children) {
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

function findModelParent(itemId) {
    const search = (items, parent = null) => {
        for (let item of items) {
            if (item.id === itemId && parent && parent.type === 'model') return parent;
            if (item.children) {
                const found = search(item.children, item);
                if (found) return found;
            }
        }
        return null;
    };
    return search(explorerHierarchy.items);
}

function findParentItem(itemId) {
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
    if (objectIdCache.has(obj)) return objectIdCache.get(obj);
    
    const search = (items) => {
        for (let item of items) {
            if (item.objectRef === obj) {
                objectIdCache.set(obj, item.id);
                return item.id;
            }
            if (item.children) {
                const found = search(item.children);
                if (found) return found;
            }
        }
        return null;
    };
    return search(explorerHierarchy.items);
}

export function updateExplorer() {
    explorerList.innerHTML = '';
    explorerHierarchy.items.forEach(item => {
        explorerList.appendChild(renderExplorerItem(item, 0));
    });
}

/**
 * Updates the UV coordinates of a BoxGeometry to prevent texture stretching.
 * Tiles the texture based on the physical world scale of the object.
 */
export function updateObjectUVs(obj) {
    if (!obj || !obj.geometry || obj.geometry.type !== 'BoxGeometry') return;
    
    const geometry = obj.geometry;
    const uvAttr = geometry.attributes.uv;
    const tx = obj.userData.tileScaleX || 1;
    const ty = obj.userData.tileScaleY || 1;
    
    const worldScale = new THREE.Vector3();
    obj.getWorldScale(worldScale);

    // BoxGeometry face order: +X, -X, +Y, -Y, +Z, -Z
    const faceScales = [
        [worldScale.z, worldScale.y], [worldScale.z, worldScale.y], // Sides (X)
        [worldScale.x, worldScale.z], [worldScale.x, worldScale.z], // Top/Bottom (Y)
        [worldScale.x, worldScale.y], [worldScale.x, worldScale.y]  // Front/Back (Z)
    ];

    for (let i = 0; i < 6; i++) {
        const [w, h] = faceScales[i];
        const off = i * 4;
        uvAttr.setXY(off + 0, 0, h * ty);
        uvAttr.setXY(off + 1, w * tx, h * ty);
        uvAttr.setXY(off + 2, 0, 0);
        uvAttr.setXY(off + 3, w * tx, 0);
    }
    uvAttr.needsUpdate = true;
}

export function updatePropertyValues() {
    if (state.selectedObjects.length === 0) return;
    
    let worldPos = new THREE.Vector3();
    let worldQuat = new THREE.Quaternion();
    let worldScale = new THREE.Vector3();
    let worldEuler = new THREE.Euler();
    
    if (state.selectedObjects.length === 1) {
        const obj = state.selectedObjects[0];
        obj.getWorldPosition(worldPos); 
        obj.getWorldQuaternion(worldQuat); 
        obj.getWorldScale(worldScale);
        anchoredInput.checked = obj.userData.anchored !== false;
        collideInput.checked = obj.userData.canCollide !== false;
        roughnessInput.value = (obj.material && obj.material.roughness !== undefined) ? obj.material.roughness.toFixed(2) : 0.8;
        opacityInput.value = obj.userData.opacity !== undefined ? obj.userData.opacity : 1;
        if (obj.material && obj.material.transparent) {
            obj.material.opacity = opacityInput.value;
        }
        tileScaleXInput.value = obj.userData.tileScaleX || 1;
        tileScaleYInput.value = obj.userData.tileScaleY || 1;
    } else {
        // For multi-select, read the center of the selection group
        worldPos.copy(selectionGroup.position);
        worldQuat.copy(selectionGroup.quaternion);
        worldScale.copy(selectionGroup.scale);
        anchoredInput.checked = state.selectedObjects.every(o => o.userData.anchored !== false);
        collideInput.checked = state.selectedObjects.every(o => o.userData.canCollide !== false);
    }
    
    worldEuler.setFromQuaternion(worldQuat);

    posInputs.x.value = worldPos.x.toFixed(2); 
    posInputs.y.value = worldPos.y.toFixed(2); 
    posInputs.z.value = worldPos.z.toFixed(2);
    
    rotInputs.x.value = THREE.MathUtils.radToDeg(worldEuler.x).toFixed(0); 
    rotInputs.y.value = THREE.MathUtils.radToDeg(worldEuler.y).toFixed(0); 
    rotInputs.z.value = THREE.MathUtils.radToDeg(worldEuler.z).toFixed(0);
    
    scaleInputs.x.value = worldScale.x.toFixed(2); 
    scaleInputs.y.value = worldScale.y.toFixed(2); 
    scaleInputs.z.value = worldScale.z.toFixed(2);

    // Recalculate UVs whenever properties (like scale) change
    state.selectedObjects.forEach(obj => updateObjectUVs(obj));
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
    if (state.selectedObjects.length === 0) return;
    selectionGroup.position.set(parseFloat(posInputs.x.value) || 0, parseFloat(posInputs.y.value) || 0, parseFloat(posInputs.z.value) || 0);
    selectionGroup.rotation.set(THREE.MathUtils.degToRad(parseFloat(rotInputs.x.value) || 0), THREE.MathUtils.degToRad(parseFloat(rotInputs.y.value) || 0), THREE.MathUtils.degToRad(parseFloat(rotInputs.z.value) || 0));

    const targetScaleX = parseFloat(scaleInputs.x.value) || 1, targetScaleY = parseFloat(scaleInputs.y.value) || 1, targetScaleZ = parseFloat(scaleInputs.z.value) || 1;
    if (state.selectedObjects.length === 1) {
        const obj = state.selectedObjects[0];
        selectionGroup.scale.set(targetScaleX / Math.max(0.0001, obj.scale.x), targetScaleY / Math.max(0.0001, obj.scale.y), targetScaleZ / Math.max(0.0001, obj.scale.z));
    } else {
        selectionGroup.scale.set(targetScaleX, targetScaleY, targetScaleZ);
    }
    if (state.currentMode === 'scale') updateScaleHandles();
};

[...Object.values(posInputs), ...Object.values(rotInputs), ...Object.values(scaleInputs)].forEach(input => input.oninput = handleManualInput);

collideInput.onchange = () => {
    state.selectedObjects.forEach(obj => {
        obj.userData.canCollide = collideInput.checked;
    });
};

opacityInput.oninput = () => {
    const opacityValue = parseFloat(opacityInput.value);
    state.selectedObjects.forEach(obj => {
        obj.userData.opacity = opacityValue;
        if (obj.material) {
            obj.material.transparent = true;
            obj.material.opacity = opacityValue;
        }
    });
};

roughnessInput.oninput = () => {
    const roughnessValue = parseFloat(roughnessInput.value);
    state.selectedObjects.forEach(obj => {
        if (obj.material) {
            obj.material.roughness = roughnessValue;
        }
    });
};

// --- MATERIAL SYSTEM ---
const materialSelect = document.getElementById('prop-material');
const tileScaleXInput = document.getElementById('prop-tile-scale-x');
const tileScaleYInput = document.getElementById('prop-tile-scale-y');

export const materials = {
    list: ['Grass', 'Sand', 'Concrete', 'Bricks', 'Wood', 'WoodPlanks'],
    cache: {},
    textureLoader: new THREE.TextureLoader(),
    
    async loadMaterial(name) {
        if (this.cache[name]) return this.cache[name];
        
        try {
            const basePath = `./Materials/${name}/`;
            const [colorTex, roughnessTex, normalTex] = await Promise.all([
                new Promise((res, rej) => this.textureLoader.load(`${basePath}${name}.png`, res, undefined, rej)),
                new Promise((res, rej) => this.textureLoader.load(`${basePath}${name}Roughness.png`, res, undefined, rej)),
                new Promise((res, rej) => this.textureLoader.load(`${basePath}${name}Normal.png`, res, undefined, rej))
            ]);

            // Configure textures for best quality
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
        
        // Clone textures so each object has independent tiling
        const colorTex = loadedMat.colorTex.clone();
        const roughnessTex = loadedMat.roughnessTex.clone();
        const normalTex = loadedMat.normalTex.clone();
        
        // Set repeating and offset for tiling
        const setTiling = (tex) => {
            tex.repeat.set(1, 1); // We now handle tiling via UVs
            tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        };
        setTiling(colorTex);
        setTiling(roughnessTex);
        setTiling(normalTex);
        
        obj.material.map = colorTex;
        obj.material.roughnessMap = roughnessTex;
        obj.material.roughness = 0.8; // Base roughness value
        obj.material.normalMap = normalTex;
        obj.material.normalScale.set(0.5, 0.5); // Adjust normal strength
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
    const tx = parseFloat(tileScaleXInput.value) || 1;
    const ty = parseFloat(tileScaleYInput.value) || 1;
    
    state.selectedObjects.forEach(obj => {
        if (!obj.material) return;
        
        if (materialName === '') {
            // Remove material, reset to white
            obj.material.map = null;
            obj.material.roughnessMap = null;
            obj.material.normalMap = null;
            obj.material.roughness = 0.8;
            obj.userData.material = '';
            obj.material.needsUpdate = true;
        } else {
            materials.applyToObject(obj, materialName, tx, ty);
        }
    });
};

const handleTileUpdate = () => {
    if (state.selectedObjects.length === 0 || !materialSelect.value) return;
    const tx = parseFloat(tileScaleXInput.value) || 1;
    const ty = parseFloat(tileScaleYInput.value) || 1;
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

export function showInspector() {
    const currentItem = state.currentSelectedItem;
    
    // If a folder/model is selected, show its properties
    if (currentItem && (currentItem.type === 'folder' || currentItem.type === 'model' || currentItem.type === 'effect' || currentItem.type === 'sound')) {
        propertyControls.style.display = 'flex';
        noSelectionText.style.display = 'none';
        
        nameInput.value = currentItem.name;
        nameInput.disabled = currentItem.isProtected;
        colorPicker.parentElement.style.opacity = "0.5";
        deleteBtn.style.visibility = (currentItem.isProtected) ? 'hidden' : 'visible';
        
        // Hide object-specific properties
        colorPicker.parentElement.parentElement.style.display = 'none'; // Color
        document.getElementById('prop-material').parentElement.style.display = 'none'; // Material
        document.getElementById('prop-roughness').parentElement.style.display = 'none'; // Roughness
        document.getElementById('prop-tile-scale-x').parentElement.style.display = 'none'; // Tile scales
        document.getElementById('prop-anchored').parentElement.style.display = 'none'; // Anchored
        document.getElementById('prop-collide').parentElement.style.display = 'none'; // Can Collide
        document.getElementById('prop-opacity').parentElement.style.display = 'none'; // Opacity
        
        // Clear position/rotation/scale inputs
        posInputs.x.value = posInputs.y.value = posInputs.z.value = 0;
        rotInputs.x.value = rotInputs.y.value = rotInputs.z.value = 0;
        scaleInputs.x.value = scaleInputs.y.value = scaleInputs.z.value = 1;
        
        // Show folder-specific properties if they exist
        if (currentItem.properties) {
            Object.keys(currentItem.properties).forEach(key => {
                const val = currentItem.properties[key];
                let type = typeof val === 'number' ? 'number' : (typeof val === 'boolean' ? 'boolean' : 'color');
                if (key.toLowerCase().includes('color')) type = 'color';

                const control = createPropertyControl(key, val, type, (newVal) => {
                    currentItem.properties[key] = type === 'number' ? parseFloat(newVal) : newVal;
                    refreshSceneState();
                });
                dynamicProps.appendChild(control);
            });
        }
        
        updateExplorer();
        return;
    }
    
    // Regular object selection
    if (state.selectedObjects.length > 0) {
        propertyControls.style.display = 'flex'; 
        noSelectionText.style.display = 'none';
        
        // Show object-specific properties again
        colorPicker.parentElement.parentElement.style.display = 'block';
        document.getElementById('prop-material').parentElement.style.display = 'block';
        document.getElementById('prop-roughness').parentElement.style.display = 'block';
        document.getElementById('prop-tile-scale-x').parentElement.style.display = 'block';
        document.getElementById('prop-anchored').parentElement.style.display = 'block';
        document.getElementById('prop-collide').parentElement.style.display = 'block';
        document.getElementById('prop-opacity').parentElement.style.display = 'block';
        
        if (state.selectedObjects.length > 1) {
            nameInput.value = "Multiple Objects";
            nameInput.disabled = true;
            colorPicker.parentElement.style.opacity = "0.5";
            deleteBtn.style.visibility = 'visible';
            materialSelect.value = '';
            roughnessInput.value = 0.8;
            tileScaleXInput.value = 1;
            tileScaleYInput.value = 1;
        } else {
            const target = state.selectedObjects[0];
            nameInput.value = target.name;
            nameInput.disabled = false;
            colorPicker.value = '#' + target.material.color.getHexString();
            colorPicker.parentElement.style.opacity = "1";
            deleteBtn.style.visibility = 'visible';
            
            // Update material and tile scale
            materialSelect.value = target.userData.material || '';
            roughnessInput.value = target.material.roughness !== undefined ? target.material.roughness : 0.8;
            tileScaleXInput.value = target.userData.tileScaleX || 1;
            tileScaleYInput.value = target.userData.tileScaleY || 1;
        }
        // Moved this outside the if/else so it updates fields for BOTH single and multi-select
        updatePropertyValues();
    } else {
        propertyControls.style.display = 'none';
        noSelectionText.style.display = 'block';
    }
    updateExplorer();
}

colorPicker.oninput = () => { state.selectedObjects.forEach(obj => { if (obj.material) obj.material.color.set(colorPicker.value); }); };

anchoredInput.onchange = () => {
    state.selectedObjects.forEach(obj => {
        obj.userData.anchored = anchoredInput.checked;
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
    
    if (type === 'Object') {
        // Create a new 3D object
        const geometry = new THREE.BoxGeometry(2, 2, 2);
        const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true }));
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        const objName = explorerHierarchy.getNextName('object');
        mesh.name = objName;
        mesh.userData.anchored = true;
        mesh.userData.canCollide = true;
        mesh.userData.velocity = new THREE.Vector3(0, 0, 0);
        
        scene.add(mesh);
        state.selectableObjects.push(mesh);
        placeOnTargetSurface(mesh);
        
        // Add to hierarchy
        const item = { id: `obj-${Date.now()}-${Math.floor(Math.random() * 1000)}`, type: 'object', name: objName, objectRef: mesh };
        parent.children.push(item);
        explorerHierarchy.expanded[parentId] = true;
        attachTool(mesh, false);
        
    } else if (type === 'Light') {
        const lightName = explorerHierarchy.getNextName('light');
        const lightGroup = new THREE.Group();
        const light = new THREE.PointLight(0xffffff, 1, 100);
        light.castShadow = true;
        const visual = new THREE.Mesh(
            new THREE.SphereGeometry(0.5, 8, 8),
            new THREE.MeshBasicMaterial({ color: 0xffff00, wireframe: true })
        );
        lightGroup.add(light);
        lightGroup.add(visual);
        lightGroup.name = lightName;
        
        state.selectableObjects.push(lightGroup);
        placeOnTargetSurface(lightGroup);
        
        const item = { 
            id: `light-${Date.now()}`, type: 'light', name: lightName, objectRef: lightGroup,
            properties: { intensity: 1, range: 100, color: '#ffffff' }
        };
        parent.children.push(item);
        refreshSceneState();
        attachTool(lightGroup, false);
        
    } else if (type === 'Bloom') {
        const bloomName = explorerHierarchy.getNextName('bloom');
        const item = { id: `bloom-${Date.now()}`, type: 'effect', subType: 'bloom', name: bloomName, properties: { strength: 1.5, radius: 0.4, threshold: 0.85 } };
        parent.children.push(item);
        refreshSceneState();
        
    } else if (type === 'SunRays') {
        const sunraysName = explorerHierarchy.getNextName('sunrays');
        const item = { id: `sunrays-${Date.now()}`, type: 'effect', subType: 'sunrays', name: sunraysName, properties: { intensity: 2 } };
        parent.children.push(item);
        refreshSceneState();
        
    } else if (type === 'Fog') {
        const fogName = explorerHierarchy.getNextName('fog');
        const item = { id: `fog-${Date.now()}`, type: 'effect', subType: 'fog', name: fogName, properties: { color: '#87CEEB', density: 0.01 } };
        parent.children.push(item);
        refreshSceneState();
    } else if (type === 'ParticleEmitter') {
        const name = explorerHierarchy.getNextName('particle');
        const item = { id: `parti-${Date.now()}`, type: 'effect', subType: 'particle', name: name, properties: { rate: 100, lifetime: 3, speed: 5 } };
        parent.children.push(item);
        refreshSceneState();
    } else if (type === 'Sound') {
        const name = explorerHierarchy.getNextName('sound');
        const item = { id: `snd-${Date.now()}`, type: 'sound', name: name, properties: { volume: 0.5, pitch: 1, looped: false } };
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
        const item = { id: `ui-${Date.now()}`, type: 'textlabel', name: name, properties: { text: 'Label', fontSize: 18, color: '#ffffff', visible: true } };
        parent.children.push(item);
    } else if (type === 'TextButton') {
        const name = explorerHierarchy.getNextName('textbutton');
        const item = { id: `ui-${Date.now()}`, type: 'textbutton', name: name, properties: { text: 'Button', color: '#444444', textColor: '#ffffff' } };
        parent.children.push(item);
    } else if (type === 'ImageButton') {
        const name = explorerHierarchy.getNextName('imagebutton');
        const item = { id: `ui-${Date.now()}`, type: 'imagebutton', name: name, properties: { imageAssetId: 0, transparency: 0 } };
        parent.children.push(item);
    }
    
    explorerHierarchy.expanded[parentId] = true;
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
    const hasSelection = state.selectedObjects.length > 0;
    const isContainer = contextItem && (contextItem.type === 'folder' || contextItem.type === 'model');

    let menuHtml = '';
    const menuItems = [];

    // Add options based on context
    if (isContainer) {
        const folderName = contextItem.name || '';
        
        // Always allow basic objects
        menuItems.push({ type: 'create', label: 'Add Part', objectType: 'Object' });
        menuItems.push({ type: 'create', label: 'Add Folder', objectType: 'Folder' });
        menuItems.push({ type: 'create', label: 'Add Model', objectType: 'Model' });
        
        // Context-specific items
        if (folderName === 'Lighting') {
            menuItems.push({ type: 'divider' });
            menuItems.push({ type: 'create', label: '💡 Add Light', objectType: 'Light' });
            menuItems.push({ type: 'create', label: '✨ Add Bloom', objectType: 'Bloom' });
            menuItems.push({ type: 'create', label: '☀️ Add Sun Rays', objectType: 'SunRays' });
            menuItems.push({ type: 'create', label: '🌫️ Add Fog', objectType: 'Fog' });
        } else if (folderName === 'Effects') {
            menuItems.push({ type: 'divider' });
            menuItems.push({ type: 'create', label: '✨ Add Bloom', objectType: 'Bloom' });
            menuItems.push({ type: 'create', label: '☀️ Add Sun Rays', objectType: 'SunRays' });
            menuItems.push({ type: 'create', label: '🌫️ Add Fog', objectType: 'Fog' });
            menuItems.push({ type: 'create', label: '💫 Add Particle Emitter', objectType: 'ParticleEmitter' });
        } else if (folderName === 'Audio') {
            menuItems.push({ type: 'divider' });
            menuItems.push({ type: 'create', label: '🔊 Add Sound', objectType: 'Sound' });
        } else if (folderName === 'UI') {
            menuItems.push({ type: 'divider' });
            menuItems.push({ type: 'create', label: 'Text Label', objectType: 'TextLabel' });
            menuItems.push({ type: 'create', label: 'Image Button', objectType: 'ImageButton' });
            menuItems.push({ type: 'create', label: 'Text Button', objectType: 'TextButton' });
        } else {
            // For other folders/models, show general options
            menuItems.push({ type: 'divider' });
            menuItems.push({ type: 'create', label: '💡 Light', objectType: 'Light' });
            menuItems.push({ type: 'create', label: '🔊 Sound', objectType: 'Sound' });
        }
        
        if (hasSelection) menuHtml += `<div style="border-top: 1px solid #444; margin: 5px 0;"></div>`;
    }

    // If there are objects selected, show grouping options
    if (hasSelection) {
        const count = state.selectedObjects.length;
        const labelSuffix = count > 1 ? ` (${count} items)` : '';
        menuItems.push({ type: 'group-model', label: `Group as Model${labelSuffix}` });
        menuItems.push({ type: 'group-folder', label: `Group as Folder${labelSuffix}` });
    }

    // Delete logic with protection check
    if (isContainer && !contextItem.isProtected) {
        menuItems.push({ type: 'delete', label: `Delete ${contextItem.name}`, isDelete: true });
    } else if (hasSelection) {
        let deleteLabel = 'Delete';
        if (state.selectedObjects.length > 1) deleteLabel = `Delete Selection (${state.selectedObjects.length})`;
        else deleteLabel = `Delete ${state.selectedObjects[0].name}`;
        menuItems.push({ type: 'delete', label: deleteLabel, isDelete: true });
    } else if (contextItem && !contextItem.isProtected) {
        menuItems.push({ type: 'delete', label: `Delete ${contextItem.name}`, isDelete: true });
    }

    if (menuItems.length === 0) {
        rightClickMenu.style.display = 'none';
        return;
    }

    // Build HTML and attach event listeners
    menuHtml = '';
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
                
                if (item.type === 'create') {
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

window.groupAsModel = () => {
    const toGroup = [...state.selectedObjects];
    if (toGroup.length === 0) return;
    
    const modelName = explorerHierarchy.getNextName('model');
    const modelId = `model-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const modelItem = { id: modelId, type: 'model', name: modelName, children: [] };
    
    const parent = getActiveParent();
    parent.children.push(modelItem);
    
    if (parent.id) explorerHierarchy.expanded[parent.id] = true;
    explorerHierarchy.expanded[modelId] = true;

    toGroup.forEach(obj => {
        const itemId = findItemIdForObject(obj);
        if (itemId) explorerHierarchy.moveItem(itemId, modelId);
    });

    updateExplorer();
    rightClickMenu.style.display = 'none';
};

window.groupAsFolder = () => {
    const toGroup = [...state.selectedObjects];
    if (toGroup.length === 0) return;
    
    const folderName = explorerHierarchy.getNextName('folder');
    const folderId = `folder-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const folderItem = { id: folderId, type: 'folder', name: folderName, children: [] };

    const parent = getActiveParent();
    parent.children.push(folderItem);

    if (parent.id) explorerHierarchy.expanded[parent.id] = true;
    explorerHierarchy.expanded[folderId] = true;

    toGroup.forEach(obj => {
        const itemId = findItemIdForObject(obj);
        if (itemId) explorerHierarchy.moveItem(itemId, folderId);
    });
    
    updateExplorer();
    rightClickMenu.style.display = 'none';
};

window.deleteSelected = () => {
    const contextItem = currentContextId ? explorerHierarchy.findItemById(currentContextId) : null;
    const idsToDelete = new Set();
    
    // 1. Determine what to delete
    if (contextItem && (contextItem.type === 'folder' || contextItem.type === 'model')) {
        idsToDelete.add(currentContextId);
    } else if (state.selectedObjects.length > 0) {
        state.selectedObjects.forEach(obj => {
            if (!obj) return; // Defensive check
            const id = findItemIdForObject(obj);
            if (id) idsToDelete.add(id);
        });
    } else if (currentContextId) {
        idsToDelete.add(currentContextId);
    }

    if (idsToDelete.size === 0) return;

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
    state.selectedObjects = [];
    state.currentSelectedItem = null;
    transformControls.detach(); scaleHandles.visible = false; selectionBox.visible = false;
}

deleteBtn.onclick = () => {
    window.deleteSelected();
};

export function attachTool(obj, isMulti = false) {
    if (!obj) return; // Defensive null check
    const currentChildren = [...selectionGroup.children].filter(c => c !== selectionBox && c !== scaleHandles);
    currentChildren.forEach(child => scene.attach(child));

    // Check if this object is inside a model - if so, select all in the model
    const modelParent = findModelParent(findItemIdForObject(obj));
    if (modelParent && !isMulti) {
        const allInModel = explorerHierarchy.getAllObjectsInItem(modelParent.id);
        state.selectedObjects = allInModel.length > 0 ? allInModel : [obj];
    } else {
        if (!isMulti) { state.selectedObjects = [obj]; } 
        else {
            if (state.selectedObjects.includes(obj)) state.selectedObjects = state.selectedObjects.filter(o => o !== obj);
            else state.selectedObjects.push(obj);
        }
    }

    if (state.selectedObjects.length === 0) { clearSelection(); return; }
    
    const worldBox = new THREE.Box3();
    state.selectedObjects.forEach(o => worldBox.union(new THREE.Box3().setFromObject(o)));
    const center = new THREE.Vector3(); worldBox.getCenter(center);
    
    selectionGroup.remove(selectionBox); selectionGroup.remove(scaleHandles);
    selectionGroup.position.copy(center);
    
    if (state.selectedObjects.length === 1) selectionGroup.quaternion.copy(state.selectedObjects[0].getWorldQuaternion(new THREE.Quaternion()));
    else selectionGroup.rotation.set(0, 0, 0); 
    
    selectionGroup.scale.set(1, 1, 1); selectionGroup.updateMatrixWorld(true);
    state.selectedObjects.forEach(o => selectionGroup.attach(o));

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
    
    selectionBox.visible = true; showInspector(); 
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
        obj.position.copy(getSurfacePosition(intersects[0], obj));
    } else {
        const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
        obj.position.copy(camera.position).add(forward.multiplyScalar(10));
        if (obj.position.y < 1) obj.position.y = 1; 
    }
}

// --- COPY & PASTE ---

// Store the data of what we copied
let clipboard = [];

export function copySelection() {
    if (state.selectedObjects.length === 0) return;
    
    clipboard = state.selectedObjects.map(obj => {
        return {
            geometry: obj.geometry.clone(),
            material: obj.material.clone(),
            name: obj.name,
            position: obj.position.clone(),
            scale: obj.scale.clone(),
            rotation: obj.quaternion.clone(), // Use quaternion for accuracy
            userData: JSON.parse(JSON.stringify(obj.userData))
        };
    });
}

export function pasteSelection() {
    if (clipboard.length === 0) return;

    const newClones = [];
    const worldFolder = explorerHierarchy.getOrCreateWorld();
    const offsetAmount = 2; // Offset pasted objects slightly to avoid overlap
    
    clipboard.forEach((data, index) => {
        const mesh = new THREE.Mesh(data.geometry.clone(), data.material.clone());
        const newName = explorerHierarchy.getNextName('object') + ' (Copy)';
        mesh.name = newName;
        mesh.position.copy(data.position).add(new THREE.Vector3(offsetAmount * (index + 1), 0, 0));
        mesh.quaternion.copy(data.rotation);
        mesh.scale.copy(data.scale);
        mesh.userData = JSON.parse(JSON.stringify(data.userData));
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        scene.add(mesh);
        state.selectableObjects.push(mesh);
        newClones.push(mesh);
        
        // Reapply material if it exists
        if (data.userData.material && materials.cache[data.userData.material]) {
            const tx = data.userData.tileScaleX || 1;
            const ty = data.userData.tileScaleY || 1;
            materials.applyToObject(mesh, data.userData.material, tx, ty);
        }
        
        // Add to World folder in hierarchy
        const hierarchyItem = { id: `obj-${Date.now()}-${Math.floor(Math.random() * 1000)}`, type: 'object', name: mesh.name, objectRef: mesh };
        worldFolder.children.push(hierarchyItem);
    });

    if (newClones.length > 0) {
        clearSelection();
        
        // Select all pasted objects
        newClones.forEach((obj, i) => attachTool(obj, i > 0));
        
        updateExplorer();
        updatePropertyValues();
    }
}

const createShape = (isModelTab = false) => {
    const selectorId = isModelTab ? 'shape-selector-m' : 'shape-selector';
    const shapeType = document.getElementById(selectorId).value;
    let geometry;
    if (shapeType === 'cube') geometry = new THREE.BoxGeometry(2, 2, 2);
    else if (shapeType === 'sphere') geometry = new THREE.SphereGeometry(1.2, 32, 32);
    else if (shapeType === 'cylinder') geometry = new THREE.CylinderGeometry(1, 1, 2, 32);

    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true }));
    
    mesh.castShadow = true; 
    mesh.receiveShadow = true; 
    const meshName = explorerHierarchy.getNextName('object');
    mesh.name = meshName;
    
    mesh.userData.anchored = true;
    mesh.userData.canCollide = true;
    mesh.userData.velocity = new THREE.Vector3(0, 0, 0);
    mesh.userData.originalTransform = null;

    scene.add(mesh); 
    state.selectableObjects.push(mesh);
    
    // Add to World folder in hierarchy
    const worldFolder = explorerHierarchy.getOrCreateWorld();
    const hierarchyItem = { id: `obj-${Date.now()}`, type: 'object', name: mesh.name, objectRef: mesh };
    worldFolder.children.push(hierarchyItem);
    
    placeOnTargetSurface(mesh); 
    attachTool(mesh, false); 
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
export const snapValue = (v) => (state.snapAmount > 0 ? Math.round(v / state.snapAmount) * state.snapAmount : v);
function updateSnap() {
    state.snapAmount = parseFloat(snapInput.value) || 0;
    transformControls.translationSnap = state.snapAmount;
    transformControls.rotationSnap = THREE.MathUtils.degToRad(15 * state.snapAmount);
}
snapInput.oninput = updateSnap; updateSnap();
