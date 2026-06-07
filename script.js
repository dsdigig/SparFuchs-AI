document.addEventListener("DOMContentLoaded", () => {

    console.log('Script loaded successfully');

    // Init code
    // (تم حذف منطق Supabase بالكامل بعد التحويل لـ IndexedDB + localStorage fallback)


    // ======================= Storage Integration (IndexedDB + Fallback localStorage) =======================

    function normalizeId(v) {
        return String(v);
    }

    // IMPORTANT:
    // - IndexedDB is primary.
    // - On any IndexedDB failure, the code falls back to localStorage.
    // - localStorage is only used as a recovery path (hybrid strategy).

    const STORAGE_KEYS = {
        // NOTE: keep existing keys for lock/theme/lang.
        invoices: "spar_invoices_v2",
        lockedMonths: "spar_locked_months_v2",
        theme: "spar_theme_v2",
        lang: "spar_lang_v2",
        // Hybrid storage requested by task.
        // IndexedDB primary, localStorage as fallback.
        invoices_data: "invoices_data"

    };

    // Standard item categories (used for select dropdowns)
    const ITEM_CATEGORIES = ['مواد غذائية','إلكترونيات','وقود','مطاعم','مشروبات','خضروات وفواكه','منظفات','مستحضرات','أخرى'];


    // ------- localStorage helpers (used as fallback/recovery) -------
    function loadInvoicesFromLocalStorage() {
        // Primary key requested by the task:
        const raw = localStorage.getItem(STORAGE_KEYS.invoices_data);
        if (raw) {
            const parsed = safeParseJSON(STORAGE_KEYS.invoices_data, []);
            return Array.isArray(parsed) ? parsed : [];
        }

        // Backward compatible: keep using old app key if present.
        const legacy = safeParseJSON(STORAGE_KEYS.invoices, []);
        return Array.isArray(legacy) ? legacy : [];
    }

    function persistInvoicesToLocalStorage(invoices) {
        try {
            localStorage.setItem(STORAGE_KEYS.invoices_data, JSON.stringify(invoices));
        } catch (e) {
            console.error("persistInvoicesToLocalStorage error:", e);
        }
    }

    // ------- IndexedDB layer (scoped to this DOMContentLoaded) -------
    const IDB = {
        dbName: "sparfuchs_invoices_db",
        dbVersion: 1,
        storeName: "bills"
    };

    let idbDbPromise = null;

    function openIdb() {
        if (idbDbPromise) return idbDbPromise;

        idbDbPromise = new Promise((resolve, reject) => {
            if (!('indexedDB' in window)) {
                reject(new Error('IndexedDB not supported in this browser'));
                return;
            }

            const request = indexedDB.open(IDB.dbName, IDB.dbVersion);

            request.onupgradeneeded = () => {
                try {
                    const db = request.result;
                    if (!db.objectStoreNames.contains(IDB.storeName)) {
                        const store = db.createObjectStore(IDB.storeName, { keyPath: 'id' });
                        // Query support by monthBucket (optional but useful)
                        store.createIndex('monthBucket', 'monthBucket', { unique: false });
                        store.createIndex('date', 'date', { unique: false });
                    }
                } catch (e) {
                    console.error('IndexedDB onupgradeneeded error:', e);
                    // Let reject happen via request.onerror
                }
            };

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('Failed to open IndexedDB'));
            request.onblocked = () => reject(new Error('IndexedDB open blocked'));
        });

        return idbDbPromise;
    }

    // initDB
    // - يفتح قاعدة IndexedDB (مع إنشاء الـ objectStore عند الحاجة).
    // - Rollback: أي فشل لا يوقف التطبيق (يتم fallback إلى localStorage داخل loadInvoices()).

    // Note: openIdb() موجود بالفعل فوق.

    // initDB: loadInvoices
    // - loadInvoices() هو المصدر الأساسي للقراءة بعد اكتمال init.
    // - Rollback strategy: لو حدث أي خطأ (open/transaction/getAll)، يتم الرجوع إلى localStorage.
    // loadInvoices
    // - يقرأ السجلات من IndexedDB (Primary).
    // - إذا كانت IndexedDB غير متاحة/فشلت/أعادت خطأ => fallback إلى localStorage.
    // - لا يرمي أخطاء للأعلى: في كل الحالات يرجع Array.
    async function loadInvoices() {
        try {
            const db = await openIdb();

            return await new Promise((resolve) => {

                const tx = db.transaction(IDB.storeName, 'readonly');
                const store = tx.objectStore(IDB.storeName);
                const req = store.getAll();

                req.onsuccess = () => {
                    const result = Array.isArray(req.result) ? req.result : [];
                    resolve(result);
                };
                req.onerror = () => {
                    console.error('IndexedDB loadInvoices getAll error:', req.error);
                    resolve(loadInvoicesFromLocalStorage());
                };

                tx.onabort = () => {
                    console.error('IndexedDB loadInvoices transaction aborted:', tx.error);
                    resolve(loadInvoicesFromLocalStorage());
                };
            });
        } catch (e) {
            console.error('IndexedDB loadInvoices failed, fallback to localStorage:', e);
            return loadInvoicesFromLocalStorage();
        }
    }

    // saveInvoice
    // - يقوم بإدراج/تحديث فاتورة داخل IndexedDB (Primary).
    // - Rollback: عند أي فشل في IndexedDB، يتم الحفظ في localStorage (hybrid).
    // - لا يرمي أخطاء للأعلى حتى لا يتعطل الـ UI.
    async function saveInvoice(invoice) {

        try {
            const db = await openIdb();
            await new Promise((resolve, reject) => {
                const tx = db.transaction(IDB.storeName, 'readwrite');
                const store = tx.objectStore(IDB.storeName);

                // Put will insert/update by keyPath (id).
                const req = store.put(invoice);

                req.onsuccess = () => resolve();
                req.onerror = () => reject(req.error || new Error('IndexedDB put failed'));

                tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
            });
        } catch (e) {
            console.error('IndexedDB saveInvoice failed, fallback to localStorage:', e);

            // Fallback persistence in localStorage.
            try {
                const current = loadInvoicesFromLocalStorage();
                const id = normalizeId(invoice.id);
                const idx = current.findIndex(x => normalizeId(x.id) === id);
                if (idx >= 0) current[idx] = invoice;
                else current.push(invoice);
                persistInvoicesToLocalStorage(current);
            } catch (lsErr) {
                console.error('localStorage fallback saveInvoice also failed:', lsErr);
            }
        }
    }

    // deleteInvoiceById
    // - يحذف فاتورة من IndexedDB (Primary).
    // - Rollback: عند فشل IndexedDB => يحذف من localStorage.
    // - لا يرمي أخطاء للأعلى.
    async function deleteInvoiceById(invId) {
        try {

            const db = await openIdb();
            await new Promise((resolve, reject) => {
                const tx = db.transaction(IDB.storeName, 'readwrite');
                const store = tx.objectStore(IDB.storeName);
                const req = store.delete(invId);

                req.onsuccess = () => resolve();
                req.onerror = () => reject(req.error || new Error('IndexedDB delete failed'));
                tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
            });
        } catch (e) {
            console.error('IndexedDB deleteInvoiceById failed, fallback to localStorage:', e);
            try {
                const current = loadInvoicesFromLocalStorage();
                const id = normalizeId(invId);
                const next = current.filter(x => normalizeId(x.id) !== id);
                persistInvoicesToLocalStorage(next);
            } catch (lsErr) {
                console.error('localStorage fallback deleteInvoiceById also failed:', lsErr);
            }
        }
    }

    // ===========================================================================


    const selectors = {
        navItems: document.querySelectorAll(".bottom-nav .nav-item"),
        screens: document.querySelectorAll(".screen"),
        cameraOverlay: document.getElementById("screen-camera-view"),
        cameraVideo: document.getElementById("camera-video"),
        cameraCanvas: document.getElementById("camera-canvas"),
        captureCameraBtn: document.getElementById("capture-camera-btn"),
        triggerOcrBtn: document.getElementById("trigger-ocr-btn"),
        closeCameraBtn: document.getElementById("close-camera-btn"),
        tableBody: document.getElementById("table-body"),
        mainBalance: document.getElementById("main-balance"),
        mainFooterCount: document.getElementById("main-footer-count"),
        dashboardTotalCount: document.getElementById("dashboard-total-count"),
        dashboardEmptyState: document.getElementById("dashboard-empty-state"),
        recentReceiptsList: document.getElementById("recent-receipts-list"),
        tableMonthTitle: document.getElementById("table-month-title"),
        dashboardMonthLabel: document.getElementById("dashboard-month-label"),
        tableLockBadge: document.getElementById("table-lock-badge"),
        invoiceModal: document.getElementById("invoice-modal"),
        closeInvoiceModalBtn: document.getElementById("close-modal-btn"),
        invoiceForm: document.getElementById("invoice-form"),
        fastManualBtn: document.getElementById("fast-manual-btn"),
        modalTitle: document.getElementById("modal-title"),
        formInvoiceId: document.getElementById("edit-invoice-id"),
        formName: document.getElementById("form-name"),
        formAmount: document.getElementById("form-amount"),
        formCurrency: document.getElementById("form-currency"),
        formCategory: document.getElementById("form-category"),
        formDate: document.getElementById("form-date"),
        simulateMonthChangeBtn: document.getElementById("simulate-month-change-btn"),
        downloadPdfBtn: document.getElementById("download-pdf-btn"),
        scanInvoiceBtn: document.getElementById("scan-invoice-btn"),
        scanInvoiceFileInput: document.getElementById("scan-invoice-file-input"),
        exportDataBtn: document.getElementById("export-data-btn"),
        importDataBtn: document.getElementById("import-data-btn"),
        importDataInput: document.getElementById("import-data-input"),
        pasteTextBtn: document.getElementById("paste-text-btn"),
        textModal: document.getElementById("text-modal"),
        rawInvoiceText: document.getElementById("raw-invoice-text"),
        parseTextBtn: document.getElementById("parse-text-btn"),
        jsonOutput: document.getElementById("json-output"),
        copyJsonBtn: document.getElementById("copy-json-btn"),
        closeTextModalBtn: document.getElementById("close-text-modal"),
        themeToggle: document.getElementById("theme-toggle"),

        langRadios: document.querySelectorAll('input[name="language"]'),
        clearDataBtn: document.getElementById("clear-data-btn")
    };

    // Helper: convert File/Blob -> Base64 (returns base64 string without data: prefix)
    function fileToBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(new Error('FileReader failed'));
            reader.onload = () => {
                const result = reader.result || '';
                // result is like 'data:image/jpeg;base64,/9j/4AAQ...'
                const parts = String(result).split(',');
                resolve(parts[1] || '');
            };
            reader.readAsDataURL(file);
        });
    }

        // Dynamic invoice items rendering
        function clearInvoiceItems() {
            const region = document.getElementById('invoice-items-region');
            const tbody = document.getElementById('invoice-items-tbody');
            const totalEl = document.getElementById('invoice-items-total');
            if (tbody) tbody.innerHTML = '';
            if (totalEl) totalEl.textContent = '';
            if (region) region.style.display = 'none';
        }

        function renderInvoiceItems(items) {
            const region = document.getElementById('invoice-items-region');
            const tbody = document.getElementById('invoice-items-tbody');
            const totalEl = document.getElementById('invoice-items-total');
            if (!items || !items.length) {
                clearInvoiceItems();
                return;
            }
            if (tbody) {
                tbody.innerHTML = '';
                items.forEach(it => {
                    const tr = document.createElement('tr');
                    const nameTd = document.createElement('td');
                    const qtyTd = document.createElement('td');
                    const unitTd = document.createElement('td');
                    const totalTd = document.createElement('td');
                    const catTd = document.createElement('td');

                    nameTd.style.padding = '8px'; nameTd.style.textAlign = 'right';
                    qtyTd.style.padding = '8px'; qtyTd.style.textAlign = 'center';
                    unitTd.style.padding = '8px'; unitTd.style.textAlign = 'center';
                    totalTd.style.padding = '8px'; totalTd.style.textAlign = 'left';
                    catTd.style.padding = '8px'; catTd.style.textAlign = 'center';

                    // support multiple shapes from AI or parsers
                    const name = it.name || it.item || '';
                    const quantity = (typeof it.quantity !== 'undefined') ? it.quantity : (typeof it.qty !== 'undefined' ? it.qty : '');
                    const unit_price = (typeof it.unit_price !== 'undefined') ? it.unit_price : (typeof it.unit !== 'undefined' ? it.unit : (typeof it.unitPrice !== 'undefined' ? it.unitPrice : ''));
                    const total_price = (typeof it.total_price !== 'undefined') ? it.total_price : (typeof it.total !== 'undefined' ? it.total : (typeof it.totalPrice !== 'undefined' ? it.totalPrice : ''));
                    const category = it.category || it.cat || inferCategory(name) || '';

                    nameTd.textContent = name;
                    qtyTd.textContent = (quantity !== null && typeof quantity !== 'undefined') ? String(quantity) : '';
                    unitTd.textContent = (unit_price !== null && typeof unit_price !== 'undefined' && unit_price !== '') ? Number(unit_price).toFixed(2) : '';
                    totalTd.textContent = (total_price !== null && typeof total_price !== 'undefined' && total_price !== '') ? Number(total_price).toFixed(2) : '';

                    // category input with datalist (combobox) to allow typing or picking
                    const catInput = document.createElement('input');
                    catInput.type = 'text';
                    catInput.setAttribute('list', 'category-datalist');
                    catInput.style.padding = '6px 8px';
                    catInput.style.borderRadius = '6px';
                    catInput.style.border = '1px solid rgba(0,0,0,0.06)';
                    catInput.style.background = 'transparent';
                    catInput.style.minWidth = '110px';
                    catInput.value = category || ITEM_CATEGORIES[ITEM_CATEGORIES.length-1];
                    catTd.appendChild(catInput);
                    catTd.title = 'اختر أو اكتب تصنيفاً جديداً';

                    tr.appendChild(nameTd);
                    tr.appendChild(qtyTd);
                    tr.appendChild(unitTd);
                    tr.appendChild(totalTd);
                    tr.appendChild(catTd);
                    tbody.appendChild(tr);
                });
            }
            if (totalEl) {
                // compute sum if not provided
                const sum = items.reduce((s,it) => s + (Number(it.total_price) || Number(it.total) || 0), 0);
                totalEl.textContent = 'المجموع: ' + sum.toFixed(2);
            }
            if (region) region.style.display = '';
        }

    // Render the scanned result into the main UI card (not the modal)
    function renderScannedResult(data) {
        try {
            const card = document.getElementById('scanned-result-card');
            const storeEl = document.getElementById('scanned-store');
            const metaEl = document.getElementById('scanned-meta');
            const tbody = document.getElementById('scanned-items-tbody');
            const totalEl = document.getElementById('scanned-total');
            if (!card || !tbody) return;

            // Basic fields
            storeEl.textContent = data.bill_name || (data.name || '---');
            metaEl.textContent = (data.date ? data.date + ' · ' : '') + (data.currency ? data.currency : '');

            // Populate items table
            tbody.innerHTML = '';
            if (Array.isArray(data.items) && data.items.length) {
                data.items.forEach(it => {
                    const tr = document.createElement('tr');
                        const tdName = document.createElement('td');
                    const tdQty = document.createElement('td');
                    const tdUnit = document.createElement('td');
                    const tdTotal = document.createElement('td');
                    const tdCat = document.createElement('td');

                    tdName.textContent = it.name || '';
                    tdQty.textContent = (typeof it.quantity !== 'undefined' && it.quantity !== null) ? String(it.quantity) : '';
                    tdUnit.textContent = (typeof it.unit_price !== 'undefined' && it.unit_price !== null) ? Number(it.unit_price).toFixed(2) : '';
                    tdTotal.textContent = (typeof it.total_price !== 'undefined' && it.total_price !== null) ? Number(it.total_price).toFixed(2) : '';
                    tdCat.textContent = it.category || inferCategory(it.name || '');

                    tdName.style.padding = '10px'; tdName.style.textAlign = 'right';
                    tdQty.style.padding = '10px'; tdQty.style.textAlign = 'center';
                    tdUnit.style.padding = '10px'; tdUnit.style.textAlign = 'center';
                    tdTotal.style.padding = '10px'; tdTotal.style.textAlign = 'left';
                    tdCat.style.padding = '10px'; tdCat.style.textAlign = 'center';

                    tr.appendChild(tdName);
                    tr.appendChild(tdQty);
                    tr.appendChild(tdUnit);
                    tr.appendChild(tdTotal);
                    tr.appendChild(tdCat);
                    tbody.appendChild(tr);
                });
            } else {
                const tr = document.createElement('tr');
                const td = document.createElement('td');
                td.setAttribute('colspan', '4');
                td.style.textAlign = 'center'; td.style.padding = '12px'; td.style.color = 'var(--text-muted)';
                td.textContent = 'لم يتم التعرف على بنود مخصّصة.';
                tr.appendChild(td);
                tbody.appendChild(tr);
            }

            // total
            const sum = Array.isArray(data.items) ? data.items.reduce((s,it) => s + (Number(it.total_price) || 0), 0) : (Number(data.total_amount) || 0);
            if (totalEl) totalEl.textContent = 'المجموع: ' + Number(sum).toFixed(2) + ' ' + (data.currency || '');

            card.hidden = false;

            // hide handler
            const hideBtn = document.getElementById('hide-scanned-result');
            if (hideBtn) hideBtn.addEventListener('click', () => { card.hidden = true; });

        } catch (e) { console.warn('renderScannedResult error', e); }
    }

    // When user picks/captures an image via native input, convert immediately to Base64
    if (selectors.scanInvoiceFileInput) {
        selectors.scanInvoiceFileInput.addEventListener('change', async (ev) => {
            const input = ev.target;
            if (!input || !input.files || !input.files.length) return;
            const file = input.files[0];
            try {
                const base64 = await fileToBase64(file);
                // attach base64 string to file object for downstream use (and call OCR)
                file.base64 = base64;
                // processInvoice expects a File/Blob — keep existing OCR pipeline
                await processInvoice(file);
                // Optionally: you may send `base64` to your AI server here.
            } catch (err) {
                console.error('Failed to convert captured image to Base64:', err);
            } finally {
                // reset value so same file can be selected again
                try { input.value = ''; } catch {}
            }
        });
    }

    // additional controls (search / filters) - may be null on first load
    selectors.tableSearch = document.getElementById('table-search');
    selectors.filterMonth = document.getElementById('filter-month');
    selectors.filterCurrency = document.getElementById('filter-currency');

    // Hook empty-state add button to existing manual add action (UI-only)
    (function hookEmptyAddBtn(){
        const emptyBtn = document.getElementById('empty-add-btn');
        if (!emptyBtn) return;
        emptyBtn.addEventListener('click', (e) => {
            e.preventDefault();
            // prefer manual add (fastManualBtn) then OCR
            if (selectors.fastManualBtn && typeof selectors.fastManualBtn.click === 'function') selectors.fastManualBtn.click();
            else if (selectors.triggerOcrBtn && typeof selectors.triggerOcrBtn.click === 'function') selectors.triggerOcrBtn.click();
        });
    })();

        // ------------------ Stats population (uses existing invoicesDatabase) ------------------
        let _statsChart = null;
        function populateStats() {
            const data = Array.isArray(invoicesDatabase) ? invoicesDatabase.slice() : [];
            const totalCount = data.length;
            const totalUSD = data.filter(i=>i.currency==='$').reduce((s,i)=>s+i.amount,0);
            const totalSYP = data.filter(i=>i.currency==='ل.س').reduce((s,i)=>s+i.amount,0);

            // busiest month (by count)
            const monthMap = {};
            data.forEach(i=>{ monthMap[i.monthBucket] = (monthMap[i.monthBucket]||0)+1; });
            const busiest = Object.keys(monthMap).sort((a,b)=>monthMap[b]-monthMap[a])[0] || '-';

            // top currency
            const currencyMap = {};
            data.forEach(i=>{ currencyMap[i.currency] = (currencyMap[i.currency]||0)+1; });
            const topCurrency = Object.keys(currencyMap).sort((a,b)=>currencyMap[b]-currencyMap[a])[0] || '-';

            const langIsEn = document.documentElement.getAttribute('lang') === 'en';
            const totalText = `$${totalUSD.toFixed(2)} / ${totalSYP.toLocaleString()} ل.س`;

            const elInvoices = document.getElementById('stat-invoices'); if (elInvoices) elInvoices.textContent = totalCount;
            const elTotal = document.getElementById('stat-total'); if (elTotal) elTotal.textContent = totalText;
            const elBusiest = document.getElementById('stat-busiest'); if (elBusiest) elBusiest.textContent = busiest;
            const elCurrency = document.getElementById('stat-currency'); if (elCurrency) elCurrency.textContent = topCurrency;

            // Chart.js if available: show invoices per month
            if (typeof Chart !== 'undefined' && document.getElementById('stats-chart')) {
                const groups = {};
                data.forEach(i=> { groups[i.monthBucket] = (groups[i.monthBucket]||0)+1; });
                const months = Object.keys(groups).sort((a,b)=> new Date(a.split(' ').slice(0,2).join(' 1, ')) - new Date(b.split(' ').slice(0,2).join(' 1, ')));
                const counts = months.map(m=>groups[m]);
                const ctx = document.getElementById('stats-chart').getContext('2d');
                try {
                    if (_statsChart) _statsChart.destroy();
                } catch(e){}
                _statsChart = new Chart(ctx, {
                    type: 'line',
                    data: {
                        labels: months,
                        datasets: [{ label: langIsEn ? 'Invoices' : 'الإيصالات', data: counts, borderColor: 'rgba(34,197,94,0.9)', backgroundColor: 'rgba(34,197,94,0.12)', fill: true, tension: 0.3 }]
                    },
                    options: { responsive: true, plugins: { legend: { display: false } } }
                });
            }
        }

    // === Enhanced amount input UX (formatting + validation, UI-only) ===
    (function enhanceAmountInput() {
        const amt = selectors.formAmount;
        if (!amt) return;
        // ensure mobile numeric keyboard
        try { amt.setAttribute('inputmode', 'decimal'); } catch(e){}
        amt.dataset.rawValue = amt.value || '';

        function formatForDisplay(raw) {
            if (!raw && raw !== 0) return '';
            const n = String(raw);
            const parts = n.split('.');
            const intPart = parts[0].replace(/^0+(?=\d)|[^0-9]/g, '') || '0';
            const dec = parts[1] ? parts[1].slice(0,2) : null;
            const withSep = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
            return dec != null ? withSep + '.' + dec : withSep;
        }

        amt.addEventListener('keydown', (e) => {
            if (e.ctrlKey || e.metaKey) return;
            const allowed = ['Backspace','Tab','ArrowLeft','ArrowRight','Delete','Home','End'];
            if (allowed.includes(e.key)) return;
            // accept western digits, Arabic-Indic and Eastern Arabic digits, and decimal separators
            const isDigit = /[0-9\u0660-\u0669\u06F0-\u06F9]/.test(e.key);
            const isDecimal = e.key === '.' || e.key === ',' || e.key === '\u066b' || e.key === '\u066c';
            if (isDecimal) {
                if (amt.value.includes('.') || amt.value.includes(',') || amt.value.includes('\u066b') || amt.value.includes('\u066c')) e.preventDefault();
                return;
            }
            if (!isDigit) e.preventDefault();
        });

        amt.addEventListener('input', () => {
            // normalize Arabic/Persian digits and separators first
            const normalizedDigits = normalizeOcrDigits(amt.value || '');
            const raw = String(normalizedDigits)
                .replace(/[^0-9.,]/g, '')
                .replace(/,/g, '.');
            const parts = raw.split('.');
            const intPart = parts.shift() || '';
            const decPart = parts.join('').slice(0,2);
            const normalized = decPart ? intPart + '.' + decPart : intPart;
            amt.dataset.rawValue = normalized;
            amt.value = formatForDisplay(normalized);
        });

        amt.addEventListener('focus', () => {
            // show raw for easier editing
            amt.value = String(amt.dataset.rawValue || '').replace(/,/g, '.');
        });

        amt.addEventListener('blur', () => {
            const raw = amt.dataset.rawValue || amt.value.replace(/,/g, '.');
            const num = parseFloat(String(raw || '').replace(/,/g, ''));
            if (Number.isFinite(num)) {
                amt.dataset.rawValue = num.toFixed(2);
                amt.value = Number(num).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2});
            } else {
                amt.dataset.rawValue = '';
                amt.value = '';
            }
        });
    })();

    function safeParseJSON(value, fallback) {

        try {
            const data = localStorage.getItem(value);
            return data ? JSON.parse(data) : fallback;
        } catch {
            return fallback;
        }
    }

    // Primary (localStorage fallback data) until IndexedDB finishes loading.
    let invoicesDatabase = loadInvoicesFromLocalStorage();

    let lockedMonths = safeParseJSON(STORAGE_KEYS.lockedMonths, {});
    let activeMonthBucket = "May 2026";
    let isCurrentMonthLocked = !!lockedMonths[activeMonthBucket];

    function updateMonthDisplayLabels() {
        if(selectors.tableMonthTitle) selectors.tableMonthTitle.textContent = activeMonthBucket;
        if(selectors.dashboardMonthLabel) selectors.dashboardMonthLabel.textContent = activeMonthBucket;
        if(selectors.tableLockBadge) {
            selectors.tableLockBadge.style.display = isCurrentMonthLocked ? "inline-flex" : "none";
        }
    }

    // 1. Navigation
    if (selectors.navItems.length) {
        selectors.navItems.forEach(item => {
            item.addEventListener("click", () => {
                const targetScreen = item.getAttribute("data-screen");
                if (!targetScreen) return;

                selectors.navItems.forEach(nav => nav.classList.remove("active"));
                item.classList.add("active");

                selectors.screens.forEach(screen => {
                    screen.classList.toggle("active", screen.id === targetScreen);
                });
            });
            // keyboard activation (Enter / Space) for accessibility
            item.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault();
                    item.click();
                }
            });
        });
    }

    let cameraStream = null;

    function stopCameraStream() {
        if (cameraStream) {
            cameraStream.getTracks().forEach(track => track.stop());
            cameraStream = null;
        }
        if (selectors.cameraVideo) {
            selectors.cameraVideo.pause();
            selectors.cameraVideo.srcObject = null;
        }
        if (selectors.cameraOverlay) selectors.cameraOverlay.style.display = 'none';
    }

    async function openCameraScanner() {
        const isEn = document.documentElement.getAttribute('lang') === 'en';
        if (isCurrentMonthLocked) {
            alert(isEn ? 'This month is locked.' : 'تم قفل جدول الشهر الحالي تلقائياً.');
            return;
        }

        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            if (selectors.scanInvoiceFileInput) {
                selectors.scanInvoiceFileInput.value = '';
                selectors.scanInvoiceFileInput.click();
            }
            return;
        }

        // Try multiple strategies to reliably open the back camera across devices/browsers
        async function tryGetUserMedia(constraints) {
            try {
                return await navigator.mediaDevices.getUserMedia(constraints);
            } catch (err) {
                return null;
            }
        }

        try {
            if (selectors.cameraOverlay) selectors.cameraOverlay.style.display = 'flex';
            showOcrMessage(isEn ? 'Starting camera...' : 'جاري تشغيل الكاميرا...');

            // 1) Try strict back camera (may throw if not supported)
            cameraStream = await tryGetUserMedia({ video: { facingMode: { exact: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });

            // 2) If strict failed, try ideal facingMode
            if (!cameraStream) {
                cameraStream = await tryGetUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
            }

            // 3) If still no stream, try to enumerate video input devices and pick a likely rear camera
            if (!cameraStream && navigator.mediaDevices && typeof navigator.mediaDevices.enumerateDevices === 'function') {
                try {
                    const devices = await navigator.mediaDevices.enumerateDevices();
                    const videoInputs = devices.filter(d => d.kind === 'videoinput');
                    // heuristic: choose last device (often rear camera) or any device whose label contains 'back'/'rear'
                    let chosen = null;
                    for (const d of videoInputs) {
                        const label = (d.label || '').toLowerCase();
                        if (label.includes('back') || label.includes('rear') || label.includes('environment')) { chosen = d; break; }
                    }
                    if (!chosen && videoInputs.length) chosen = videoInputs[videoInputs.length - 1];
                    if (chosen) {
                        cameraStream = await tryGetUserMedia({ video: { deviceId: { exact: chosen.deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
                    }
                } catch (enumErr) {
                    console.warn('enumerateDevices failed or returned no usable video inputs', enumErr);
                }
            }

            // 4) If still not available, fallback to native file input
            if (!cameraStream) {
                stopCameraStream();
                if (selectors.scanInvoiceFileInput) {
                    selectors.scanInvoiceFileInput.value = '';
                    selectors.scanInvoiceFileInput.click();
                    showOcrMessage(isEn ? 'Opening file picker...' : 'فتح منتقي الملفات...');
                } else {
                    alert(isEn ? 'Camera is unavailable or permission was denied.' : 'الكاميرا غير متاحة أو تم رفض الصلاحية.');
                }
                return;
            }

            // attach stream to video element
            if (selectors.cameraVideo) {
                selectors.cameraVideo.srcObject = cameraStream;
                await selectors.cameraVideo.play();
            }
            showOcrMessage(isEn ? 'Align the invoice and capture.' : 'وجّه الكاميرا نحو الفاتورة ثم التقط الصورة.');
        } catch (e) {
            console.error('Camera permission/start failed (unexpected):', e);
            stopCameraStream();
            if (selectors.scanInvoiceFileInput) {
                selectors.scanInvoiceFileInput.value = '';
                selectors.scanInvoiceFileInput.click();
            } else {
                alert(isEn ? 'Camera is unavailable or permission was denied.' : 'الكاميرا غير متاحة أو تم رفض الصلاحية.');
            }
        }
    }

    async function captureCameraFrame() {
        const video = selectors.cameraVideo;
        const canvas = selectors.cameraCanvas;
        if (!video || !canvas || !video.videoWidth || !video.videoHeight) return;

        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        showOcrMessage(document.documentElement.getAttribute('lang') === 'en' ? 'Captured. Processing...' : 'تم الالتقاط. جاري التحليل...');
        canvas.toBlob(async (blob) => {
            stopCameraStream();
            if (blob) await processInvoice(blob);
        }, 'image/jpeg', 0.95);
    }

    // 2. Camera + OCR
    function isMobileDevice() {
        try {
            return window.matchMedia('(pointer:coarse)').matches || /Mobi|Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
        } catch { return false; }
    }

    if (selectors.triggerOcrBtn) {
        selectors.triggerOcrBtn.addEventListener('click', (e) => {
            // If the embedded file input was clicked, allow native behavior to continue
            if (e.target && (e.target.tagName === 'INPUT' || e.target.id === 'scan-invoice-file-input')) {
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            // Prefer opening the in-app camera via getUserMedia on mobile devices.
            if (isMobileDevice()) {
                if (navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function') {
                    // Try the in-app camera overlay first (more reliable for direct capture)
                    openCameraScanner();
                    return;
                }

                // Fallback: try the native file input (capture attribute)
                if (selectors.scanInvoiceFileInput) {
                    try {
                        selectors.scanInvoiceFileInput.value = '';
                        selectors.scanInvoiceFileInput.click();
                        return;
                    } catch (err) {
                        console.warn('native file input camera trigger failed, falling back to overlay', err);
                    }
                }

                // Last resort: open overlay
                openCameraScanner();
            } else {
                // Desktop: open file picker first, fallback to camera overlay
                if (selectors.scanInvoiceFileInput) {
                    selectors.scanInvoiceFileInput.value = '';
                    selectors.scanInvoiceFileInput.click();
                } else {
                    openCameraScanner();
                }
            }
        });
    }

    if (selectors.closeCameraBtn) {
        selectors.closeCameraBtn.addEventListener('click', () => {
            stopCameraStream();
        });
    }

    if (selectors.captureCameraBtn) {
        selectors.captureCameraBtn.addEventListener('click', captureCameraFrame);
    }

    // small ripple effect for camera buttons (visual only)
    function attachRipple(el) {
        if (!el) return;
        el.addEventListener('click', (ev) => {
            const rect = el.getBoundingClientRect();
            const ripple = document.createElement('span');
            ripple.className = 'ripple-effect-temp';
            ripple.style.position = 'absolute';
            ripple.style.borderRadius = '50%';
            ripple.style.pointerEvents = 'none';
            ripple.style.width = ripple.style.height = Math.max(rect.width, rect.height) + 'px';
            ripple.style.left = (ev.clientX - rect.left - rect.width/2) + 'px';
            ripple.style.top = (ev.clientY - rect.top - rect.height/2) + 'px';
            ripple.style.background = 'rgba(255,255,255,0.12)';
            ripple.style.transform = 'scale(0)';
            ripple.style.transition = 'transform 400ms ease-out, opacity 400ms ease-out';
            ripple.style.zIndex = '9999';
            el.style.position = el.style.position || 'relative';
            el.appendChild(ripple);
            requestAnimationFrame(() => { ripple.style.transform = 'scale(2)'; ripple.style.opacity = '0'; });
            setTimeout(() => { try { ripple.remove(); } catch{} }, 500);
        });
    }

    attachRipple(selectors.triggerOcrBtn);
    attachRipple(selectors.captureCameraBtn);

    function executeGoogleMLKitOCR() {
        // Keeping existing mock OCR behavior as fallback for the camera overlay.
        const mockScannedData = [
            { text: "أغذية ومستهلكات دمشق", amount: 145000, currency: "ل.س", category: "مواد غذائية" },
            { text: "Apple Store Online", amount: 1200.00, currency: "$", category: "إلكترونيات" },
            { text: "محطة الوقود المركزية", amount: 350000, currency: "ل.س", category: "وقود" }
        ];
        const scanResult = mockScannedData[Math.floor(Math.random() * mockScannedData.length)];

        const invoiceModel = {
            id: 'inv_' + Date.now(),
            date: new Date().toISOString().split('T')[0],
            name: scanResult.text,
            amount: scanResult.amount,
            currency: scanResult.currency,
            category: scanResult.category,
            monthBucket: activeMonthBucket
        };

        invoicesDatabase.push(invoiceModel);
        localStorage.setItem(STORAGE_KEYS.invoices, JSON.stringify(invoicesDatabase));
        renderDatabaseInInterfaces();
    }

    // ======================= Smart Invoice OCR (Tesseract.js) =======================
    function showOcrMessage(msg) {
        if (!selectors.ocrLoaderText && document.querySelector('.ocr-loader-text')) {
            selectors.ocrLoaderText = document.querySelector('.ocr-loader-text');
        }
        if (selectors.ocrLoaderText) selectors.ocrLoaderText.textContent = msg;
    }

    function normalizeOcrDigits(value) {
        const arabic = '٠١٢٣٤٥٦٧٨٩';
        const persian = '۰۱۲۳۴۵۶۷۸۹';
        return String(value || '')
            .replace(/[٠-٩]/g, d => String(arabic.indexOf(d)))
            .replace(/[۰-۹]/g, d => String(persian.indexOf(d)))
            .replace(/\u066b/g, '.')
            .replace(/\u066c/g, ',');
    }

    function parseOcrAmount(value) {
        const cleaned = normalizeOcrDigits(value)
            .replace(/[^\d.,]/g, '')
            .replace(/,(?=\d{3}\b)/g, '')
            .replace(/,/g, '.');
        const amount = parseFloat(cleaned);
        return Number.isFinite(amount) ? amount : null;
    }

    function normalizeOcrDate(value) {
        const raw = normalizeOcrDigits(value).trim().replace(/[/.]/g, '-');
        const parts = raw.split('-').filter(Boolean);
        if (parts.length !== 3) return new Date().toISOString().split('T')[0];

        let y;
        let m;
        let d;
        if (parts[0].length === 4) {
            [y, m, d] = parts;
        } else {
            [d, m, y] = parts;
        }

        if (String(y).length === 2) y = `20${y}`;
        return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }

    function extractInvoiceDataFromText(text) {
        const normalizedText = normalizeOcrDigits(text);
        const lines = normalizedText
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(line => line.length > 1);

        const ignoredNameWords = /total|amount|date|invoice|receipt|tax|vat|cash|visa|subtotal|balance|المجموع|الإجمالي|اجمالي|ضريبة|فاتورة|تاريخ|نقد/i;
        const name = (lines.find(line => /[A-Za-z\u0600-\u06FF]/.test(line) && !ignoredNameWords.test(line)) || lines[0] || 'Scanned Invoice').slice(0, 80);

        const dateMatch = normalizedText.match(/\b(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})\b/);
        const date = dateMatch ? normalizeOcrDate(dateMatch[0]) : new Date().toISOString().split('T')[0];

        const currency = /(\$|usd|dollar)/i.test(normalizedText) ? '$' : 'ل.س';
        const amountCandidates = [];
        const amountRegex = /(?:total|amount|grand|net|المجموع|الإجمالي|اجمالي|المبلغ)[^\d٠-٩۰-۹]{0,16}([\d٠-٩۰-۹][\d٠-٩۰-۹.,٬٫ ]*)/gi;
        let match;
        while ((match = amountRegex.exec(normalizedText)) !== null) {
            const value = parseOcrAmount(match[1]);
            if (value !== null) amountCandidates.push(value);
        }
        if (!amountCandidates.length) {
            const looseAmounts = normalizedText.match(/[\d٠-٩۰-۹]{1,3}(?:[,\u066c ]?[\d٠-٩۰-۹]{3})*(?:[.\u066b]\d{1,2})?|\d+(?:[.\u066b]\d{1,2})?/g) || [];
            looseAmounts.forEach(item => {
                const value = parseOcrAmount(item);
                if (value !== null) amountCandidates.push(value);
            });
        }

        const amount = amountCandidates.length ? Math.max(...amountCandidates) : 0;
        return { name, date, amount, currency, category: 'أخرى' };
    }

    function fillInvoiceReview(data) {
        openInvoiceModalForAdd();
        if (selectors.formName) selectors.formName.value = data.name || '';
        if (selectors.formAmount) {
            const num = Number(data.amount || 0);
            if (Number.isFinite(num)) {
                selectors.formAmount.dataset.rawValue = num.toFixed(2);
                selectors.formAmount.value = Number(num).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2});
            } else {
                selectors.formAmount.dataset.rawValue = '';
                selectors.formAmount.value = '';
            }
        }
        if (selectors.formCurrency) selectors.formCurrency.value = data.currency || '$';
        if (selectors.formCategory) selectors.formCategory.value = data.category || 'أخرى';
        if (selectors.formDate) selectors.formDate.value = data.date || new Date().toISOString().split('T')[0];
    }

    async function processInvoice(input) {
        const isEn = document.documentElement.getAttribute('lang') === 'en';

        // Config: replace with your actual AI endpoint and optional API key
        const AI_ENDPOINT = window.SPARFUCHS_AI_ENDPOINT || ''; // e.g. 'https://your-ai-server.example/api/vision'
        const AI_API_KEY = window.SPARFUCHS_AI_KEY || '';

                // Prompt required by the user (sent to the AI)
                // Instruct the model to always return strict JSON with items array when available.
                const AI_PROMPT = `أنت نظام رؤية حاسوبية ذكي لتطبيق SparFuchs AI. حلل صورة الفاتورة المرفقة ديناميكياً وتوافق مع تصميم الجدول أو النصوص الخاص بها أياً كان شكلها. استخرج بدقة عالية وأعد JSON حصرياً وبدون شرح جانبي، الصيغة التالية:
{
    "bill_name": "اسم المتجر أو الفاتورة",
    "total_amount": 0.00,             // رقم عشري نظيف بدون فواصل
    "currency": "رمز العملة مثل SYP أو USD",
    "date": "YYYY-MM-DD",
    "items": [                         // إن وُجدت بنود مفصلة، أعد مصفوفة بنود
        { "name": "اسم البند", "quantity": 1, "unit_price": 0.00, "total_price": 0.00 }
    ]
}`;

        function blobToBase64(blob) {
            return new Promise((resolve, reject) => {
                try {
                    const reader = new FileReader();
                    reader.onerror = () => reject(new Error('FileReader failed'));
                    reader.onload = () => {
                        const parts = String(reader.result || '').split(',');
                        resolve(parts[1] || '');
                    };
                    reader.readAsDataURL(blob);
                } catch (err) { reject(err); }
            });
        }

        async function sendBase64ToAiAndPopulate(base64) {
            try {
                if (!AI_ENDPOINT) {
                    console.warn('AI_ENDPOINT not configured — skipping AI POST.');
                    return null;
                }

                showOcrMessage(isEn ? 'Sending image to AI...' : 'إرسال الصورة إلى خادم الذكاء الاصطناعي...');

                const payload = {
                    prompt: AI_PROMPT,
                    image_base64: base64
                };

                const headers = { 'Content-Type': 'application/json' };
                if (AI_API_KEY) headers['Authorization'] = 'Bearer ' + AI_API_KEY;

                const res = await fetch(AI_ENDPOINT, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(payload)
                });

                if (!res.ok) {
                    const txt = await res.text().catch(()=>null);
                    console.warn('AI server returned non-OK:', res.status, txt);
                    return null;
                }

                const json = await res.json().catch(() => null);
                console.log('AI response raw:', json);

                // Try to find the JSON payload in common shapes
                const aiResult = (json && (json.data || json.result || json.output || json)) || null;
                const parsed = aiResult && typeof aiResult === 'object' ? aiResult : null;

                // If parsed contains wrapper fields (e.g., choices[0].text), attempt to parse text
                let final = null;
                if (!parsed && json && json.choices && Array.isArray(json.choices) && json.choices[0]) {
                    try { final = JSON.parse(json.choices[0].text); } catch { final = null; }
                } else if (parsed && parsed.bill_name) {
                    final = parsed;
                } else if (json && typeof json === 'string') {
                    try { final = JSON.parse(json); } catch {}
                }

                if (!final) {
                    // best-effort: search for JSON-like string in response
                    const asText = JSON.stringify(json || {}).replace(/\\\n/g,'');
                    try {
                        const match = asText.match(/\{\s*"bill_name"[\s\S]*\}/);
                        if (match) final = JSON.parse(match[0]);
                    } catch (e) { final = null; }
                }

                if (final) {
                    console.log('Parsed AI invoice result:', final);

                    // Fill fields safely
                    if (selectors.formName && final.bill_name) selectors.formName.value = final.bill_name;
                    if (selectors.formAmount && typeof final.total_amount !== 'undefined' && final.total_amount !== null) {
                        const amt = Number(final.total_amount);
                        if (Number.isFinite(amt)) {
                            selectors.formAmount.dataset.rawValue = amt.toFixed(2);
                            selectors.formAmount.value = Number(amt).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2});
                        }
                    }
                    if (selectors.formCurrency && final.currency) selectors.formCurrency.value = final.currency;
                    if (selectors.formDate && final.date) selectors.formDate.value = final.date;

                    // Render dynamic items if present
                    if (Array.isArray(final.items) && final.items.length) {
                        renderInvoiceItems(final.items);
                        try { renderScannedResult(final); } catch(e) { console.warn('scanned card render failed', e); }
                    } else {
                        clearInvoiceItems();
                        try { renderScannedResult(final); } catch(e) { console.warn('scanned card render failed', e); }
                    }

                    showOcrMessage(isEn ? 'AI result applied.' : 'تم تطبيق نتيجة الذكاء الاصطناعي.');
                    return final;
                }

                showOcrMessage(isEn ? 'AI did not return structured JSON.' : 'لم يرجع الذكاء الاصطناعي JSON منسق.');
                return null;
            } catch (err) {
                console.error('sendBase64ToAiAndPopulate error:', err);
                return null;
            }
        }

        try {
            if (!input) return;

            // If caller passed a base64 string directly
            if (typeof input === 'string') {
                await sendBase64ToAiAndPopulate(input);
                return;
            }

            if (typeof Tesseract === 'undefined') {
                alert(isEn ? 'OCR library not loaded.' : 'مكتبة OCR غير محمّلة.');
                return;
            }

            showOcrMessage(isEn ? 'Processing invoice...' : 'جاري تحليل الفاتورة...');

            // Try to create an ImageBitmap for resizing
            const imgBitmap = await createImageBitmap(input).catch(() => null);
            if (!imgBitmap) {
                // fallback: run OCR on original blob/file and also send to AI
                const result = await Tesseract.recognize(input, 'ara+eng');
                const text = result?.data?.text || '';
                fillInvoiceReview(extractInvoiceDataFromText(text));
                try {
                    const b64 = await blobToBase64(input);
                    await sendBase64ToAiAndPopulate(b64);
                } catch (err) { console.warn('AI send fallback failed', err); }
                showOcrMessage(isEn ? 'Done. Review extracted data.' : 'تم. راجع البيانات المستخرجة.');
                return;
            }

            const maxWidth = 1200;
            const scale = imgBitmap.width > maxWidth ? maxWidth / imgBitmap.width : 1;
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(imgBitmap.width * scale);
            canvas.height = Math.round(imgBitmap.height * scale);
            const ctx = canvas.getContext('2d');
            ctx.drawImage(imgBitmap, 0, 0, canvas.width, canvas.height);

            const resizedBlob = await new Promise((resolve) => canvas.toBlob(resolve, input.type || 'image/jpeg', 0.92));
            const inputForTesseract = resizedBlob || input;

            const result = await Tesseract.recognize(inputForTesseract, 'ara+eng', {
                logger: () => { /* progress UI could be added later */ }
            });

            const text = (result && result.data && result.data.text) ? result.data.text : '';
            fillInvoiceReview(extractInvoiceDataFromText(text));

            // Also send to AI for structured extraction and populate fields if available
            try {
                const b64 = await blobToBase64(inputForTesseract || input);
                await sendBase64ToAiAndPopulate(b64);
            } catch (err) {
                console.warn('AI send failed:', err);
            }

            showOcrMessage(isEn ? 'Done. Review extracted data.' : 'تم. راجع البيانات المستخرجة.');
        } catch (e) {
            console.error('processInvoice error:', e);
            alert((document.documentElement.getAttribute('lang') === 'en') ? 'OCR failed.' : 'فشل تحليل OCR.');
        }
    }

    // Bind scan invoice button + file input
    if (selectors.scanInvoiceBtn && selectors.scanInvoiceFileInput) {
        selectors.scanInvoiceBtn.addEventListener('click', () => {
            try {
                openCameraScanner();
            } catch (e) {
                console.error('scan-invoice click failed:', e);
            }
        });

        selectors.scanInvoiceFileInput.addEventListener('change', (e) => {
            const file = e.target && e.target.files ? e.target.files[0] : null;
            if (!file) return;
            processInvoice(file);
        });
    }

    // 3. Modal handlers
    if (selectors.fastManualBtn) {
        selectors.fastManualBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (isCurrentMonthLocked) return alert('تم قفل جدول الشهر الحالي تلقائياً.');
            openInvoiceModalForAdd();
        });
    }

    if (selectors.closeInvoiceModalBtn) {
        selectors.closeInvoiceModalBtn.addEventListener('click', () => {
            if(selectors.invoiceModal) selectors.invoiceModal.classList.remove('active');
        });
        // allow keyboard to close modal via Enter/Space
        selectors.closeInvoiceModalBtn.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                if(selectors.invoiceModal) selectors.invoiceModal.classList.remove('active');
            }
        });
    }

    function openInvoiceModalForAdd() {
        if(!selectors.invoiceModal) return;
        const isEn = document.documentElement.getAttribute('lang') === 'en';
        if(selectors.modalTitle) selectors.modalTitle.textContent = isEn ? 'Add Invoice Manually' : 'إضافة فاتورة يدوياً';
        if(selectors.formInvoiceId) selectors.formInvoiceId.value = '';
        if(selectors.invoiceForm) selectors.invoiceForm.reset();
        if(selectors.formDate) selectors.formDate.value = new Date().toISOString().split('T')[0];
        selectors.invoiceModal.classList.add('active');
    }

    function openInvoiceModalForEdit(invoice) {
        if(!selectors.invoiceModal) return;
        const isEn = document.documentElement.getAttribute('lang') === 'en';
        if(selectors.modalTitle) selectors.modalTitle.textContent = isEn ? 'Edit Invoice' : 'تعديل بيانات الفاتورة';
        if(selectors.formInvoiceId) selectors.formInvoiceId.value = invoice.id;
        if(selectors.formName) selectors.formName.value = invoice.name;
        if(selectors.formAmount) {
            const num = Number(invoice.amount || 0);
            if (Number.isFinite(num)) {
                selectors.formAmount.dataset.rawValue = num.toFixed(2);
                selectors.formAmount.value = Number(num).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2});
            } else {
                selectors.formAmount.dataset.rawValue = '';
                selectors.formAmount.value = '';
            }
        }
        if(selectors.formCurrency) selectors.formCurrency.value = invoice.currency;
        if(selectors.formCategory) selectors.formCategory.value = invoice.category;
        if(selectors.formDate) selectors.formDate.value = invoice.date;
        selectors.invoiceModal.classList.add('active');
    }

    // ------------------ Paste-text modal: parse free text invoice -> JSON ------------------
    function parseInvoiceText(rawText) {
        const text = String(rawText || '').trim();
        const normalized = normalizeOcrDigits(text);
        const lines = normalized.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);

        const ignoreRe = /total|subtotal|amount|grand|net|tax|cash|visa|balance|المجموع|الإجمالي|اجمالي|ضريبة|فاتورة|تاريخ|المبلغ|سعر الوحدة/i;

        const items = [];

        for (const line of lines) {
            if (ignoreRe.test(line) && !/\d/.test(line)) continue;

            // extract numeric tokens (quantities/prices)
            const numTokens = (line.match(/\d+(?:[.,]\d{1,2})?/g) || []).map(s => s.replace(/,/g, '.'));
            const amounts = numTokens.map(n => parseFloat(n)).filter(n => Number.isFinite(n));

            // skip lines that appear to be headers without numbers
            if (amounts.length === 0) continue;

            // derive name by removing numbers and common separators
            let name = line.replace(/\d+(?:[.,]\d{1,2})?/g, '').replace(/x|×|@/gi, '').replace(/[:\-–—]/g, '').replace(/\s{2,}/g, ' ').trim();
            if (!name) name = line;

            let qty = 1;
            let unit_price = 0;
            let total = 0;

            if (amounts.length >= 3) {
                // assume [qty, unit, ..., total]
                qty = Math.round(amounts[0]);
                unit_price = amounts[1];
                total = amounts[amounts.length - 1];
            } else if (amounts.length === 2) {
                const [a1, a2] = amounts;
                // heuristic: if first is integer and small -> qty
                if (Number.isInteger(a1) && a1 > 0 && a1 <= 1000 && String(numTokens[0]).indexOf('.') === -1) {
                    qty = a1;
                    unit_price = a2;
                    total = +(qty * unit_price).toFixed(2);
                } else {
                    // treat as unit_price and total (qty=1)
                    qty = 1;
                    unit_price = a1;
                    total = a2;
                }
            } else if (amounts.length === 1) {
                qty = 1;
                unit_price = amounts[0];
                total = amounts[0];
            }

            // ensure numeric rounding and logical correction
            qty = Number(qty);
            unit_price = Number(Number(unit_price).toFixed(2));
            const calc = Number((qty * unit_price).toFixed(2));
            if (!Number.isFinite(total) || Math.abs(calc - Number(total)) > 0.01) {
                total = calc;
            } else {
                total = Number(Number(total).toFixed(2));
            }

            items.push({ name: name, qty: qty, unit_price: unit_price, total: total });
        }

        const grand_total = Number((items.reduce((s, it) => s + (Number(it.total) || 0), 0)).toFixed(2));

        return { items, grand_total };
    }

    // Simple heuristic category inference based on keywords
    function inferCategory(name) {
        if (!name) return '';
        const s = String(name).toLowerCase();
        const map = [
            { keys: ['خبز','رغيف','تنور'], cat: 'مواد غذائية' },
            { keys: ['لبن','حليب','جبن','زبادي'], cat: 'مواد غذائية' },
            { keys: ['فحم','وقود','بنزين','ديزل','محطة'], cat: 'وقود' },
            { keys: ['مياه','مياة'], cat: 'مشروبات' },
            { keys: ['عطر','معطر','بخاخ'], cat: 'مستحضرات' },
            { keys: ['تفاح','برتقال','ليمون','موز','خضار','خس','طماطم'], cat: 'خضروات وفواكه' },
            { keys: ['سجاد','منظف','صابون','مطهر'], cat: 'منظفات' },
            { keys: ['مطعم','مطاعم','غداء','عشاء'], cat: 'مطاعم' }
        ];
        for (const m of map) {
            for (const k of m.keys) if (s.includes(k)) return m.cat;
        }
        return '';
    }

    // Modal controls for paste-text
    if (selectors.pasteTextBtn) {
        selectors.pasteTextBtn.addEventListener('click', () => {
            if (!selectors.textModal) return;
            selectors.textModal.style.display = 'block';
            selectors.rawInvoiceText.value = '';
            selectors.jsonOutput.style.display = 'none';
            selectors.copyJsonBtn.style.display = 'none';
            setTimeout(() => selectors.rawInvoiceText.focus(), 80);
        });
    }

    if (selectors.closeTextModalBtn) {
        selectors.closeTextModalBtn.addEventListener('click', () => {
            if (!selectors.textModal) return;
            selectors.textModal.style.display = 'none';
        });
    }

    if (selectors.parseTextBtn) {
        selectors.parseTextBtn.addEventListener('click', (ev) => {
            ev.preventDefault();
            const raw = selectors.rawInvoiceText ? selectors.rawInvoiceText.value : '';
            const parsed = parseInvoiceText(raw || '');
            // build strict JSON as requested
            const out = { items: [] , grand_total: 0 };
            out.items = parsed.items.map(it => ({ name: it.name || '', qty: Number(it.qty) || 0, unit_price: Number(it.unit_price) || 0, total: Number(it.total) || 0 }));
            out.grand_total = Number(parsed.grand_total || 0);

            if (selectors.jsonOutput) {
                selectors.jsonOutput.textContent = JSON.stringify(out, null, 2);
                selectors.jsonOutput.style.display = 'block';
            }
            if (selectors.copyJsonBtn) selectors.copyJsonBtn.style.display = 'inline-block';
            // Also populate modal items for review (convert keys to expected shape)
            const normalized = (out.items || []).map(i => ({ name: i.name || '', quantity: Number(i.qty || i.quantity || 0), unit_price: Number(i.unit_price || i.unit || 0), total_price: Number(i.total || i.total_price || 0), category: inferCategory(i.name || '') }));
            renderInvoiceItems(normalized);
            openInvoiceModalForAdd();
            if (selectors.formAmount) {
                selectors.formAmount.dataset.rawValue = Number(out.grand_total || 0).toFixed(2);
                selectors.formAmount.value = Number(out.grand_total || 0).toLocaleString(undefined,{minimumFractionDigits:2, maximumFractionDigits:2});
            }
        });
    }

    if (selectors.copyJsonBtn) {
        selectors.copyJsonBtn.addEventListener('click', async () => {
            try {
                const txt = selectors.jsonOutput ? selectors.jsonOutput.textContent : '';
                await navigator.clipboard.writeText(txt || '');
                selectors.copyJsonBtn.textContent = 'نسخ✓';
                setTimeout(() => { selectors.copyJsonBtn.textContent = 'نسخ JSON'; }, 1200);
            } catch (e) {
                console.warn('copy failed', e);
            }
        });
    }

    // Save form (insert/update) using IndexedDB (primary) + localStorage (fallback)
    if(selectors.invoiceForm) {
        selectors.invoiceForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            console.log('Button clicked, starting submission...');

            try {
                const name = selectors.formName ? selectors.formName.value : '';
                // read raw numeric value (keeps UI formatting separate from stored numeric)
                const rawAmount = selectors.formAmount ? (selectors.formAmount.dataset.rawValue || selectors.formAmount.value.replace(/,/g, '.')) : '';
                const amount = selectors.formAmount ? parseFloat(String(rawAmount).replace(/,/g, '')) : NaN;
                const currency = selectors.formCurrency ? selectors.formCurrency.value : '';
                const category = selectors.formCategory ? selectors.formCategory.value : '';
                const date = selectors.formDate ? selectors.formDate.value : '';
                const editId = selectors.formInvoiceId ? selectors.formInvoiceId.value : '';

                const isEdit = !!editId;

                if (Number.isNaN(amount)) throw new Error('Invalid amount');

                const invoiceToWrite = {
                    id: isEdit ? editId : 'inv_' + Date.now(),
                    date,
                    name,
                    amount: Number(amount),
                    currency,
                    category,
                    monthBucket: activeMonthBucket
                };

                // If invoice items are present in the modal, read and attach them
                try {
                    const itemsTbody = document.getElementById('invoice-items-tbody');
                    if (itemsTbody && itemsTbody.children && itemsTbody.children.length) {
                        const items = [];
                        Array.from(itemsTbody.children).forEach(row => {
                            const cols = row.children;
                            if (!cols || cols.length < 4) return;
                            const nameCell = cols[0].textContent.trim();
                            const qtyCell = cols[1].textContent.trim();
                            const unitCell = cols[2].textContent.trim();
                            const totalCell = cols[3].textContent.trim();
                            let catCell = '';
                            if (cols[4]) {
                                const el = (cols[4].querySelector && (cols[4].querySelector('input') || cols[4].querySelector('select')));
                                catCell = el ? (el.value || '').trim() : cols[4].textContent.trim();
                            }
                            const q = parseFloat(qtyCell.replace(/,/g,'.')) || 0;
                            const u = parseFloat(unitCell.replace(/,/g,'.')) || 0;
                            const t = parseFloat(totalCell.replace(/,/g,'.')) || Number((q*u).toFixed(2));
                            items.push({ name: nameCell, quantity: q, unit_price: u, total_price: t, category: catCell || inferCategory(nameCell) });
                        });
                        if (items.length) {
                            invoiceToWrite.items = items;
                            // derive amount from items if original amount invalid or zero
                            const itemsSum = items.reduce((s,it) => s + (Number(it.total_price)||0), 0);
                            if (!Number.isFinite(invoiceToWrite.amount) || invoiceToWrite.amount === 0) invoiceToWrite.amount = Number(itemsSum.toFixed(2));
                            // if top-level category empty, pick most common item category
                            if (!invoiceToWrite.category || invoiceToWrite.category === '') {
                                const freq = {};
                                items.forEach(it => { if (it.category) freq[it.category] = (freq[it.category]||0)+1; });
                                const top = Object.keys(freq).sort((a,b)=>freq[b]-freq[a])[0];
                                if (top) invoiceToWrite.category = top;
                            }
                        }
                    }
                } catch (e) { console.warn('read items failed', e); }

                await saveInvoice(invoiceToWrite);

                if (selectors.invoiceModal) selectors.invoiceModal.classList.remove('active');

                invoicesDatabase = await loadInvoices();
                persistInvoicesToLocalStorage(invoicesDatabase);

                console.log(isEdit ? 'Success: Data updated' : 'Success: Data inserted');
                renderDatabaseInInterfaces();
            } catch (error) {
                console.error('Error occurred:', error);
                alert(document.documentElement.getAttribute('lang') === 'en' ? 'Unexpected error occurred.' : 'حدث خطأ غير متوقع.');
            }
        });
    }

    function updateDashboard() {
        const currentMonthData = invoicesDatabase.filter(inv => inv.monthBucket === activeMonthBucket);

        let totalUSD = 0;
        let totalSYP = 0;

        currentMonthData.forEach(inv => {
            if (inv.currency === '$') totalUSD += inv.amount;
            else if (inv.currency === 'ل.س') totalSYP += inv.amount;
        });

        const isEn = document.documentElement.getAttribute('lang') === 'en';
        if(selectors.mainBalance) selectors.mainBalance.textContent = `$${totalUSD.toFixed(2)} / ${totalSYP.toLocaleString()} ل.س`;
        if(selectors.mainFooterCount) selectors.mainFooterCount.textContent = isEn ? `${currentMonthData.length} receipts this month` : `${currentMonthData.length} إيصالات هذا الشهر`;
        if(selectors.dashboardTotalCount) selectors.dashboardTotalCount.textContent = isEn ? `total ${currentMonthData.length}` : `الإجمالي ${currentMonthData.length}`;

        // KPIs (desktop tiles)
        const totalCombinedUSD = totalUSD; // keep separate currencies explicit
        if (document.getElementById('kpi-total')) {
            document.getElementById('kpi-total').textContent = `$${totalUSD.toFixed(2)} / ${totalSYP.toLocaleString()} ل.س`;
        }
        if (document.getElementById('kpi-count')) {
            document.getElementById('kpi-count').textContent = `${currentMonthData.length}`;
        }
        if (document.getElementById('kpi-avg')) {
            const avgUSD = currentMonthData.filter(i=>i.currency==='$').reduce((s,i)=>s+i.amount,0);
            const avgSYP = currentMonthData.filter(i=>i.currency==='ل.س').reduce((s,i)=>s+i.amount,0);
            const avgText = currentMonthData.length ? `${(avgUSD/currentMonthData.length).toFixed(2)}$ / ${Math.round(avgSYP/currentMonthData.length).toLocaleString()} ل.س` : `$0.00 / 0 ل.س`;
            document.getElementById('kpi-avg').textContent = avgText;
        }

        // percent change vs previous month (hide when no prev data)
        try {
            const parts = activeMonthBucket.split(' ');
            const monthName = parts.slice(0, -1).join(' ') || parts[0];
            const year = parts[parts.length-1];
            const refDate = new Date(`${monthName} 1, ${year}`);
            refDate.setMonth(refDate.getMonth() - 1);
            const prevMonthBucket = refDate.toLocaleString('en', { month: 'long' }) + ' ' + refDate.getFullYear();
            const prevData = invoicesDatabase.filter(inv => inv.monthBucket === prevMonthBucket);
            const prevTotalUSD = prevData.filter(i=>i.currency==='$').reduce((s,i)=>s+i.amount,0);
            const prevTotalSYP = prevData.filter(i=>i.currency==='ل.س').reduce((s,i)=>s+i.amount,0);
            const currTotal = totalUSD + totalSYP; // coarse comparison (note: different currencies)
            const prevTotal = prevTotalUSD + prevTotalSYP;
            const changeEl = document.getElementById('kpi-change');
            if (changeEl) {
                if (!prevData.length || prevTotal === 0) {
                    changeEl.style.display = 'none';
                } else {
                    const pct = ((currTotal - prevTotal) / Math.abs(prevTotal)) * 100;
                    const sign = pct >= 0 ? '+' : '';
                    changeEl.textContent = `${sign}${pct.toFixed(1)}%`;
                    changeEl.style.display = 'block';
                    changeEl.style.color = pct >=0 ? 'var(--success)' : 'var(--danger)';
                }
            }
        } catch (e) {
            // silent
        }
    }

    function renderDatabaseInInterfaces() {
        if (!selectors.tableBody || !selectors.recentReceiptsList) return;

        updateDashboard();

        const isEn = document.documentElement.getAttribute('lang') === 'en';

        // Filtering: search, month, currency
        function getFilteredInvoices() {
            let list = Array.isArray(invoicesDatabase) ? invoicesDatabase.slice() : [];
            const search = selectors.tableSearch ? (selectors.tableSearch.value || '').trim().toLowerCase() : '';
            const monthSel = selectors.filterMonth ? selectors.filterMonth.value : 'current';
            const currencySel = selectors.filterCurrency ? selectors.filterCurrency.value : 'all';

            if (monthSel && monthSel !== 'all' && monthSel !== 'current') {
                list = list.filter(i => i.monthBucket === monthSel);
            } else if (monthSel === 'current') {
                list = list.filter(i => i.monthBucket === activeMonthBucket);
            }

            if (currencySel && currencySel !== 'all') {
                list = list.filter(i => i.currency === currencySel);
            }

            if (search) {
                list = list.filter(i => (i.name || '').toLowerCase().includes(search) || (i.category || '').toLowerCase().includes(search));
            }

            return list;
        }

        const currentMonthData = getFilteredInvoices();

        selectors.tableBody.innerHTML = '';
        selectors.recentReceiptsList.innerHTML = '';

        if (currentMonthData.length === 0) {
            if (selectors.dashboardEmptyState) selectors.dashboardEmptyState.style.display = 'flex';
            if (selectors.recentReceiptsList) selectors.recentReceiptsList.style.display = 'none';

            selectors.tableBody.innerHTML = `
                <tr id="no-data-row">
                    <td colspan="6" style="text-align: center; color: var(--text-muted); padding: 28px;">
                        <img class="table-empty-illustration" src="https://cdn.phototourl.com/free/2026-06-01-illustration-empty.png" alt="empty">
                        <div style="font-weight:700; margin-top:8px;">${isEn ? 'No invoices' : 'لا توجد فواتير'}</div>
                        <div style="margin-top:6px; color:var(--text-muted);">${isEn ? 'Use the camera or add a manual invoice to get started.' : 'استخدم الكاميرا أو أضف فاتورة يدوياً للبدء.'}</div>
                        <div style="margin-top:12px;"><button id="table-empty-add" class="empty-action-btn">${isEn ? 'Add Invoice' : 'أضف فاتورة'}</button></div>
                    </td>
                </tr>
            `;
            // hook add button
            setTimeout(() => {
                const btn = document.getElementById('table-empty-add');
                if (btn) btn.addEventListener('click', () => { if (selectors.fastManualBtn) selectors.fastManualBtn.click(); });
            }, 50);
        } else {
            if (selectors.dashboardEmptyState) selectors.dashboardEmptyState.style.display = 'none';
            if (selectors.recentReceiptsList) selectors.recentReceiptsList.style.display = 'flex';
        }

        currentMonthData.forEach(inv => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td style="white-space:nowrap;">${inv.date}</td>
                <td><strong>${inv.name}</strong></td>
                <td class="neon-text">${inv.amount.toFixed(2)}</td>
                <td>${inv.currency}</td>
                <td><span style="background:rgba(22,163,74,0.1); color:var(--primary-neon); padding:4px 8px; border-radius:8px; font-size:11px;">${inv.category}</span></td>
                <td>
                    <button class="action-btn edit-btn" ${isCurrentMonthLocked ? 'disabled' : ''} data-id="${inv.id}">
                        <span class="material-symbols-rounded" style="font-size:18px;">edit</span>
                    </button>
                    <button class="action-btn delete-btn" ${isCurrentMonthLocked ? 'disabled' : ''} data-id="${inv.id}">
                        <span class="material-symbols-rounded" style="font-size:18px;">delete</span>
                    </button>
                </td>
            `;
            selectors.tableBody.appendChild(tr);

            const card = document.createElement('div');
            card.className = 'recent-item';
            card.innerHTML = `
                <div>
                    <div class="recent-store">${inv.name}</div>
                    <div class="recent-date">${inv.date} • ${inv.category}</div>
                </div>
                <div style="display:flex; align-items:center; gap:8px;">
                    <div class="amount-accent">${inv.amount.toFixed(2)} ${inv.currency}</div>
                    <button class="recent-delete-btn" data-id="${inv.id}" title="حذف">
                        <span class="material-symbols-rounded" aria-hidden="true">delete</span>
                    </button>
                </div>
            `;
            selectors.recentReceiptsList.appendChild(card);
        });

        addTableActionsEventListeners();

        // recent list delete handlers
        document.querySelectorAll('.recent-delete-btn').forEach(btn => {
            btn.addEventListener('click', async (ev) => {
                ev.stopPropagation();
                const invId = btn.getAttribute('data-id');
                if (!invId) return;
                const isEn = document.documentElement.getAttribute('lang') === 'en';
                if (!confirm(isEn ? 'Delete this invoice?' : 'هل أنت متأكد من حذف هذه الفاتورة؟')) return;

                try {
                    await deleteInvoiceById(invId);
                    invoicesDatabase = await loadInvoices();
                    persistInvoicesToLocalStorage(invoicesDatabase);
                    renderDatabaseInInterfaces();
                } catch (err) {
                    console.error('Recent delete failed:', err);
                    alert(isEn ? 'Unexpected error while deleting.' : 'حدث خطأ غير متوقع أثناء الحذف.');
                }
            });
        });

        // populate month filter with available months
        function populateMonthFilter() {
            if (!selectors.filterMonth) return;
            const existing = selectors.filterMonth.value || 'current';
            const months = Array.from(new Set((invoicesDatabase||[]).map(i=>i.monthBucket))).sort((a,b)=>{ return new Date(b.split(' ').slice(0,2).join(' 1, ')) - new Date(a.split(' ').slice(0,2).join(' 1, ')); });
            selectors.filterMonth.innerHTML = '';
            const optCurrent = document.createElement('option'); optCurrent.value='current'; optCurrent.textContent = document.documentElement.getAttribute('lang')==='en' ? 'This month' : 'عرض هذا الشهر';
            selectors.filterMonth.appendChild(optCurrent);
            const optAll = document.createElement('option'); optAll.value='all'; optAll.textContent = document.documentElement.getAttribute('lang')==='en' ? 'All months' : 'كل الأشهر';
            selectors.filterMonth.appendChild(optAll);
            months.forEach(m => {
                const o = document.createElement('option'); o.value = m; o.textContent = m; selectors.filterMonth.appendChild(o);
            });
            // restore previous selection where possible
            try { selectors.filterMonth.value = existing; } catch(e){}
        }

        populateMonthFilter();

        if (selectors.tableSearch) selectors.tableSearch.addEventListener('input', () => renderDatabaseInInterfaces());
        if (selectors.filterMonth) selectors.filterMonth.addEventListener('change', () => renderDatabaseInInterfaces());
        if (selectors.filterCurrency) selectors.filterCurrency.addEventListener('change', () => renderDatabaseInInterfaces());

        // update stats panel
        try { populateStats(); } catch(e){}
    }

    function addTableActionsEventListeners() {
        document.querySelectorAll('.edit-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const invId = btn.getAttribute('data-id');
                const item = invoicesDatabase.find(inv => normalizeId(inv.id) === normalizeId(invId));
                if (item) openInvoiceModalForEdit(item);
            });
        });

        document.querySelectorAll('.delete-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (isCurrentMonthLocked) return;

                const invId = btn.getAttribute('data-id');
                if (!invId) return;

                const isEn = document.documentElement.getAttribute('lang') === 'en';
                if (!confirm(isEn ? 'Are you sure you want to delete this invoice?' : 'هل أنت متأكد من حذف هذه الفاتورة؟')) return;

                try {
                    await deleteInvoiceById(invId);

                    invoicesDatabase = await loadInvoices();
                    persistInvoicesToLocalStorage(invoicesDatabase);

                    renderDatabaseInInterfaces();
                } catch (err) {
                    console.error('Delete failed:', err);
                    alert(isEn ? 'Unexpected error while deleting.' : 'حدث خطأ غير متوقع أثناء الحذف.');
                }

            });
        });

    }

    if (selectors.simulateMonthChangeBtn) {
        selectors.simulateMonthChangeBtn.addEventListener('click', () => {
            isCurrentMonthLocked = !isCurrentMonthLocked;
            lockedMonths[activeMonthBucket] = isCurrentMonthLocked;
            localStorage.setItem(STORAGE_KEYS.lockedMonths, JSON.stringify(lockedMonths));
            updateMonthDisplayLabels();
            renderDatabaseInInterfaces();
            alert(isCurrentMonthLocked ? 'تم قفل الجدول وحفظ الميزانية بنجاح!' : 'تم إلغاء قفل الجدول بنشاط.');
        });
    }

    if(selectors.themeToggle) {
        const savedTheme = localStorage.getItem(STORAGE_KEYS.theme);
        if(savedTheme === 'light') {
            document.body.classList.remove('dark-mode');
            selectors.themeToggle.checked = false;
        }
        selectors.themeToggle.addEventListener('change', () => {
            if(selectors.themeToggle.checked) {
                document.body.classList.add('dark-mode');
                localStorage.setItem(STORAGE_KEYS.theme, 'dark');
            } else {
                document.body.classList.remove('dark-mode');
                localStorage.setItem(STORAGE_KEYS.theme, 'light');
            }
        });
    }

    function applyLocalization(lang) {
        document.documentElement.setAttribute('lang', lang);
        document.documentElement.setAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
        document.querySelectorAll('.lang-text').forEach(el => {
            const txt = el.getAttribute(`data-${lang}`);
            if(txt) el.textContent = txt;
        });
        renderDatabaseInInterfaces();
    }

    if(selectors.langRadios.length) {
        const savedLang = localStorage.getItem(STORAGE_KEYS.lang) || 'ar';
        selectors.langRadios.forEach(radio => {
            if(radio.value === savedLang) radio.checked = true;
            radio.addEventListener('change', () => {
                localStorage.setItem(STORAGE_KEYS.lang, radio.value);
                applyLocalization(radio.value);
            });
        });
        applyLocalization(savedLang);
    }

    if(selectors.clearDataBtn) {
        selectors.clearDataBtn.addEventListener('click', () => {
            if(confirm('هل تريد مسح كافة السجلات نهائياً؟')) {
                localStorage.clear();
                invoicesDatabase = [];
                lockedMonths = {};
                isCurrentMonthLocked = false;
                updateMonthDisplayLabels();
                renderDatabaseInInterfaces();
            }
        });
    }

    async function exportAllInvoicesAsJSON() {
        let rows = null;
        try {
            const db = await openIdb();
            rows = await new Promise((resolve) => {
                const tx = db.transaction(IDB.storeName, 'readonly');
                const store = tx.objectStore(IDB.storeName);
                const req = store.getAll();
                req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
                req.onerror = () => {
                    console.error('IndexedDB export getAll error:', req.error);
                    resolve(null);
                };
                tx.onabort = () => resolve(null);
            });
        } catch (e) {
            console.error('IndexedDB export failed:', e);
        }

        if (!Array.isArray(rows)) {
            rows = Array.isArray(invoicesDatabase) ? invoicesDatabase : [];
        }

        const payload = {
            app: 'SparFuchs',
            version: 1,
            exportedAt: new Date().toISOString(),
            invoices: rows
        };

        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);

        const link = document.createElement('a');
        link.download = 'SparFuchs-Invoices.json';
        link.href = url;
        link.click();

        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function mergeById(existing, incoming) {
        const map = new Map();
        (Array.isArray(existing) ? existing : []).forEach(item => {
            if (!item || item.id == null) return;
            map.set(normalizeId(item.id), item);
        });
        (Array.isArray(incoming) ? incoming : []).forEach(item => {
            if (!item || item.id == null) return;
            map.set(normalizeId(item.id), item);
        });
        return Array.from(map.values());
    }

    async function importInvoicesFromJSONFile(file) {
        const isEn = document.documentElement.getAttribute('lang') === 'en';

        if (!file) return;
        let text;
        try {
            text = await file.text();
        } catch (e) {
            alert(isEn ? 'Failed to read the file.' : 'تعذر قراءة ملف الاستيراد.');
            return;
        }

        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch (e) {
            alert(isEn ? 'Invalid JSON file.' : 'ملف JSON غير صالح.');
            return;
        }

        const incoming = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.invoices) ? parsed.invoices : []);
        if (!Array.isArray(incoming) || incoming.length === 0) {
            alert(isEn ? 'No invoices found in the file.' : 'لا توجد فواتير داخل الملف.');
            return;
        }

        try {
            const merged = mergeById(invoicesDatabase, incoming);

            const db = await openIdb();
            await new Promise((resolve, reject) => {
                const tx = db.transaction(IDB.storeName, 'readwrite');
                const store = tx.objectStore(IDB.storeName);

                incoming.forEach(inv => {
                    try { store.put(inv); } catch (e) { }
                });

                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error || new Error('IndexedDB import tx error'));
                tx.onabort = () => reject(tx.error || new Error('IndexedDB import tx aborted'));
            });

            invoicesDatabase = merged;
            persistInvoicesToLocalStorage(invoicesDatabase);
            renderDatabaseInInterfaces();

            alert(isEn ? 'Import completed successfully.' : 'تم الاستيراد بنجاح.');
        } catch (e) {
            console.error('Import failed:', e);
            invoicesDatabase = mergeById(invoicesDatabase, incoming);
            persistInvoicesToLocalStorage(invoicesDatabase);
            renderDatabaseInInterfaces();
            alert(isEn ? 'Import completed using fallback storage.' : 'اكتمل الاستيراد باستخدام التخزين الاحتياطي.');
        }
    }

    if (selectors.exportDataBtn) {
        selectors.exportDataBtn.addEventListener('click', () => {
            exportAllInvoicesAsJSON();
        });
    }

    if (selectors.importDataBtn && selectors.importDataInput) {
        selectors.importDataBtn.addEventListener('click', () => {
            selectors.importDataInput.value = '';
            selectors.importDataInput.click();
        });

        selectors.importDataInput.addEventListener('change', (e) => {
            const file = e.target && e.target.files ? e.target.files[0] : null;
            if (!file) return;
            importInvoicesFromJSONFile(file);
        });
    }

    // =========================================
    // Export Table To PDF (html2pdf.js)
    // =========================================
    function exportToPDF(options = {}) {
        // تحديد ID الجدول المطلوب تصديره
        const tableId = options.tableId || 'receipts-table';

        // تحديد اسم الملف الناتج
        const fileName = options.fileName || 'SparFuchs-Invoices.pdf';

        // جلب عنصر الجدول من الصفحة
        const tableEl = document.getElementById(tableId);

        // إذا لم يوجد الجدول نوقف العملية برسالة
        if (!tableEl) {
            const msg = document.documentElement.getAttribute('lang') === 'en'
                ? 'Table not found for PDF export.'
                : 'لم يتم العثور على الجدول للتصدير إلى PDF.';
            return alert(msg);
        }

        // التأكد أن مكتبة html2pdf.js محمّلة
        if (typeof html2pdf === 'undefined') {
            const msg = document.documentElement.getAttribute('lang') === 'en'
                ? 'html2pdf.js library not loaded.'
                : 'مكتبة html2pdf غير محمّلة.';
            return alert(msg);
        }

        // تحديد حاوية الجدول (للتعامل مع overflow/responsive بدون التأثير على الواجهة)
        const wrapperEl = tableEl.closest('.table-wrapper-container') || tableEl.parentElement;

        // حفظ قيم styles الحالية لإرجاعها بعد التصدير
        const originalWrapperOverflow = wrapperEl ? wrapperEl.style.overflow : '';
        const originalWrapperWidth = wrapperEl ? wrapperEl.style.width : '';

        const originalTableOverflow = tableEl.style.overflow;
        const originalTableDisplay = tableEl.style.display;
        const originalTableWidth = tableEl.style.width;

        // تجهيز متغير لإرجاع styles
        const restoreStyles = () => {
            if (wrapperEl) {
                wrapperEl.style.overflow = originalWrapperOverflow;
                wrapperEl.style.width = originalWrapperWidth;
            }
            tableEl.style.overflow = originalTableOverflow;
            tableEl.style.display = originalTableDisplay;
            tableEl.style.width = originalTableWidth;
        };

        try {
            // جعل الحاوية مرئية أثناء التصدير حتى لا يحدث قص للأعمدة
            if (wrapperEl) {
                wrapperEl.style.overflow = 'visible';
                wrapperEl.style.width = 'auto';
            }

            // إجبار الجدول ليظهر كـ table وبعرض كامل
            tableEl.style.overflow = 'visible';
            tableEl.style.display = 'table';
            tableEl.style.width = '100%';

            // إنشاء تحويل html -> PDF
            // ملاحظة دعم العربية: لديك already html[dir="rtl"], والـ CSS يستخدم نفس اتجاه الصفحة
            // لذلك html2pdf سيأخذ layout المناسب
            html2pdf()
                .set({
                    margin: [10, 10, 10, 10],
                    filename: fileName,
                    image: { type: 'jpeg', quality: 0.98 },
                    html2canvas: {
                        scale: 2,
                        letterRendering: true,
                        useCORS: true,
                        // تحديد خلفية ثابتة لتقليل مشاكل dark mode داخل canvas
                        backgroundColor: document.body.classList.contains('dark-mode') ? '#161920' : '#ffffff'
                    },
                    jsPDF: {
                        unit: 'mm',
                        format: 'a4',
                        orientation: 'landscape' // تقليل احتمال اقتطاع الأعمدة
                    },
                    pagebreak: {
                        // محاولة تجنب كسر الجدول/الصفوف بشكل يقطع أعمدة
                        mode: ['avoid-all', 'css', 'legacy']
                    }
                })
                .from(tableEl)
                .save()
                .then(() => {
                    // بعد نجاح الحفظ، نرجع الواجهة كما كانت
                    restoreStyles();
                })
                .catch((err) => {
                    // في حال الخطأ نرجع styles
                    console.error('exportToPDF error:', err);
                    restoreStyles();
                    const msg = document.documentElement.getAttribute('lang') === 'en'
                        ? 'Failed to export PDF.'
                        : 'فشل تصدير PDF.';
                    alert(msg);
                });

        } catch (err) {
            // في حال أي خطأ غير متوقع نرجع styles
            console.error('exportToPDF unexpected error:', err);
            restoreStyles();
            const msg = document.documentElement.getAttribute('lang') === 'en'
                ? 'Failed to export PDF.'
                : 'فشل تصدير PDF.';
            alert(msg);
        }
    }

    if (selectors.exportPngBtn) {
        selectors.exportPngBtn.addEventListener('click', () => {
            const targetArea = document.getElementById('repaint-boundary-area');
            if (!targetArea || typeof html2canvas === 'undefined') return alert('مكتبة التصدير غير جاهزة بعد');

            html2canvas(targetArea, {
                backgroundColor: document.body.classList.contains('dark-mode') ? '#161920' : '#ffffff',
                scale: 2
            }).then(canvas => {
                const link = document.createElement('a');
                link.download = `SparFuchs-Report.png`;
                link.href = canvas.toDataURL('image/png');
                link.click();
            });
        });
    }

    // ربط زر تحميل PDF
    if (selectors.downloadPdfBtn) {
        selectors.downloadPdfBtn.addEventListener('click', () => {
            exportToPDF({ tableId: 'receipts-table' });
        });
    }

    // =========================================
    // Export Table To PNG (html2canvas)
    // =========================================
    function exportToPNG(options = {}) {
        // تحديد ID الجدول المطلوب تصديره
        const tableId = options.tableId || 'receipts-table';

        // تحديد اسم الملف الناتج
        const fileName = options.fileName || 'SparFuchs-Report.png';

        // جلب عنصر الجدول من الصفحة
        const tableEl = document.getElementById(tableId);
        if (!tableEl) {
            const msg = document.documentElement.getAttribute('lang') === 'en'
                ? 'Table not found for PNG export.'
                : 'لم يتم العثور على الجدول للتصدير إلى صورة.';
            return alert(msg);
        }

        // تأكد أن مكتبة html2canvas متاحة
        if (typeof html2canvas === 'undefined') {
            const msg = document.documentElement.getAttribute('lang') === 'en'
                ? 'html2canvas library not loaded.'
                : 'مكتبة html2canvas غير محمّلة.';
            return alert(msg);
        }

        // نستخدم wrapper الخاص بالجدول لضمان التقاط كامل الأعمدة بدون القص بسبب overflow-x
        const wrapperEl = tableEl.closest('.table-wrapper-container') || tableEl.parentElement;

        // حفظ قيم styles الحالية (حتى لا تتأثر الواجهة)
        const originalOverflow = wrapperEl ? wrapperEl.style.overflow : '';

        try {
            // اجعل الحاوية مرئية وقت الالتقاط
            if (wrapperEl) {
                wrapperEl.style.overflow = 'visible';
            }

            return html2canvas(wrapperEl || tableEl, {
                backgroundColor: document.body.classList.contains('dark-mode') ? '#161920' : '#ffffff',
                scale: 2,
                useCORS: true
            }).then((canvas) => {
                const link = document.createElement('a');
                link.download = fileName;
                link.href = canvas.toDataURL('image/png');
                link.click();
            }).finally(() => {
                if (wrapperEl) wrapperEl.style.overflow = originalOverflow;
            });
        } catch (err) {
            console.error('exportToPNG error:', err);
            if (wrapperEl) wrapperEl.style.overflow = originalOverflow;
            const msg = document.documentElement.getAttribute('lang') === 'en'
                ? 'Failed to export PNG.'
                : 'فشل تصدير الصورة.';
            alert(msg);
        }
    }

    // ربط زر تحميل PNG
    const downloadPngBtn = document.getElementById('download-png-btn');
    if (downloadPngBtn) {
        downloadPngBtn.addEventListener('click', () => {
            exportToPNG({ tableId: 'receipts-table' });
        });
    }

    updateMonthDisplayLabels();

    loadInvoices()
        .then(rows => {
            invoicesDatabase = rows;
            persistInvoicesToLocalStorage(invoicesDatabase);
            renderDatabaseInInterfaces();
        })
        .catch(() => {
            renderDatabaseInInterfaces();
        });
});


