import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { scene, camera, renderer, baseplate, state, raycaster } from './setup.js';

export const transformControls = new TransformControls(camera, renderer.domElement);
scene.add(transformControls);

export const selectionGroup = new THREE.Group(); 
scene.add(selectionGroup);

export const selectionBox = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), 
    new THREE.LineBasicMaterial({ color: 0x00ff88, depthTest: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 })
);
selectionBox.visible = false;
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
    sphere.userData.direction = data.dir;
    scaleHandles.add(sphere);
});
scaleHandles.visible = false;

export function updateScaleHandles() {
    if (state.selectedObjects.length === 0 || state.currentMode !== 'scale') {
        scaleHandles.visible = false; return;
    }
    scaleHandles.visible = true;
    const invScale = new THREE.Vector3(1 / selectionGroup.scale.x, 1 / selectionGroup.scale.y, 1 / selectionGroup.scale.z);

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

// --- UI AND INSPECTOR ---
const explorerList = document.getElementById('explorer-list');
const propertyControls = document.getElementById('property-controls');
const noSelectionText = document.getElementById('no-selection-text');
const nameInput = document.getElementById('prop-name');
const colorPicker = document.getElementById('prop-color');
const deleteBtn = document.getElementById('prop-delete');
const posInputs = { x: document.getElementById('prop-pos-x'), y: document.getElementById('prop-pos-y'), z: document.getElementById('prop-pos-z') };
const rotInputs = { x: document.getElementById('prop-rot-x'), y: document.getElementById('prop-rot-y'), z: document.getElementById('prop-rot-z') };
const scaleInputs = { x: document.getElementById('prop-scale-x'), y: document.getElementById('prop-scale-y'), z: document.getElementById('prop-scale-z') };
const anchoredInput = document.getElementById('prop-anchored');
const collideInput = document.getElementById('prop-collide');
const opacityInput = document.getElementById('prop-opacity');
const explorerMenu = document.getElementById('explorer-menu');

document.getElementById('right-sidebar').addEventListener('mousedown', (e) => e.stopPropagation());

// --- HIERARCHICAL EXPLORER SYSTEM ---
export const explorerHierarchy = {
    items: [],
    expanded: {},
    objectCounter: { 'object': 1, 'folder': 1, 'model': 1 },
    
    getOrCreateWorld() {
        let world = this.items.find(item => item.type === 'folder' && item.name === 'World');
        if (!world) {
            world = { id: 'world-folder', type: 'folder', name: 'World', children: [], isProtected: true };
            this.items.push(world);
            this.expanded['world-folder'] = true;
        }
        return world;
    },
    
    getNextName(type) {
        const names = {
            'object': 'Part',
            'folder': 'Folder',
            'model': 'Model'
        };
        return `${names[type]} ${this.objectCounter[type]++}`;
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

// Initialize World folder on startup
explorerHierarchy.getOrCreateWorld();

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
    
    const isSelected = item.objectRef && state.selectedObjects.includes(item.objectRef);
    if (isSelected) itemEl.classList.add('selected');
    
    // Arrow for folders/models
    if (item.children) {
        const arrow = document.createElement('div');
        arrow.className = 'exp-arrow' + (explorerHierarchy.expanded[item.id] ? ' open' : '');
        arrow.innerText = '▶';
        arrow.onclick = (e) => {
            e.stopPropagation();
            explorerHierarchy.expanded[item.id] = !explorerHierarchy.expanded[item.id];
            updateExplorer(); 
        };
        itemEl.appendChild(arrow);
    }
    
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
        explorerMenu.style.display = 'block';
        
        // Position menu and keep it on screen
        let left = e.pageX;
        let top = e.pageY;
        explorerMenu.style.left = left + 'px';
        explorerMenu.style.top = top + 'px';
        
        // Adjust if off screen
        setTimeout(() => {
            const rect = explorerMenu.getBoundingClientRect();
            if (rect.right > window.innerWidth) {
                explorerMenu.style.left = (window.innerWidth - rect.width - 10) + 'px';
            }
            if (rect.bottom > window.innerHeight) {
                explorerMenu.style.top = (window.innerHeight - rect.height - 10) + 'px';
            }
        }, 0);
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
        
        if (item.type === 'folder' || item.type === 'model') {
            // Select all objects inside this folder/model
            const allObjects = explorerHierarchy.getAllObjectsInItem(item.id);
            if (allObjects.length > 0) {
                clearSelection();
                allObjects.forEach((obj, i) => attachTool(obj, i > 0));
                showInspector();
            }
        } else if (item.objectRef) {
            // For objects, check if they're inside a model - if so, select all in that model
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

export function findItemIdForObject(obj) {
    const search = (items) => {
        for (let item of items) {
            if (item.objectRef === obj) return item.id;
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
        opacityInput.value = obj.userData.opacity !== undefined ? obj.userData.opacity : 1;
        if (obj.material && obj.material.transparent) {
            obj.material.opacity = opacityInput.value;
        }
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
}

nameInput.oninput = () => { if (state.selectedObjects.length === 1) { state.selectedObjects[0].name = nameInput.value; updateExplorer(); } };

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

export function showInspector() {
    if (state.selectedObjects.length > 0) {
        propertyControls.style.display = 'flex'; noSelectionText.style.display = 'none';
        if (state.selectedObjects.length > 1) {
            nameInput.value = "Multiple Objects"; nameInput.disabled = true;
            colorPicker.parentElement.style.opacity = "0.5"; deleteBtn.style.visibility = 'visible';
        } else {
            const target = state.selectedObjects[0];
            nameInput.value = target.name; nameInput.disabled = false;
            colorPicker.value = '#' + target.material.color.getHexString();
            colorPicker.parentElement.style.opacity = "1";
            deleteBtn.style.visibility = (target === baseplate) ? 'hidden' : 'visible';
        }
        // Moved this outside the if/else so it updates fields for BOTH single and multi-select
        updatePropertyValues();
    } else {
        propertyControls.style.display = 'none'; noSelectionText.style.display = 'block';
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
        
    } else if (type === 'Folder') {
        const folderName = explorerHierarchy.getNextName('folder');
        const item = { id: `folder-${Date.now()}-${Math.floor(Math.random() * 1000)}`, type: 'folder', name: folderName, children: [] };
        parent.children.push(item);
        explorerHierarchy.expanded[parentId] = true;
        
    } else if (type === 'Model') {
        const modelName = explorerHierarchy.getNextName('model');
        const item = { id: `model-${Date.now()}-${Math.floor(Math.random() * 1000)}`, type: 'model', name: modelName, children: [] };
        parent.children.push(item);
        explorerHierarchy.expanded[parentId] = true;
    }
    
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

    // Add options for folders/models or background (World)
    if (isContainer) {
        menuItems.push({ type: 'create', label: 'Add Part', objectType: 'Object' });
        menuItems.push({ type: 'create', label: 'Add Folder', objectType: 'Folder' });
        menuItems.push({ type: 'create', label: 'Add Model', objectType: 'Model' });
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
        if (item.label === undefined) return; // Skip dividers
        const deleteStyle = item.isDelete ? 'color: #ff6666;' : '';
        const borderStyle = item.isDelete ? 'border-top: 1px solid #444; margin-top: 5px;' : '';
        menuHtml += `<div class="menu-item" data-menu-index="${index}" style="${deleteStyle} ${borderStyle}">${item.label}</div>`;
    });

    rightClickMenu.innerHTML = menuHtml;

    // Attach event listeners to menu items
    menuItems.forEach((item, index) => {
        if (item.label === undefined) return; // Skip dividers
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
    
    // Keep menu on screen
    setTimeout(() => {
        const rect = rightClickMenu.getBoundingClientRect();
        if (rect.right > window.innerWidth) {
            rightClickMenu.style.left = (window.innerWidth - rect.width - 10) + 'px';
        }
        if (rect.bottom > window.innerHeight) {
            rightClickMenu.style.top = (window.innerHeight - rect.height - 10) + 'px';
        }
    }, 0);
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
        // Targeted a folder/model specifically in explorer
        idsToDelete.add(currentContextId);
    } else if (state.selectedObjects.length > 0) {
        // Delete the active 3D selection
        state.selectedObjects.forEach(obj => {
            const id = findItemIdForObject(obj);
            if (id) idsToDelete.add(id);
        });
    } else if (currentContextId) {
        // Fallback: delete the single item right-clicked
        idsToDelete.add(currentContextId);
    }

    if (idsToDelete.size === 0) return;

    // 2. IMPORTANT: Clear selection state BEFORE removing from scene
    // This detaches objects from the selectionGroup and TransformControls
    clearSelection();

    // 3. Execute deletion
    idsToDelete.forEach(id => {
        const item = explorerHierarchy.findItemById(id);
        if (!item || item.isProtected) return;

        // Recursive cleanup of all 3D objects inside folders/models
        const objects = explorerHierarchy.getAllObjectsInItem(id);
        objects.forEach(obj => {
            if (obj === baseplate) return;
            if (obj.parent) obj.parent.remove(obj);
            const idx = state.selectableObjects.indexOf(obj);
            if (idx > -1) state.selectableObjects.splice(idx, 1);
        });
        explorerHierarchy.removeItem(id);
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
    transformControls.detach(); scaleHandles.visible = false; selectionBox.visible = false;
}

deleteBtn.onclick = () => {
    window.deleteSelected();
};

export function attachTool(obj, isMulti = false) {
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
            scale: obj.scale.clone(),
            rotation: obj.quaternion.clone(), // Use quaternion for accuracy
            userData: JSON.parse(JSON.stringify(obj.userData))
        };
    });
    console.log("Copied", clipboard.length, "objects");
}

// editor.js
export function pasteSelection() {
    if (clipboard.length === 0) return;

    const newClones = [];
    const worldFolder = explorerHierarchy.getOrCreateWorld();
    
    clipboard.forEach(data => {
        const mesh = new THREE.Mesh(data.geometry, data.material.clone());
        const newName = explorerHierarchy.getNextName('object') + ' (Copy)';
        mesh.name = newName;
        mesh.quaternion.copy(data.rotation);
        mesh.scale.copy(data.scale);
        mesh.userData = JSON.parse(JSON.stringify(data.userData));
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        scene.add(mesh);
        state.selectableObjects.push(mesh);
        newClones.push(mesh);
        
        // Add to World folder in hierarchy
        const hierarchyItem = { id: `obj-${Date.now()}-${Math.floor(Math.random() * 1000)}`, type: 'object', name: mesh.name, objectRef: mesh };
        worldFolder.children.push(hierarchyItem);
    });

    if (newClones.length > 0) {
        clearSelection();
        
        // Use attachTool on all objects to build the group and calculate the new center
        newClones.forEach((obj, i) => attachTool(obj, i > 0));

        // Now that the group is centered on the objects, place the group on the surface
        placeOnTargetSurface(selectionGroup);

        // Snap the result
        selectionGroup.position.x = snapValue(selectionGroup.position.x);
        selectionGroup.position.y = snapValue(selectionGroup.position.y);
        selectionGroup.position.z = snapValue(selectionGroup.position.z);
        
        selectionGroup.updateMatrixWorld(true);
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