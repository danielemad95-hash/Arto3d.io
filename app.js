// --- STATE MANAGEMENT ---
let state = {
    materials: [],
    products: [],
    manufacturing: [],
    sales: [],
    firebaseConfig: null,
    dashboardMonth: null // 'YYYY-MM' of the month selected in the Monthly Report card
};

// UI-only filter selections for each section (never persisted, just drives what's rendered)
let filters = {
    materials: { type: 'all', search: '' },
    products: { stock: 'all', material: 'all', search: '', sort: 'code-asc' },
    manufacturing: { status: 'all', product: 'all', month: 'all' },
    sales: { channel: 'all', product: 'all', month: 'all' }
};

// --- BUILT-IN FIREBASE CONFIG ---
// This is hardcoded so every user (you, your father, your brother) connects
// to the same cloud database automatically, with no setup step required.
const DEFAULT_FIREBASE_CONFIG = {
    apiKey: "AIzaSyA-fdRgWEcTBJzUFoKC51gVk2lRsrRWppo",
    authDomain: "dfinaldb.firebaseapp.com",
    projectId: "dfinaldb",
    storageBucket: "dfinaldb.firebasestorage.app",
    messagingSenderId: "655267183238",
    appId: "1:655267183238:web:f09ae088cb9afa3b196f07",
    measurementId: "G-7HCWD3FVK5"
};

// --- AUTHENTICATION ---
// Only these Google accounts may sign in. Add/remove emails as needed.
const ALLOWED_EMAILS = [
    "danielemad95@gmail.com",
    "emadbaki@gmail.com",
    "michael.emadsb@gmail.com"
];

let auth = null;
let currentUser = null;

// --- DATA ACCESS LAYER (LocalStorage & Firebase Firestore Wrapper) ---
let isFirebaseConnected = false;
let db = null;
let firestoreUnsubscribers = [];

// Local Storage Keys
const STORAGE_KEYS = {
    MATERIALS: 'printsync_materials',
    PRODUCTS: 'printsync_products',
    MANUFACTURING: 'printsync_manufacturing',
    SALES: 'printsync_sales',
    FIREBASE_CONFIG: 'printsync_fb_config'
};

// Initialize Application Data (only called after a successful, allowed sign-in)
let appStarted = false;
async function startApp() {
    if (appStarted) return;
    appStarted = true;

    loadLocalSettings();

    // Prefer a config the user manually saved in Settings (if any),
    // otherwise fall back to the built-in default so every device
    // connects to the shared cloud database automatically.
    const configToUse = state.firebaseConfig || DEFAULT_FIREBASE_CONFIG;

    const connected = await connectFirebase(configToUse);
    if (!connected) {
        console.warn("Failed to connect to Firebase. Falling back to Local Storage.");
        loadLocalData();
    }
    
    // Setup UI bindings
    setupNavigation();
    setupModalBindings();
    setupCalculators();
    renderAll();
}

// Load configurations from Local Storage
function loadLocalSettings() {
    try {
        const configStr = localStorage.getItem(STORAGE_KEYS.FIREBASE_CONFIG);
        if (configStr) {
            state.firebaseConfig = JSON.parse(configStr);
        }
    } catch (e) {
        console.error("Error reading Firebase configuration", e);
    }
}

// Load business data from Local Storage (Offline Fallback)
function loadLocalData() {
    try {
        state.materials = JSON.parse(localStorage.getItem(STORAGE_KEYS.MATERIALS)) || [];
        state.products = JSON.parse(localStorage.getItem(STORAGE_KEYS.PRODUCTS)) || [];
        state.manufacturing = JSON.parse(localStorage.getItem(STORAGE_KEYS.MANUFACTURING)) || [];
        state.sales = JSON.parse(localStorage.getItem(STORAGE_KEYS.SALES)) || [];
        
        isFirebaseConnected = false;
        updateSyncStatusUI();
    } catch (e) {
        console.error("Error loading local storage data", e);
    }
}

// Save data locally (Offline Fallback)
function saveLocalData(key, data) {
    if (isFirebaseConnected) return; // DB updates managed by Firebase
    localStorage.setItem(key, JSON.stringify(data));
}

// Connect Firebase and bind live listeners
async function connectFirebase(config) {
    try {
        // Clear any previous listeners
        disconnectFirebase();
        
        // Initialize Firebase
        if (!firebase.apps.length) {
            firebase.initializeApp(config);
        } else {
            firebase.app(); // already initialized
        }
        
        db = firebase.firestore();
        isFirebaseConnected = true;
        
        // Setup Firestore listeners
        setupFirestoreListener('materials', (data) => {
            state.materials = data;
            // When materials load/change, we need to recalculate product costs in case price per gram changed
            recalculateAllProductsCost();
            renderMaterials();
            populateDropdowns();
        });

        setupFirestoreListener('products', (data) => {
            state.products = data;
            renderProducts();
            populateDropdowns();
            renderDashboard();
        });

        setupFirestoreListener('manufacturing', (data) => {
            state.manufacturing = data;
            recalculateProductStocks();
            renderManufacturingLog();
            renderDashboard();
        });

        setupFirestoreListener('sales', (data) => {
            state.sales = data;
            recalculateProductStocks();
            renderSalesLog();
            renderDashboard();
        });
        
        // Update Configuration Textarea in settings UI
        document.getElementById('fb-config-json').value = JSON.stringify(config, null, 2);
        updateSyncStatusUI();
        
        // Check if Firestore collections are empty. If they are, offer to upload local data.
        setTimeout(async () => {
            await maybeBootstrapCloudData();
        }, 1500);
        
        return true;
    } catch (error) {
        console.error("Firebase connection error:", error);
        isFirebaseConnected = false;
        updateSyncStatusUI();
        alert("Could not connect to Firebase: " + error.message);
        return false;
    }
}

// Set up a Firestore listener that automatically updates local state and runs callbacks
function setupFirestoreListener(collectionName, callback) {
    const unsub = db.collection(collectionName).onSnapshot((snapshot) => {
        const items = [];
        snapshot.forEach((doc) => {
            const data = doc.data();
            data.id = doc.id; // Map document ID
            items.push(data);
        });
        callback(items);
    }, (error) => {
        console.error(`Firestore listener error on ${collectionName}:`, error);
    });
    firestoreUnsubscribers.push(unsub);
}

// Disconnect Firebase subscriptions
function disconnectFirebase() {
    firestoreUnsubscribers.forEach(unsub => unsub());
    firestoreUnsubscribers = [];
    isFirebaseConnected = false;
    db = null;
    updateSyncStatusUI();
}

// Check if Cloud is empty. If yes, sync local storage data to the cloud.
async function maybeBootstrapCloudData() {
    if (!isFirebaseConnected || !db) return;
    
    try {
        const materialsSnap = await db.collection('materials').limit(1).get();
        const productsSnap = await db.collection('products').limit(1).get();
        
        if (materialsSnap.empty && productsSnap.empty && 
            (state.materials.length > 0 || state.products.length > 0)) {
            
            const uploadConfirm = confirm("Your cloud database is currently empty, but you have local data on this machine. Would you like to upload your local data to Firebase so other users (father/brother) can see it?");
            if (uploadConfirm) {
                // Upload Materials
                const batch = db.batch();
                state.materials.forEach(mat => {
                    const docRef = db.collection('materials').doc(mat.id || undefined);
                    batch.set(docRef, mat);
                });
                
                // Upload Products
                state.products.forEach(prod => {
                    const docRef = db.collection('products').doc(prod.id || undefined);
                    batch.set(docRef, prod);
                });

                // Upload Manufacturing Run Logs
                state.manufacturing.forEach(mfg => {
                    const docRef = db.collection('manufacturing').doc(mfg.id || undefined);
                    batch.set(docRef, mfg);
                });

                // Upload Sales
                state.sales.forEach(sale => {
                    const docRef = db.collection('sales').doc(sale.id || undefined);
                    batch.set(docRef, sale);
                });

                await batch.commit();
                alert("Database successfully synchronized to the cloud!");
            }
        }
    } catch (e) {
        console.error("Failed to bootstrap cloud data:", e);
    }
}

// Update badges showing connection mode
function updateSyncStatusUI() {
    const badges = document.querySelectorAll('.sync-badge');
    const settingsBadge = document.getElementById('sync-status-indicator');
    const disconnectBtn = document.getElementById('btn-disconnect-firebase');
    
    if (isFirebaseConnected) {
        badges.forEach(b => {
            b.className = "sync-badge cloud";
            b.querySelector('.badge-text').textContent = "Cloud Sync";
        });
        if (settingsBadge) {
            settingsBadge.className = "badge success";
            settingsBadge.textContent = "Cloud Connected";
        }
        if (disconnectBtn) disconnectBtn.style.display = "inline-flex";
    } else {
        badges.forEach(b => {
            b.className = "sync-badge local";
            b.querySelector('.badge-text').textContent = "Offline Mode";
        });
        if (settingsBadge) {
            settingsBadge.className = "badge danger";
            settingsBadge.textContent = "Not Connected";
        }
        if (disconnectBtn) disconnectBtn.style.display = "none";
    }
}

// Generate unique IDs for local records
function generateUUID() {
    return 'id_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now().toString(36);
}

// CRUD Operations wrapper that respects connection mode
async function dbCreate(collectionName, data, localKey) {
    if (isFirebaseConnected && db) {
        // Write to Firestore
        try {
            const docRef = await db.collection(collectionName).add(data);
            return docRef.id;
        } catch (error) {
            console.error(`Firestore write failed on ${collectionName}:`, error);
            alert(`Could not save to the cloud database (${error.code || error.message}). Check your Firestore security rules.`);
            throw error;
        }
    } else {
        // Write locally
        data.id = generateUUID();
        state[localKey].push(data);
        saveLocalData(STORAGE_KEYS[localKey.toUpperCase()], state[localKey]);
        renderAll();
        return data.id;
    }
}

async function dbUpdate(collectionName, id, data, localKey) {
    if (isFirebaseConnected && db) {
        // Update Firestore
        try {
            await db.collection(collectionName).doc(id).update(data);
        } catch (error) {
            console.error(`Firestore update failed on ${collectionName}:`, error);
            alert(`Could not save to the cloud database (${error.code || error.message}). Check your Firestore security rules.`);
            throw error;
        }
    } else {
        // Update locally
        const index = state[localKey].findIndex(item => item.id === id);
        if (index !== -1) {
            state[localKey][index] = { ...state[localKey][index], ...data };
            saveLocalData(STORAGE_KEYS[localKey.toUpperCase()], state[localKey]);
            renderAll();
        }
    }
}

async function dbDelete(collectionName, id, localKey) {
    if (isFirebaseConnected && db) {
        // Delete from Firestore
        try {
            await db.collection(collectionName).doc(id).delete();
        } catch (error) {
            console.error(`Firestore delete failed on ${collectionName}:`, error);
            alert(`Could not delete from the cloud database (${error.code || error.message}). Check your Firestore security rules.`);
            throw error;
        }
    } else {
        // Delete locally
        state[localKey] = state[localKey].filter(item => item.id !== id);
        saveLocalData(STORAGE_KEYS[localKey.toUpperCase()], state[localKey]);
        renderAll();
    }
}


// --- TAB NAVIGATION ---
function setupNavigation() {
    const navItems = document.querySelectorAll('.nav-item, .bottom-nav-item');
    navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            const tabId = item.getAttribute('data-tab');
            switchTab(tabId);
        });
    });

    // Handle initial route if contains hash
    if (window.location.hash) {
        const hash = window.location.hash.substring(1);
        if (['dashboard', 'materials', 'products', 'manufacturing', 'sales', 'settings'].includes(hash)) {
            switchTab(hash);
        }
    }
}

function switchTab(tabId) {
    // Update active class in Navigation
    const navItems = document.querySelectorAll('.nav-item, .bottom-nav-item');
    navItems.forEach(item => {
        if (item.getAttribute('data-tab') === tabId) {
            item.classList.add('active');
        } else {
            item.classList.remove('active');
        }
    });

    // Update Tab View visibility
    const views = document.querySelectorAll('.tab-view');
    views.forEach(view => {
        if (view.id === `${tabId}-view`) {
            view.classList.add('active');
        } else {
            view.classList.remove('active');
        }
    });

    // Update header title
    const titles = {
        dashboard: 'Dashboard',
        materials: 'Materials & Spools',
        products: 'Product Catalog',
        manufacturing: 'Manufacturing Logs',
        sales: 'Sales & Store Tracker',
        settings: 'Configuration & settings'
    };
    document.getElementById('page-title').textContent = titles[tabId] || 'Dashboard';
    
    // Save history hash
    window.location.hash = tabId;
    
    // Re-render target tab to ensure freshness
    if (tabId === 'dashboard') renderDashboard();
    else if (tabId === 'materials') renderMaterials();
    else if (tabId === 'products') renderProducts();
    else if (tabId === 'manufacturing') renderManufacturingLog();
    else if (tabId === 'sales') renderSalesLog();
}


// --- MODAL UTILITIES ---
function openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal) return;
    
    modal.style.display = 'flex';
    
    // Reset forms when opening for new item
    if (modalId === 'material-modal') {
        document.getElementById('material-form').reset();
        document.getElementById('material-id').value = '';
        document.getElementById('material-modal-title').textContent = 'Add Filament Spool';
        document.getElementById('calculated-cost-gram').textContent = '$0.000/g';
    } else if (modalId === 'product-modal') {
        document.getElementById('product-form').reset();
        document.getElementById('product-id').value = '';
        document.getElementById('product-modal-title').textContent = 'Define Product Design';
        populateDropdowns();
        resetFilamentRows();
        calculateProductCostsLive();
    } else if (modalId === 'manufacture-modal') {
        document.getElementById('manufacture-form').reset();
        populateDropdowns();
        document.getElementById('mfg-date').valueAsDate = new Date();
    } else if (modalId === 'sale-modal') {
        document.getElementById('sale-form').reset();
        populateDropdowns();
        document.getElementById('sale-date').valueAsDate = new Date();
        document.getElementById('sale-stock-warning').textContent = '';
    }
}

function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.style.display = 'none';
}

function setupModalBindings() {
    // Close modals on clicking outside the content block
    window.addEventListener('click', (event) => {
        if (event.target.classList.contains('modal')) {
            event.target.style.display = 'none';
        }
    });
}


// --- MATH & COST CALCULATIONS ---
function getMaterialCostPerGram(material) {
    if (!material) return 0;
    const weight = parseFloat(material.weight) || 1000;
    const cost = parseFloat(material.cost) || 0;
    return weight > 0 ? (cost / weight) : 0;
}

// Perform complete manufacturing unit cost math for a product config.
// A product can use more than one filament (multi-color / multi-material prints):
// product.filaments is an array of { materialId, weight } rows. Falls back to the
// legacy single materialId/weight fields for older saved products.
function calculateProductCostMath(product) {
    const filaments = (product.filaments && product.filaments.length > 0)
        ? product.filaments
        : [{ materialId: product.materialId, weight: product.weight }];

    let baseMaterialCost = 0;
    let filamentWeight = 0;
    filaments.forEach(f => {
        const spool = state.materials.find(m => m.id === f.materialId);
        const costPerGram = getMaterialCostPerGram(spool);
        const w = parseFloat(f.weight) || 0;
        baseMaterialCost += w * costPerGram;
        filamentWeight += w;
    });

    const printTime = parseFloat(product.printTime) || 0;
    const failureRate = parseFloat(product.failureRate) || 0;
    const laborTime = parseFloat(product.laborTime) || 0;
    const laborRate = parseFloat(product.laborRate) || 0;
    const electricityRate = parseFloat(product.electricityRate) || 0;
    const hardwareCost = parseFloat(product.hardwareCost) || 0;
    
    // 2. Electricity Cost: flat rate per hour of print time (default $1/hour)
    const baseElectricityCost = printTime * electricityRate;
    
    // 3. Failure cushion: applied to material and power which are wasted in a failure
    const failureMultiplier = failureRate / 100;
    const failureCushionCost = (baseMaterialCost + baseElectricityCost) * failureMultiplier;
    
    // 4. Labor Cost: time * rate
    const baseLaborCost = laborTime * laborRate;
    
    // 5. Total unit mfg cost
    const totalUnitCost = baseMaterialCost + baseElectricityCost + failureCushionCost + baseLaborCost + hardwareCost;
    
    const targetPrice = parseFloat(product.targetPrice) || 0;
    const netProfit = targetPrice - totalUnitCost;
    const profitMarginPercent = targetPrice > 0 ? (netProfit / targetPrice) * 100 : 0;

    return {
        materialCost: baseMaterialCost,
        electricityCost: baseElectricityCost,
        laborCost: baseLaborCost,
        failureCost: failureCushionCost,
        totalCost: totalUnitCost,
        profit: netProfit,
        profitPercent: profitMarginPercent,
        totalWeight: filamentWeight
    };
}


// --- MULTI-FILAMENT PRODUCT ROWS ---
// Each product can be made from more than one filament spool (e.g. a two-tone print).
// These helpers build/manage the repeatable filament rows inside the product form.
let filamentRowSeq = 0;

function populateFilamentSelect(selectEl, selectedId) {
    const prev = selectedId !== undefined ? selectedId : selectEl.value;
    selectEl.innerHTML = '<option value="" disabled selected>Select a material spool</option>';
    state.materials.forEach(mat => {
        const opt = document.createElement('option');
        opt.value = mat.id;
        opt.textContent = `${mat.brand} - ${mat.type} (${mat.color})`;
        selectEl.appendChild(opt);
    });
    if (prev && state.materials.some(m => m.id === prev)) {
        selectEl.value = prev;
    }
}

function addFilamentRow(materialId = '', weight = '') {
    const list = document.getElementById('prod-filaments-list');
    filamentRowSeq++;
    const rowId = `fil-row-${filamentRowSeq}`;

    const row = document.createElement('div');
    row.className = 'filament-row';
    row.dataset.rowId = rowId;
    row.innerHTML = `
        <div class="filament-row-select">
            <select class="filament-material-select" required></select>
        </div>
        <div class="filament-row-weight">
            <input type="number" class="filament-weight-input" min="0.1" step="0.1" placeholder="grams" value="${weight || ''}" required>
        </div>
        <button type="button" class="btn-remove-filament" onclick="removeFilamentRow('${rowId}')" title="Remove this filament">
            <i data-lucide="x"></i>
        </button>
    `;
    list.appendChild(row);

    const selectEl = row.querySelector('.filament-material-select');
    populateFilamentSelect(selectEl, materialId);

    selectEl.addEventListener('change', calculateProductCostsLive);
    row.querySelector('.filament-weight-input').addEventListener('input', calculateProductCostsLive);

    updateRemoveFilamentButtons();
    lucide.createIcons();
    calculateProductCostsLive();
}

function removeFilamentRow(rowId) {
    const list = document.getElementById('prod-filaments-list');
    const row = list.querySelector(`[data-row-id="${rowId}"]`);
    if (row) row.remove();
    updateRemoveFilamentButtons();
    calculateProductCostsLive();
}

// Keep at least one filament row on the form at all times
function updateRemoveFilamentButtons() {
    const list = document.getElementById('prod-filaments-list');
    const rows = list.querySelectorAll('.filament-row');
    rows.forEach(row => {
        row.querySelector('.btn-remove-filament').disabled = rows.length <= 1;
    });
}

// Rebuild the filament rows for a fresh form (new product) or an existing one (edit)
function resetFilamentRows(filaments) {
    const list = document.getElementById('prod-filaments-list');
    list.innerHTML = '';
    if (filaments && filaments.length > 0) {
        filaments.forEach(f => addFilamentRow(f.materialId, f.weight));
    } else {
        addFilamentRow();
    }
}

// Read the current filament rows out of the form
function getFilamentRowsData() {
    const list = document.getElementById('prod-filaments-list');
    return Array.from(list.querySelectorAll('.filament-row')).map(row => ({
        materialId: row.querySelector('.filament-material-select').value,
        weight: parseFloat(row.querySelector('.filament-weight-input').value) || 0
    }));
}

// Setup input listeners to recalculate product costs in real-time as the user types
function setupCalculators() {
    // 1. Material Add Modal live per-gram display
    const matWeightInput = document.getElementById('mat-weight');
    const matCostInput = document.getElementById('mat-cost');
    const matCostDisplay = document.getElementById('calculated-cost-gram');
    
    function updateMaterialGramCostDisplay() {
        const weight = parseFloat(matWeightInput.value) || 0;
        const cost = parseFloat(matCostInput.value) || 0;
        const perGram = weight > 0 ? (cost / weight) : 0;
        matCostDisplay.textContent = `$${perGram.toFixed(3)}/g`;
    }
    matWeightInput.addEventListener('input', updateMaterialGramCostDisplay);
    matCostInput.addEventListener('input', updateMaterialGramCostDisplay);
    
    // 2. Product live cost fields listener
    const productInputs = [
        'prod-target-price', 'prod-print-time', 
        'prod-failure-rate', 'prod-labor-time', 'prod-labor-rate', 
        'prod-electricity-rate', 'prod-hardware-cost'
    ];
    
    productInputs.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('input', calculateProductCostsLive);
            el.addEventListener('change', calculateProductCostsLive);
        }
    });

    // 3. Sales input autocomplete
    const saleProdSelect = document.getElementById('sale-product-id');
    const salePriceInput = document.getElementById('sale-price');
    const saleStockWarn = document.getElementById('sale-stock-warning');
    const saleQtyInput = document.getElementById('sale-qty');
    
    saleProdSelect.addEventListener('change', () => {
        const prodId = saleProdSelect.value;
        const product = state.products.find(p => p.id === prodId);
        if (product) {
            salePriceInput.value = product.targetPrice || 0;
            updateStockWarning();
        }
    });

    function updateStockWarning() {
        const prodId = saleProdSelect.value;
        const product = state.products.find(p => p.id === prodId);
        if (product) {
            const qty = parseInt(saleQtyInput.value) || 1;
            const currentStock = product.stock || 0;
            if (qty > currentStock) {
                saleStockWarn.textContent = `Insufficient stock! Currently in stock: ${currentStock}`;
            } else {
                saleStockWarn.textContent = `In stock: ${currentStock}`;
            }
        }
    }
    saleQtyInput.addEventListener('input', updateStockWarning);
}

function calculateProductCostsLive() {
    const tempProduct = {
        filaments: getFilamentRowsData(),
        printTime: document.getElementById('prod-print-time').value,
        failureRate: document.getElementById('prod-failure-rate').value,
        laborTime: document.getElementById('prod-labor-time').value,
        laborRate: document.getElementById('prod-labor-rate').value,
        electricityRate: document.getElementById('prod-electricity-rate').value,
        hardwareCost: document.getElementById('prod-hardware-cost').value,
        targetPrice: document.getElementById('prod-target-price').value
    };

    const math = calculateProductCostMath(tempProduct);

    // Total filament weight readout
    const totalWeightEl = document.getElementById('prod-total-weight');
    if (totalWeightEl) totalWeightEl.textContent = `${math.totalWeight}g`;

    // Render results in modal Live Box
    document.getElementById('sum-material-cost').textContent = `$${math.materialCost.toFixed(2)}`;
    document.getElementById('sum-electricity-cost').textContent = `$${math.electricityCost.toFixed(2)}`;
    document.getElementById('sum-labor-cost').textContent = `$${math.laborCost.toFixed(2)}`;
    document.getElementById('sum-failure-cost').textContent = `$${math.failureCost.toFixed(2)}`;
    
    const totalCostEl = document.getElementById('sum-total-cost');
    totalCostEl.textContent = `$${math.totalCost.toFixed(2)}`;
    
    const profitEl = document.getElementById('sum-net-profit');
    profitEl.textContent = `$${math.profit.toFixed(2)} (${math.profitPercent.toFixed(1)}%)`;

    // Color code indicators
    if (math.profit < 0) {
        profitEl.style.color = 'var(--danger)';
    } else {
        profitEl.style.color = 'var(--success)';
    }
}

// Recalculates stocks locally for all catalog products based on logged prints and sales
function recalculateProductStocks() {
    state.products.forEach(product => {
        let stock = 0;
        
        // Sum prints that succeeded
        state.manufacturing.forEach(run => {
            if (run.productId === product.id && run.status === 'Success') {
                stock += parseInt(run.qty) || 0;
            }
        });
        
        // Subtract sales
        state.sales.forEach(sale => {
            if (sale.productId === product.id) {
                stock -= parseInt(sale.qty) || 0;
            }
        });
        
        product.stock = stock;
    });
}

// Recalculate costs for all catalog items when spools change
function recalculateAllProductsCost() {
    state.products.forEach(async (product) => {
        const math = calculateProductCostMath(product);
        const unitCost = parseFloat(math.totalCost.toFixed(2));
        const profit = parseFloat(math.profit.toFixed(2));
        const profitPercent = parseFloat(math.profitPercent.toFixed(1));
        
        // If the values changed in memory, update DB
        if (product.unitCost !== unitCost || product.profit !== profit || product.profitPercent !== profitPercent) {
            product.unitCost = unitCost;
            product.profit = profit;
            product.profitPercent = profitPercent;
            await dbUpdate('products', product.id, { unitCost, profit, profitPercent }, 'products');
        }
    });
}


// --- FORM SUBMISSIONS ---

// A. Material Form Save
document.getElementById('material-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const matId = document.getElementById('material-id').value;
    const materialData = {
        brand: document.getElementById('mat-brand').value,
        type: document.getElementById('mat-type').value,
        color: document.getElementById('mat-color').value,
        colorHex: document.getElementById('mat-color-hex').value,
        weight: parseFloat(document.getElementById('mat-weight').value) || 1000,
        cost: parseFloat(document.getElementById('mat-cost').value) || 0
    };

    try {
        if (matId) {
            await dbUpdate('materials', matId, materialData, 'materials');
        } else {
            await dbCreate('materials', materialData, 'materials');
        }
        closeModal('material-modal');
    } catch (err) {
        console.error("Save material failed:", err);
    }
});

// B. Product Form Save
document.getElementById('product-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const prodId = document.getElementById('product-id').value;
    const prodCode = document.getElementById('prod-code').value.trim().toUpperCase();
    
    // Validate uniqueness of Product Code
    const isDuplicate = state.products.some(p => p.code === prodCode && p.id !== prodId);
    if (isDuplicate) {
        alert(`Duplicate product code: [${prodCode}] is already used by another product design. Please enter a unique product code.`);
        return;
    }

    // Gather every filament row (a product can be made of more than one spool/color)
    const filaments = getFilamentRowsData();
    const hasInvalidRow = filaments.length === 0 || filaments.some(f => !f.materialId || f.weight <= 0);
    if (hasInvalidRow) {
        alert("Please select a material spool and enter a weight (in grams) for every filament row.");
        return;
    }

    const productInput = {
        code: prodCode,
        name: document.getElementById('prod-name').value,
        targetPrice: parseFloat(document.getElementById('prod-target-price').value) || 0,
        desc: document.getElementById('prod-desc').value,
        filaments: filaments,
        // Kept for backward compatibility with older records/views: primary spool + total weight
        materialId: filaments[0].materialId,
        weight: filaments.reduce((sum, f) => sum + f.weight, 0),
        printTime: parseFloat(document.getElementById('prod-print-time').value) || 0,
        failureRate: parseFloat(document.getElementById('prod-failure-rate').value) || 0,
        laborTime: parseFloat(document.getElementById('prod-labor-time').value) || 0,
        laborRate: parseFloat(document.getElementById('prod-labor-rate').value) || 0,
        electricityRate: parseFloat(document.getElementById('prod-electricity-rate').value) || 0,
        hardwareCost: parseFloat(document.getElementById('prod-hardware-cost').value) || 0
    };

    // Calculate final metrics for storage
    const math = calculateProductCostMath(productInput);
    productInput.unitCost = parseFloat(math.totalCost.toFixed(2));
    productInput.profit = parseFloat(math.profit.toFixed(2));
    productInput.profitPercent = parseFloat(math.profitPercent.toFixed(1));
    productInput.stock = 0; // calculated dynamically but setup base

    try {
        if (prodId) {
            await dbUpdate('products', prodId, productInput, 'products');
        } else {
            await dbCreate('products', productInput, 'products');
        }
        closeModal('product-modal');
    } catch (err) {
        console.error("Save product failed:", err);
    }
});

// C. Log Print Run Save
document.getElementById('manufacture-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const prodId = document.getElementById('mfg-product-id').value;
    const qty = parseInt(document.getElementById('mfg-qty').value) || 1;
    const status = document.getElementById('mfg-status').value;
    const date = document.getElementById('mfg-date').value;
    const notes = document.getElementById('mfg-notes').value;

    const product = state.products.find(p => p.id === prodId);
    if (!product) return;

    // Calculate wasted or utilized material cost for this print run (sums across all filaments used)
    const math = calculateProductCostMath(product);
    const printCostPerUnit = math.materialCost + math.electricityCost;
    const totalRunCost = parseFloat((printCostPerUnit * qty).toFixed(2));

    const runData = {
        productId: prodId,
        productCode: product.code || '',
        productName: product.name,
        qty: qty,
        status: status,
        date: date,
        notes: notes,
        materialCost: totalRunCost
    };

    try {
        await dbCreate('manufacturing', runData, 'manufacturing');
        closeModal('manufacture-modal');
    } catch (err) {
        console.error("Save print log failed:", err);
    }
});

// D. Log Sale Save
document.getElementById('sale-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const prodId = document.getElementById('sale-product-id').value;
    const qty = parseInt(document.getElementById('sale-qty').value) || 1;
    const actualPrice = parseFloat(document.getElementById('sale-price').value) || 0;
    const date = document.getElementById('sale-date').value;
    const channel = document.getElementById('sale-channel').value;

    const product = state.products.find(p => p.id === prodId);
    if (!product) return;

    // Revenue & profit calculation for this transaction
    const totalRevenue = parseFloat((actualPrice * qty).toFixed(2));
    const totalUnitCost = parseFloat((product.unitCost || 0) * qty);
    const totalProfit = parseFloat((totalRevenue - totalUnitCost).toFixed(2));

    const saleData = {
        productId: prodId,
        productCode: product.code || '',
        productName: product.name,
        qty: qty,
        price: actualPrice,
        totalRevenue: totalRevenue,
        totalProfit: totalProfit,
        date: date,
        channel: channel
    };

    try {
        await dbCreate('sales', saleData, 'sales');
        closeModal('sale-modal');
    } catch (err) {
        console.error("Save sale failed:", err);
    }
});

// E. Settings Form Save (Firebase connection)
document.getElementById('firebase-config-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const configStr = document.getElementById('fb-config-json').value.trim();
    if (!configStr) {
        alert("Please paste a valid Firebase configuration JSON.");
        return;
    }

    try {
        const config = JSON.parse(configStr);
        if (!config.apiKey || !config.projectId) {
            throw new Error("Missing required Firebase fields (apiKey, projectId).");
        }
        
        // Save config
        state.firebaseConfig = config;
        localStorage.setItem(STORAGE_KEYS.FIREBASE_CONFIG, JSON.stringify(config));
        
        // Connect
        const connected = await connectFirebase(config);
        if (connected) {
            alert("Firebase configured and synced successfully!");
            switchTab('dashboard');
        }
    } catch (err) {
        alert("Invalid Firebase Config JSON format: " + err.message);
    }
});

// Settings disconnect button
document.getElementById('btn-disconnect-firebase').addEventListener('click', () => {
    if (confirm("Are you sure you want to disconnect from Firebase cloud sync? The app will revert back to offline Local Storage database mode.")) {
        disconnectFirebase();
        state.firebaseConfig = null;
        localStorage.removeItem(STORAGE_KEYS.FIREBASE_CONFIG);
        document.getElementById('fb-config-json').value = '';
        loadLocalData();
        renderAll();
        alert("Disconnected from cloud sync. Now in local storage mode.");
    }
});


// --- DROPDOWN POPULATOR ---
function populateDropdowns() {
    // 1. Product configuration spool dropdowns (one per filament row already on the form)
    document.querySelectorAll('.filament-material-select').forEach(sel => {
        populateFilamentSelect(sel);
    });

    // 2. Manufacturing run product selection
    const mfgSelect = document.getElementById('mfg-product-id');
    mfgSelect.innerHTML = '<option value="" disabled selected>Select a product to print</option>';
    state.products.forEach(prod => {
        const opt = document.createElement('option');
        opt.value = prod.id;
        opt.textContent = `[${prod.code || 'N/A'}] ${prod.name}`;
        mfgSelect.appendChild(opt);
    });

    // 3. Sales transaction product selection
    const saleSelect = document.getElementById('sale-product-id');
    saleSelect.innerHTML = '<option value="" disabled selected>Select product sold</option>';
    state.products.forEach(prod => {
        const opt = document.createElement('option');
        opt.value = prod.id;
        opt.textContent = `[${prod.code || 'N/A'}] ${prod.name} (Stock: ${prod.stock || 0})`;
        saleSelect.appendChild(opt);
    });
}


// --- EDIT / DELETE FUNCTIONS ---

// Materials
function editMaterial(id) {
    const mat = state.materials.find(m => m.id === id);
    if (!mat) return;
    
    openModal('material-modal');
    document.getElementById('material-modal-title').textContent = 'Edit Filament Spool';
    document.getElementById('material-id').value = mat.id;
    document.getElementById('mat-brand').value = mat.brand;
    document.getElementById('mat-type').value = mat.type;
    document.getElementById('mat-color').value = mat.color;
    document.getElementById('mat-color-hex').value = mat.colorHex;
    document.getElementById('mat-weight').value = mat.weight;
    document.getElementById('mat-cost').value = mat.cost;
    
    // Trigger live preview
    const perGram = mat.weight > 0 ? (mat.cost / mat.weight) : 0;
    document.getElementById('calculated-cost-gram').textContent = `$${perGram.toFixed(3)}/g`;
}

async function deleteMaterial(id) {
    if (confirm("Are you sure you want to delete this filament spool? Products using this spool will display cost errors until updated.")) {
        try {
            await dbDelete('materials', id, 'materials');
        } catch (err) {
            console.error("Delete material failed:", err);
        }
    }
}

// Products
function editProduct(id) {
    const prod = state.products.find(p => p.id === id);
    if (!prod) return;
    
    openModal('product-modal');
    document.getElementById('product-modal-title').textContent = 'Edit Product Config';
    document.getElementById('product-id').value = prod.id;
    document.getElementById('prod-code').value = prod.code || '';
    document.getElementById('prod-name').value = prod.name;
    document.getElementById('prod-target-price').value = prod.targetPrice;
    document.getElementById('prod-desc').value = prod.desc || '';
    
    // Set filament selections (falls back to legacy single materialId/weight if no filaments array saved)
    const filaments = (prod.filaments && prod.filaments.length > 0)
        ? prod.filaments
        : [{ materialId: prod.materialId, weight: prod.weight }];
    resetFilamentRows(filaments);
    
    document.getElementById('prod-print-time').value = prod.printTime;
    document.getElementById('prod-failure-rate').value = prod.failureRate !== undefined ? prod.failureRate : 0;
    document.getElementById('prod-labor-time').value = prod.laborTime !== undefined ? prod.laborTime : 0.2;
    document.getElementById('prod-labor-rate').value = prod.laborRate !== undefined ? prod.laborRate : 5.00;
    document.getElementById('prod-electricity-rate').value = prod.electricityRate !== undefined ? prod.electricityRate : 1.00;
    document.getElementById('prod-hardware-cost').value = prod.hardwareCost !== undefined ? prod.hardwareCost : 0.00;

    calculateProductCostsLive();
}

async function deleteProduct(id) {
    if (confirm("Are you sure you want to delete this product? All historical print logs and sales records for this product will remain, but the item will be removed from catalog listings.")) {
        try {
            await dbDelete('products', id, 'products');
        } catch (err) {
            console.error("Delete product failed:", err);
        }
    }
}

// logs
async function deleteManufactureLog(id) {
    if (confirm("Delete this print log? This will adjust current stock counts accordingly.")) {
        try {
            await dbDelete('manufacturing', id, 'manufacturing');
        } catch (err) {
            console.error("Delete print log failed:", err);
        }
    }
}

async function deleteSaleLog(id) {
    if (confirm("Delete this sale record? This will adjust current stock counts and revenue back.")) {
        try {
            await dbDelete('sales', id, 'sales');
        } catch (err) {
            console.error("Delete sale log failed:", err);
        }
    }
}


// --- RENDERING VIEWS ---

function renderAll() {
    recalculateProductStocks();
    renderDashboard();
    renderMaterials();
    renderProducts();
    renderManufacturingLog();
    renderSalesLog();
    lucide.createIcons();
}

// 1. DASHBOARD VIEW RENDERER
function renderDashboard() {
    // Calculate KPIs
    let totalRevenue = 0;
    let totalRevenueProfit = 0;
    let salesCount = 0;
    
    state.sales.forEach(s => {
        totalRevenue += parseFloat(s.totalRevenue) || 0;
        totalRevenueProfit += parseFloat(s.totalProfit) || 0;
        salesCount += parseInt(s.qty) || 0;
    });

    let totalMfgCost = 0;
    // Costs consist of the print run material cost and electricity cost logged
    state.manufacturing.forEach(m => {
        totalMfgCost += parseFloat(m.materialCost) || 0; // This stores total run cost
    });
    
    // Net profit = actual sales revenue - manufacturing costs of EVERYTHING printed (including failures)
    // Profit margin = (Net Profit / Revenue) * 100
    const netProfit = totalRevenue - totalMfgCost;
    const margin = totalRevenue > 0 ? (netProfit / totalRevenue) * 100 : 0;
    
    let activeStockCount = 0;
    state.products.forEach(p => {
        activeStockCount += p.stock || 0;
    });

    // Populate UI KPI Cards
    document.getElementById('kpi-revenue').textContent = `$${totalRevenue.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
    document.getElementById('kpi-sales-count').textContent = `${salesCount} items sold`;
    
    document.getElementById('kpi-cost').textContent = `$${totalMfgCost.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
    
    const profitEl = document.getElementById('kpi-profit');
    profitEl.textContent = `$${netProfit.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
    if (netProfit < 0) {
        profitEl.style.color = 'var(--danger)';
    } else {
        profitEl.style.color = 'var(--success)';
    }
    
    document.getElementById('kpi-profit-margin').textContent = `${margin.toFixed(1)}% profit margin`;
    
    document.getElementById('kpi-stock').textContent = activeStockCount;
    document.getElementById('kpi-items-types').textContent = `${state.products.length} catalog designs`;

    // Render Alerts / Low Stock Warnings
    renderInventoryAlerts();

    // Render Mini Lists
    renderDashboardRecentLists();

    // Render Chart
    renderFinancialChart();

    // Render Monthly Report (sales/profit/what-sold for the selected month)
    renderMonthlyReport();
}

function renderInventoryAlerts() {
    const listEl = document.getElementById('low-stock-list');
    const warningBadge = document.getElementById('low-stock-count');
    
    let warnings = 0;
    let html = '';

    state.products.forEach(prod => {
        const stock = prod.stock || 0;
        if (stock <= 2) {
            warnings++;
            const isCritical = stock === 0;
            const statusClass = isCritical ? 'critical' : '';
            const statusText = isCritical ? 'OUT OF STOCK' : `${stock} items remaining`;
            const icon = isCritical ? 'alert-triangle' : 'alert-circle';
            
            html += `
                <div class="alert-item ${statusClass}">
                    <i data-lucide="${icon}" class="alert-icon"></i>
                    <div class="alert-details">
                        <div class="alert-title">${prod.name}</div>
                        <div class="alert-desc">${statusText}</div>
                    </div>
                    <span class="badge ${isCritical ? 'danger' : 'warning'}">${stock} in stock</span>
                </div>
            `;
        }
    });

    warningBadge.textContent = `${warnings} alerts`;
    warningBadge.className = warnings > 0 ? 'badge warning' : 'badge success';

    if (warnings === 0) {
        listEl.innerHTML = `
            <div class="empty-state">
                <i data-lucide="check-circle" class="success-icon"></i>
                <p>All stock levels healthy!</p>
            </div>
        `;
    } else {
        listEl.innerHTML = html;
        lucide.createIcons();
    }
}

function renderDashboardRecentLists() {
    const recentMfgEl = document.getElementById('mini-manufactured-list');
    const recentSalesEl = document.getElementById('mini-sales-list');

    // Recent Manufacturing prints (last 5 sorted by date)
    const recentPrints = [...state.manufacturing]
        .sort((a, b) => new Date(b.date) - new Date(a.date))
        .slice(0, 5);

    if (recentPrints.length === 0) {
        recentMfgEl.innerHTML = '<div class="empty-state">No prints logged yet.</div>';
    } else {
        recentMfgEl.innerHTML = recentPrints.map(p => {
            const isSuccess = p.status === 'Success';
            return `
                <div class="mini-list-item">
                    <div class="mini-item-left">
                        <i data-lucide="${isSuccess ? 'check-circle' : 'x-circle'}" class="${isSuccess ? 'color-success' : 'color-danger'}"></i>
                        <div>
                            <div class="mini-item-title">${p.productName}</div>
                            <div class="mini-item-subtitle">${p.date} &bull; Qty: ${p.qty}</div>
                        </div>
                    </div>
                    <div class="mini-item-right danger">-$${parseFloat(p.materialCost || 0).toFixed(2)}</div>
                </div>
            `;
        }).join('');
    }

    // Recent Sales (last 5 sorted by date)
    const recentSales = [...state.sales]
        .sort((a, b) => new Date(b.date) - new Date(a.date))
        .slice(0, 5);

    if (recentSales.length === 0) {
        recentSalesEl.innerHTML = '<div class="empty-state">No sales logged yet.</div>';
    } else {
        recentSalesEl.innerHTML = recentSales.map(s => {
            return `
                <div class="mini-list-item">
                    <div class="mini-item-left">
                        <i data-lucide="arrow-up-right" class="color-success"></i>
                        <div>
                            <div class="mini-item-title">${s.productName}</div>
                            <div class="mini-item-subtitle">${s.date} &bull; Qty: ${s.qty} via ${s.channel || 'Store'}</div>
                        </div>
                    </div>
                    <div class="mini-item-right success">+$${parseFloat(s.totalRevenue || 0).toFixed(2)}</div>
                </div>
            `;
        }).join('');
    }
}

// --- FILTER BAR HELPERS (shared by Materials / Products / Manufacturing / Sales) ---

// Rebuilds a <select>'s options from [{value, label}], keeping the current selection if still valid
function populateSelectPreserving(selectEl, options, currentValue) {
    if (!selectEl) return;
    const validValues = options.map(o => o.value);
    const value = validValues.includes(currentValue) ? currentValue : options[0].value;
    selectEl.innerHTML = options.map(o =>
        `<option value="${o.value}" ${o.value === value ? 'selected' : ''}>${o.label}</option>`
    ).join('');
    return value;
}

// Distinct 'YYYY-MM' keys present in a list of records with a .date field, newest first
function getMonthKeysFromRecords(records) {
    const keys = new Set();
    records.forEach(r => {
        const k = getMonthKey(r.date);
        if (k) keys.add(k);
    });
    return Array.from(keys).sort().reverse();
}

// --- MONTHLY REPORT (Dashboard month filter) ---

// Extracts 'YYYY-MM' from a date string like '2026-07-13'
function getMonthKey(dateStr) {
    return dateStr ? dateStr.slice(0, 7) : null;
}

// Turns 'YYYY-MM' into a readable label like 'July 2026'
function formatMonthLabel(key) {
    const [year, month] = key.split('-').map(Number);
    const d = new Date(year, month - 1, 1);
    return d.toLocaleString('default', { month: 'long', year: 'numeric' });
}

// Collects every month that has sales or manufacturing activity, plus the current month
function getAvailableMonthKeys() {
    const keys = new Set();
    const now = new Date();
    keys.add(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`);

    state.sales.forEach(s => {
        const k = getMonthKey(s.date);
        if (k) keys.add(k);
    });
    state.manufacturing.forEach(m => {
        const k = getMonthKey(m.date);
        if (k) keys.add(k);
    });

    return Array.from(keys).sort().reverse(); // newest first
}

// (Re)builds the month dropdown, preserving the current selection if still valid
function populateMonthSelect() {
    const select = document.getElementById('dashboard-month-select');
    if (!select) return;

    const months = getAvailableMonthKeys();
    if (!state.dashboardMonth || !months.includes(state.dashboardMonth)) {
        state.dashboardMonth = months[0];
    }

    select.innerHTML = months.map(key =>
        `<option value="${key}" ${key === state.dashboardMonth ? 'selected' : ''}>${formatMonthLabel(key)}</option>`
    ).join('');
}

// Called from the month <select> onchange handler in index.html
function changeDashboardMonth(value) {
    state.dashboardMonth = value;
    renderMonthlyReport();
}

// Filters sales & manufacturing to the selected month, updates the mini KPIs,
// and renders the "What Sold This Month" product breakdown table
function renderMonthlyReport() {
    populateMonthSelect();
    const monthKey = state.dashboardMonth;

    const monthSales = state.sales.filter(s => getMonthKey(s.date) === monthKey);

    let revenue = 0;
    let cost = 0; // cost of goods actually SOLD this month (not everything printed this month)
    let profit = 0;
    let itemsSold = 0;
    const productBreakdown = {}; // productId (or name) -> { name, code, qty, revenue, profit }

    monthSales.forEach(s => {
        const rev = parseFloat(s.totalRevenue) || 0;
        const prof = parseFloat(s.totalProfit) || 0;
        const qty = parseInt(s.qty) || 0;
        const unitCost = rev - prof; // the manufacturing cost baked into this specific sale

        revenue += rev;
        cost += unitCost;
        profit += prof;
        itemsSold += qty;

        const key = s.productId || s.productName || 'unknown';
        if (!productBreakdown[key]) {
            productBreakdown[key] = {
                name: s.productName || 'Deleted Product',
                code: s.productCode || '',
                qty: 0,
                revenue: 0,
                profit: 0
            };
        }
        productBreakdown[key].qty += qty;
        productBreakdown[key].revenue += rev;
        productBreakdown[key].profit += prof;
    });

    const netProfit = revenue - cost;
    const margin = revenue > 0 ? (netProfit / revenue) * 100 : 0;

    // Update mini KPI cells
    document.getElementById('month-kpi-revenue').textContent = `$${revenue.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
    document.getElementById('month-kpi-cost').textContent = `$${cost.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;

    const profitEl = document.getElementById('month-kpi-profit');
    profitEl.textContent = `$${netProfit.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
    profitEl.style.color = netProfit < 0 ? 'var(--danger)' : 'var(--success)';

    document.getElementById('month-kpi-margin').textContent = `${margin.toFixed(1)}% margin`;
    document.getElementById('month-kpi-items').textContent = itemsSold;

    // "What Sold This Month" table, sorted by revenue descending
    const body = document.getElementById('monthly-sales-body');
    const rows = Object.values(productBreakdown).sort((a, b) => b.revenue - a.revenue);

    if (rows.length === 0) {
        body.innerHTML = `
            <tr>
                <td colspan="4" class="table-empty">No sales logged for this month.</td>
            </tr>
        `;
        return;
    }

    body.innerHTML = rows.map(r => {
        const isProfit = r.profit >= 0;
        const profitClass = isProfit ? 'color-success' : 'text-warning';
        return `
            <tr>
                <td style="font-weight: 700;">
                    ${r.code ? `<span style="font-size: 11px; font-family: monospace; color: var(--primary); display: block;">${r.code}</span>` : ''}
                    ${r.name}
                </td>
                <td>${r.qty}</td>
                <td>$${r.revenue.toFixed(2)}</td>
                <td class="${profitClass}">$${r.profit.toFixed(2)}</td>
            </tr>
        `;
    }).join('');
}

// Generate double-bar SVG graph representing Revenue vs. Cost of last 6 months
function renderFinancialChart() {
    const svg = document.getElementById('financial-chart');
    if (!svg) return;
    
    // Clear dynamic content
    svg.innerHTML = '';

    // 1. Get last 6 months names and keys
    const months = [];
    const now = new Date();
    for (let i = 5; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        months.push({
            name: d.toLocaleString('default', { month: 'short' }),
            year: d.getFullYear(),
            monthNum: d.getMonth(),
            key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` // YYYY-MM
        });
    }

    // 2. Aggregate Revenue and Cost
    const aggregates = months.map(m => {
        let revenue = 0;
        let cost = 0;

        state.sales.forEach(s => {
            if (s.date && s.date.startsWith(m.key)) {
                revenue += parseFloat(s.totalRevenue) || 0;
            }
        });

        state.manufacturing.forEach(man => {
            if (man.date && man.date.startsWith(m.key)) {
                cost += parseFloat(man.materialCost) || 0;
            }
        });

        return { ...m, revenue, cost };
    });

    // 3. Find max scale
    let maxVal = 100; // minimum scale
    aggregates.forEach(a => {
        if (a.revenue > maxVal) maxVal = a.revenue;
        if (a.cost > maxVal) maxVal = a.cost;
    });
    maxVal = Math.ceil(maxVal * 1.15); // Add 15% cushion

    // 4. Define SVG components
    const padding = { top: 20, right: 20, bottom: 30, left: 45 };
    const chartHeight = 220;
    const chartWidth = 500;
    const graphHeight = chartHeight - padding.top - padding.bottom;
    const graphWidth = chartWidth - padding.left - padding.right;

    // Linear mapping
    const getX = (index) => padding.left + (index * (graphWidth / months.length));
    const getY = (value) => padding.top + graphHeight - (value / maxVal * graphHeight);

    // Create Gradient Grids
    let definitions = `
        <defs>
            <linearGradient id="rev-grad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="var(--primary)" />
                <stop offset="100%" stop-color="rgba(168, 85, 247, 0.2)" />
            </linearGradient>
            <linearGradient id="cost-grad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="var(--warning)" />
                <stop offset="100%" stop-color="rgba(245, 158, 11, 0.2)" />
            </linearGradient>
        </defs>
    `;
    svg.innerHTML += definitions;

    // Y Axis grid lines (4 intervals)
    for (let i = 0; i <= 4; i++) {
        const v = (maxVal / 4) * i;
        const y = getY(v);
        svg.innerHTML += `
            <line class="chart-grid-line" x1="${padding.left}" y1="${y}" x2="${chartWidth - padding.right}" y2="${y}"></line>
            <text class="chart-label" x="${padding.left - 10}" y="${y + 3}" text-anchor="end">$${Math.round(v)}</text>
        `;
    }

    // Render Bars & Labels
    const colWidth = graphWidth / months.length;
    const barWidth = colWidth * 0.3; // width of individual bars
    const barGap = 4; // gap between rev & cost bar

    aggregates.forEach((a, i) => {
        const xCenter = getX(i) + (colWidth / 2);
        
        // Revenue Bar
        const revHeight = (a.revenue / maxVal) * graphHeight;
        const revX = xCenter - barWidth - (barGap / 2);
        const revY = getY(a.revenue);
        if (revHeight > 0) {
            svg.innerHTML += `
                <rect class="chart-bar-rev" x="${revX}" y="${revY}" width="${barWidth}" height="${revHeight}">
                    <title>${a.name} Revenue: $${a.revenue.toFixed(2)}</title>
                </rect>
            `;
        }

        // Cost Bar
        const costHeight = (a.cost / maxVal) * graphHeight;
        const costX = xCenter + (barGap / 2);
        const costY = getY(a.cost);
        if (costHeight > 0) {
            svg.innerHTML += `
                <rect class="chart-bar-cost" x="${costX}" y="${costY}" width="${barWidth}" height="${costHeight}">
                    <title>${a.name} Cost: $${a.cost.toFixed(2)}</title>
                </rect>
            `;
        }

        // Month Labels
        svg.innerHTML += `
            <text class="chart-label" x="${xCenter}" y="${chartHeight - 10}" text-anchor="middle">${a.name}</text>
        `;
    });

    // Baseline axis line
    svg.innerHTML += `
        <line class="chart-axis-line" x1="${padding.left}" y1="${chartHeight - padding.bottom}" x2="${chartWidth - padding.right}" y2="${chartHeight - padding.bottom}"></line>
    `;
}

// 2. MATERIALS VIEW RENDERER
function renderMaterials() {
    const listEl = document.getElementById('materials-list');
    
    if (state.materials.length === 0) {
        listEl.innerHTML = `
            <div class="empty-state">
                <i data-lucide="layers" class="empty-icon"></i>
                <p>No materials added yet. Add your first spool to begin calculating print costs.</p>
                <button class="btn btn-secondary mt-3" onclick="openModal('material-modal')">Add Material</button>
            </div>
        `;
        return;
    }

    const filtered = state.materials.filter(mat => {
        if (filters.materials.type !== 'all' && mat.type !== filters.materials.type) return false;
        if (filters.materials.search) {
            const q = filters.materials.search.toLowerCase();
            const haystack = `${mat.brand || ''} ${mat.color || ''}`.toLowerCase();
            if (!haystack.includes(q)) return false;
        }
        return true;
    });

    if (filtered.length === 0) {
        listEl.innerHTML = `
            <div class="empty-state">
                <i data-lucide="search-x" class="empty-icon"></i>
                <p>No materials match your filters.</p>
            </div>
        `;
        lucide.createIcons();
        return;
    }

    listEl.innerHTML = filtered.map(mat => {
        const perGram = getMaterialCostPerGram(mat);
        return `
            <div class="material-card">
                <div class="card-top">
                    <span class="card-tag">${mat.type}</span>
                    <div class="card-title">${mat.brand}</div>
                    <div class="card-subtitle">
                        <div class="color-badge">
                            <span class="color-dot" style="background-color: ${mat.colorHex || '#a855f7'}; --primary-glow: rgba(${hexToRgb(mat.colorHex || '#a855f7')}, 0.35);"></span>
                            <span>${mat.color}</span>
                        </div>
                    </div>
                    <div class="card-actions-dropdown">
                        <button class="btn-card-action" onclick="editMaterial('${mat.id}')"><i data-lucide="edit-3"></i></button>
                        <button class="btn-card-action" onclick="deleteMaterial('${mat.id}')"><i data-lucide="trash-2"></i></button>
                    </div>
                </div>
                <div class="card-specs">
                    <div class="spec-row">
                        <span class="spec-label">Weight:</span>
                        <span class="spec-val">${mat.weight}g</span>
                    </div>
                    <div class="spec-row">
                        <span class="spec-label">Purchase Price:</span>
                        <span class="spec-val">$${parseFloat(mat.cost).toFixed(2)}</span>
                    </div>
                </div>
                <div class="card-bottom">
                    <div class="price-box">
                        <span class="price-label">Cost per Gram:</span>
                        <span class="price-val">$${perGram.toFixed(3)}/g</span>
                    </div>
                </div>
            </div>
        `;
    }).join('');
    lucide.createIcons();
}

function hexToRgb(hex) {
    // simple helper to convert hex to rgb for glow variables
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? `${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}` : '168, 85, 247';
}

// 3. PRODUCTS VIEW RENDERER
function renderProducts() {
    const listEl = document.getElementById('products-list');

    // Keep the Material filter options in sync with materials actually in use
    const materialFilterEl = document.getElementById('products-filter-material');
    if (materialFilterEl) {
        const types = Array.from(new Set(state.materials.map(m => m.type).filter(Boolean))).sort();
        const options = [{ value: 'all', label: 'All Materials' }, ...types.map(t => ({ value: t, label: t }))];
        filters.products.material = populateSelectPreserving(materialFilterEl, options, filters.products.material);
    }
    
    if (state.products.length === 0) {
        listEl.innerHTML = `
            <div class="empty-state">
                <i data-lucide="package" class="empty-icon"></i>
                <p>No products in your catalog yet. Create a product and configure its manufacturing metrics.</p>
                <button class="btn btn-secondary mt-3" onclick="openModal('product-modal')">Add Product</button>
            </div>
        `;
        return;
    }

    const filtered = state.products.filter(prod => {
        const stock = prod.stock || 0;
        let stockCategory = 'in-stock';
        if (stock === 0) stockCategory = 'out-of-stock';
        else if (stock <= 2) stockCategory = 'low-stock';

        if (filters.products.stock !== 'all' && filters.products.stock !== stockCategory) return false;

        if (filters.products.material !== 'all') {
            const filaments = (prod.filaments && prod.filaments.length > 0)
                ? prod.filaments
                : [{ materialId: prod.materialId }];
            const usesMaterial = filaments.some(f => {
                const spool = state.materials.find(m => m.id === f.materialId);
                return spool && spool.type === filters.products.material;
            });
            if (!usesMaterial) return false;
        }

        if (filters.products.search) {
            const q = filters.products.search.toLowerCase();
            const haystack = `${prod.name || ''} ${prod.code || ''}`.toLowerCase();
            if (!haystack.includes(q)) return false;
        }

        return true;
    });

    if (filtered.length === 0) {
        listEl.innerHTML = `
            <div class="empty-state">
                <i data-lucide="search-x" class="empty-icon"></i>
                <p>No products match your filters.</p>
            </div>
        `;
        lucide.createIcons();
        return;
    }

    const sortMode = filters.products.sort || 'code-asc';
    const sorted = [...filtered];
    if (sortMode === 'code-asc' || sortMode === 'code-desc') {
        sorted.sort((a, b) => {
            const codeA = (a.code || '').toString();
            const codeB = (b.code || '').toString();
            const cmp = codeA.localeCompare(codeB, undefined, { numeric: true, sensitivity: 'base' });
            return sortMode === 'code-asc' ? cmp : -cmp;
        });
    }

    listEl.innerHTML = sorted.map(prod => {
        const filaments = (prod.filaments && prod.filaments.length > 0)
            ? prod.filaments
            : [{ materialId: prod.materialId, weight: prod.weight }];
        const spools = filaments.map(f => state.materials.find(m => m.id === f.materialId));

        const colorBadgesHtml = spools.length > 0
            ? spools.map(spool => `
                <div class="color-badge">
                    <span class="color-dot" style="background-color: ${spool ? (spool.colorHex || '#94a3b8') : '#94a3b8'};"></span>
                    <span>${spool ? spool.color : 'N/A'}${spools.length === 1 ? ` (${spool ? spool.type : 'N/A'})` : ''}</span>
                </div>
              `).join('')
            : `<div class="color-badge"><span class="color-dot" style="background-color: #94a3b8;"></span><span>N/A</span></div>`;

        // Stock Badge Class
        const stock = prod.stock || 0;
        let stockClass = 'in-stock';
        let stockText = `${stock} in stock`;
        if (stock === 0) {
            stockClass = 'out-of-stock';
            stockText = 'Out of Stock';
        } else if (stock <= 2) {
            stockClass = 'low-stock';
            stockText = `${stock} remaining`;
        }

        return `
            <div class="product-card">
                <div class="card-top">
                    <span class="stock-badge ${stockClass}">${stockText}</span>
                    <div class="card-title" style="margin-top: 12px;">
                        <span style="font-size: 11px; font-weight: 800; color: var(--primary); display: block; letter-spacing: 0.5px;">${prod.code || 'N/A'}</span>
                        ${prod.name}
                    </div>
                    <div class="card-subtitle multi-filament-badges">
                        ${colorBadgesHtml}
                    </div>
                    <div class="card-actions-dropdown">
                        <button class="btn-card-action" onclick="editProduct('${prod.id}')"><i data-lucide="edit-3"></i></button>
                        <button class="btn-card-action" onclick="deleteProduct('${prod.id}')"><i data-lucide="trash-2"></i></button>
                    </div>
                </div>
                <div class="card-specs">
                    <div class="spec-row">
                        <span class="spec-label">Print Time:</span>
                        <span class="spec-val">${prod.printTime} hrs</span>
                    </div>
                    <div class="spec-row">
                        <span class="spec-label">Filament Wt:</span>
                        <span class="spec-val">${prod.weight}g${filaments.length > 1 ? ` (${filaments.length} filaments)` : ''}</span>
                    </div>
                    <div class="spec-row">
                        <span class="spec-label">Production Cost:</span>
                        <span class="spec-val">$${parseFloat(prod.unitCost || 0).toFixed(2)}</span>
                    </div>
                    <div class="spec-row">
                        <span class="spec-label">Profit per Sale:</span>
                        <span class="spec-val ${parseFloat(prod.profit) < 0 ? 'text-warning' : 'color-success'}">$${parseFloat(prod.profit || 0).toFixed(2)} (${prod.profitPercent || 0}%)</span>
                    </div>
                </div>
                <div class="card-bottom">
                    <div class="price-box">
                        <span class="price-label">Retail Price:</span>
                        <span class="price-val success">$${parseFloat(prod.targetPrice).toFixed(2)}</span>
                    </div>
                </div>
            </div>
        `;
    }).join('');
    lucide.createIcons();
}

// 4. MANUFACTURING LOG VIEW RENDERER
function renderManufacturingLog() {
    const body = document.getElementById('manufacture-log-body');

    // Keep Product & Month filter options in sync with what's actually in the log
    const productFilterEl = document.getElementById('mfg-filter-product');
    if (productFilterEl) {
        const productMap = new Map();
        state.manufacturing.forEach(log => {
            const key = log.productId || log.productName || 'unknown';
            if (!productMap.has(key)) productMap.set(key, log.productName || 'Deleted Product');
        });
        const options = [{ value: 'all', label: 'All Products' }, ...Array.from(productMap.entries()).map(([value, label]) => ({ value, label }))];
        filters.manufacturing.product = populateSelectPreserving(productFilterEl, options, filters.manufacturing.product);
    }

    const monthFilterEl = document.getElementById('mfg-filter-month');
    if (monthFilterEl) {
        const months = getMonthKeysFromRecords(state.manufacturing);
        const options = [{ value: 'all', label: 'All Time' }, ...months.map(k => ({ value: k, label: formatMonthLabel(k) }))];
        filters.manufacturing.month = populateSelectPreserving(monthFilterEl, options, filters.manufacturing.month);
    }
    
    if (state.manufacturing.length === 0) {
        body.innerHTML = `
            <tr>
                <td colspan="8" class="table-empty">No print logs available. Start printing!</td>
            </tr>
        `;
        return;
    }

    // Apply filters, then sort logs descending (latest prints first)
    const filtered = state.manufacturing.filter(log => {
        if (filters.manufacturing.status !== 'all' && log.status !== filters.manufacturing.status) return false;
        if (filters.manufacturing.product !== 'all') {
            const key = log.productId || log.productName || 'unknown';
            if (key !== filters.manufacturing.product) return false;
        }
        if (filters.manufacturing.month !== 'all' && getMonthKey(log.date) !== filters.manufacturing.month) return false;
        return true;
    });

    if (filtered.length === 0) {
        body.innerHTML = `
            <tr>
                <td colspan="8" class="table-empty">No print logs match your filters.</td>
            </tr>
        `;
        return;
    }

    const sorted = [...filtered].sort((a, b) => new Date(b.date) - new Date(a.date));

    body.innerHTML = sorted.map(log => {
        const isSuccess = log.status === 'Success';
        const statusBadge = isSuccess ? 
            '<span class="badge success">Success</span>' : 
            '<span class="badge danger">Failed</span>';
            
        const product = state.products.find(p => p.id === log.productId);
        const weightWasted = product ? (parseFloat(product.weight) * log.qty) : 0;
        const displayCode = log.productCode || (product ? product.code : 'N/A');

        return `
            <tr>
                <td>${log.date}</td>
                <td style="font-weight: 700;">
                    <span style="font-size: 11px; font-family: monospace; color: var(--primary); display: block;">${displayCode}</span>
                    ${log.productName || 'Deleted Product'}
                </td>
                <td>${log.qty}</td>
                <td>${statusBadge}</td>
                <td>${weightWasted}g</td>
                <td>$${parseFloat(log.materialCost || 0).toFixed(2)}</td>
                <td class="text-secondary" style="max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${log.notes || '-'}</td>
                <td>
                    <button class="btn-card-action" onclick="deleteManufactureLog('${log.id}')"><i data-lucide="trash-2"></i></button>
                </td>
            </tr>
        `;
    }).join('');
    lucide.createIcons();
}

// 5. SALES VIEW RENDERER
function renderSalesLog() {
    const body = document.getElementById('sales-log-body');

    // Keep Channel, Product & Month filter options in sync with what's actually logged
    const channelFilterEl = document.getElementById('sales-filter-channel');
    if (channelFilterEl) {
        const channels = Array.from(new Set(state.sales.map(s => s.channel || 'Store').filter(Boolean))).sort();
        const options = [{ value: 'all', label: 'All Channels' }, ...channels.map(c => ({ value: c, label: c }))];
        filters.sales.channel = populateSelectPreserving(channelFilterEl, options, filters.sales.channel);
    }

    const productFilterEl = document.getElementById('sales-filter-product');
    if (productFilterEl) {
        const productMap = new Map();
        state.sales.forEach(s => {
            const key = s.productId || s.productName || 'unknown';
            if (!productMap.has(key)) productMap.set(key, s.productName || 'Deleted Product');
        });
        const options = [{ value: 'all', label: 'All Products' }, ...Array.from(productMap.entries()).map(([value, label]) => ({ value, label }))];
        filters.sales.product = populateSelectPreserving(productFilterEl, options, filters.sales.product);
    }

    const monthFilterEl = document.getElementById('sales-filter-month');
    if (monthFilterEl) {
        const months = getMonthKeysFromRecords(state.sales);
        const options = [{ value: 'all', label: 'All Time' }, ...months.map(k => ({ value: k, label: formatMonthLabel(k) }))];
        filters.sales.month = populateSelectPreserving(monthFilterEl, options, filters.sales.month);
    }
    
    if (state.sales.length === 0) {
        body.innerHTML = `
            <tr>
                <td colspan="8" class="table-empty">No sales logged yet. Start selling!</td>
            </tr>
        `;
        return;
    }

    // Apply filters, then sort sales descending (latest sales first)
    const filtered = state.sales.filter(s => {
        if (filters.sales.channel !== 'all' && (s.channel || 'Store') !== filters.sales.channel) return false;
        if (filters.sales.product !== 'all') {
            const key = s.productId || s.productName || 'unknown';
            if (key !== filters.sales.product) return false;
        }
        if (filters.sales.month !== 'all' && getMonthKey(s.date) !== filters.sales.month) return false;
        return true;
    });

    if (filtered.length === 0) {
        body.innerHTML = `
            <tr>
                <td colspan="8" class="table-empty">No sales match your filters.</td>
            </tr>
        `;
        return;
    }

    const sorted = [...filtered].sort((a, b) => new Date(b.date) - new Date(a.date));

    body.innerHTML = sorted.map(s => {
        const isProfit = parseFloat(s.totalProfit) >= 0;
        const profitClass = isProfit ? 'color-success' : 'text-warning';
        
        const product = state.products.find(p => p.id === s.productId);
        const displayCode = s.productCode || (product ? product.code : 'N/A');

        return `
            <tr>
                <td>${s.date}</td>
                <td style="font-weight: 700;">
                    <span style="font-size: 11px; font-family: monospace; color: var(--primary); display: block;">${displayCode}</span>
                    ${s.productName || 'Deleted Product'}
                </td>
                <td>${s.qty}</td>
                <td>$${parseFloat(s.price).toFixed(2)}</td>
                <td>$${parseFloat(s.totalRevenue || 0).toFixed(2)}</td>
                <td class="${profitClass}">$${parseFloat(s.totalProfit || 0).toFixed(2)}</td>
                <td class="text-secondary">${s.channel || 'Store'}</td>
                <td>
                    <button class="btn-card-action" onclick="deleteSaleLog('${s.id}')"><i data-lucide="trash-2"></i></button>
                </td>
            </tr>
        `;
    }).join('');
    lucide.createIcons();
}


// --- DATA PORTABILITY & DATA BACKUPS ---

// A. JSON Export
function exportData() {
    const backup = {
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        materials: state.materials,
        products: state.products,
        manufacturing: state.manufacturing,
        sales: state.sales
    };

    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(backup, null, 2));
    const downloadAnchor = document.createElement('a');
    
    const dateStr = new Date().toISOString().split('T')[0];
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `printsync_backup_${dateStr}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
}

// B. JSON Import
function importData(event) {
    const fileReader = new FileReader();
    const file = event.target.files[0];
    if (!file) return;

    fileReader.onload = async function(e) {
        try {
            const data = JSON.parse(e.target.result);
            
            // Basic structures check
            if (!data.materials || !data.products || !data.manufacturing || !data.sales) {
                throw new Error("Invalid backup file structure. Missing fields.");
            }

            const confirmOverride = confirm(`Upload backup file from ${data.timestamp || 'unknown date'}? This will overwrite ALL current products, spools, logs, and sales.`);
            if (!confirmOverride) return;

            if (isFirebaseConnected && db) {
                // If cloud connected, wipe and upload in batches
                const batch = db.batch();
                
                // Clear existing cloud database first
                const matRefs = await db.collection('materials').get();
                matRefs.forEach(doc => batch.delete(doc.ref));
                
                const prodRefs = await db.collection('products').get();
                prodRefs.forEach(doc => batch.delete(doc.ref));

                const mfgRefs = await db.collection('manufacturing').get();
                mfgRefs.forEach(doc => batch.delete(doc.ref));

                const salesRefs = await db.collection('sales').get();
                salesRefs.forEach(doc => batch.delete(doc.ref));

                // Add backup data
                data.materials.forEach(m => batch.set(db.collection('materials').doc(m.id || undefined), m));
                data.products.forEach(p => batch.set(db.collection('products').doc(p.id || undefined), p));
                data.manufacturing.forEach(man => batch.set(db.collection('manufacturing').doc(man.id || undefined), man));
                data.sales.forEach(s => batch.set(db.collection('sales').doc(s.id || undefined), s));

                await batch.commit();
                alert("Backup restored to cloud database successfully!");
            } else {
                // Local Storage overwrite
                state.materials = data.materials;
                state.products = data.products;
                state.manufacturing = data.manufacturing;
                state.sales = data.sales;

                saveLocalData(STORAGE_KEYS.MATERIALS, state.materials);
                saveLocalData(STORAGE_KEYS.PRODUCTS, state.products);
                saveLocalData(STORAGE_KEYS.MANUFACTURING, state.manufacturing);
                saveLocalData(STORAGE_KEYS.SALES, state.sales);

                renderAll();
                alert("Local backup restored successfully!");
            }
        } catch (error) {
            alert("Failed to import data: " + error.message);
        }
    };
    fileReader.readAsText(file);
}

// C. Reset database
async function confirmResetAll() {
    const confirmation = confirm("CRITICAL WARNING: This will permanently delete all materials, products, print logs, and sales from the database. This action is irreversible. Do you wish to proceed?");
    if (confirmation) {
        try {
            if (isFirebaseConnected && db) {
                const batch = db.batch();
                const matRefs = await db.collection('materials').get();
                matRefs.forEach(doc => batch.delete(doc.ref));
                const prodRefs = await db.collection('products').get();
                prodRefs.forEach(doc => batch.delete(doc.ref));
                const mfgRefs = await db.collection('manufacturing').get();
                mfgRefs.forEach(doc => batch.delete(doc.ref));
                const salesRefs = await db.collection('sales').get();
                salesRefs.forEach(doc => batch.delete(doc.ref));
                await batch.commit();
            } else {
                localStorage.removeItem(STORAGE_KEYS.MATERIALS);
                localStorage.removeItem(STORAGE_KEYS.PRODUCTS);
                localStorage.removeItem(STORAGE_KEYS.MANUFACTURING);
                localStorage.removeItem(STORAGE_KEYS.SALES);
                loadLocalData();
            }
            renderAll();
            alert("Database successfully wiped.");
        } catch (err) {
            console.error("Wipe failed:", err);
            alert("Wipe failed: " + err.message);
        }
    }
}


// --- AUTHENTICATION FLOW ---
function initAuth() {
    // Firebase App must be initialized before Auth can be used.
    // We use the same config as Firestore so there's only one Firebase project.
    if (!firebase.apps.length) {
        firebase.initializeApp(DEFAULT_FIREBASE_CONFIG);
    }

    auth = firebase.auth();
    const provider = new firebase.auth.GoogleAuthProvider();

    const loginScreen = document.getElementById('login-screen');
    const appContainer = document.getElementById('app-container');
    const loginBtn = document.getElementById('login-btn');
    const logoutBtn = document.getElementById('logout-btn');
    const loginError = document.getElementById('login-error');
    const userEmailEl = document.getElementById('current-user-email');

    loginBtn.addEventListener('click', () => {
        loginError.textContent = '';
        auth.signInWithPopup(provider).catch((error) => {
            console.error('Sign-in error:', error);
            loginError.textContent = 'Sign-in failed: ' + error.message;
        });
    });

    logoutBtn.addEventListener('click', () => {
        auth.signOut();
    });

    auth.onAuthStateChanged((user) => {
        if (user && ALLOWED_EMAILS.includes(user.email)) {
            // Approved user
            currentUser = user;
            loginScreen.style.display = 'none';
            appContainer.style.display = '';
            userEmailEl.textContent = user.email;
            startApp();
            if (typeof lucide !== 'undefined') lucide.createIcons();
        } else if (user) {
            // Signed in with Google, but not on the allowlist
            loginError.textContent = `${user.email} is not authorized to use this app.`;
            auth.signOut();
        } else {
            // Signed out / not yet signed in
            currentUser = null;
            loginScreen.style.display = 'flex';
            appContainer.style.display = 'none';
            if (typeof lucide !== 'undefined') lucide.createIcons();
        }
    });
}

// --- START APPLICATION ---
window.addEventListener('DOMContentLoaded', () => {
    initAuth();
});
