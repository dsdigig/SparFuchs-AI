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
        exportPngBtn: document.getElementById("export-png-btn"),
        exportDataBtn: document.getElementById("export-data-btn"),
        importDataBtn: document.getElementById("import-data-btn"),
        importDataInput: document.getElementById("import-data-input"),
        themeToggle: document.getElementById("theme-toggle"),

        langRadios: document.querySelectorAll('input[name="language"]'),
        clearDataBtn: document.getElementById("clear-data-btn")
    };

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
        });
    }

    // 2. OCR mock
    if (selectors.triggerOcrBtn) {
        selectors.triggerOcrBtn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (isCurrentMonthLocked) {
                alert("هذا الشهر انتهى وتم قفله تلقائياً، يرجى بدء شهر مالي جديد لإضافة فواتير.");
                return;
            }
            if(selectors.cameraOverlay) selectors.cameraOverlay.style.display = "flex";
            setTimeout(() => {
                if(selectors.cameraOverlay) selectors.cameraOverlay.style.display = "none";
                executeGoogleMLKitOCR();
            }, 2000);
        });
    }

    if (selectors.closeCameraBtn) {
        selectors.closeCameraBtn.addEventListener("click", () => {
            if(selectors.cameraOverlay) selectors.cameraOverlay.style.display = "none";
        });
    }

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

    async function processInvoice(file) {
        const isEn = document.documentElement.getAttribute('lang') === 'en';
        try {
            if (!file) return;
            if (typeof Tesseract === 'undefined') {
                alert(isEn ? 'OCR library not loaded.' : 'مكتبة OCR غير محمّلة.');
                return;
            }

            showOcrMessage(isEn ? 'Processing invoice...' : 'جاري تحليل الفاتورة...');

            // Resize image for speed
            const imgBitmap = await createImageBitmap(file).catch(() => null);
            if (!imgBitmap) {
                // Fallback: use file directly
                imgBitmapFromFileFallback();
                return;
            }

            const maxWidth = 1200;
            const scale = imgBitmap.width > maxWidth ? maxWidth / imgBitmap.width : 1;
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(imgBitmap.width * scale);
            canvas.height = Math.round(imgBitmap.height * scale);
            const ctx = canvas.getContext('2d');
            ctx.drawImage(imgBitmap, 0, 0, canvas.width, canvas.height);

            const resizedBlob = await new Promise((resolve) => canvas.toBlob(resolve, file.type || 'image/jpeg', 0.92));
            const inputForTesseract = resizedBlob || file;

            const result = await Tesseract.recognize(inputForTesseract, 'eng', {
                logger: () => { /* progress UI could be added later */ }
            });

            const text = (result && result.data && result.data.text) ? result.data.text : '';

            // Extract total amount (supports Arabic/Western numbers with separators)
            // Examples: 1,234.56 or 1234.56 or ١٢٣٤٫٥٦
            const amountRegex = /(?:total\s*[:\u0660-\u0669]*|\b(?:amount|total)\b\s*[:\s]*)([\d.,]+|[\u0660-\u0669\u066b\u066c\.\,]+)/i;
            const amountRegexAlt = /([\d]{1,3}(?:[\d,]*[\d])(?:\.[\d]{1,2})?|[\d]+(?:\.[\d]{1,2})?)/;

            // Extract date (YYYY-MM-DD or DD/MM/YYYY or DD-MM-YYYY)
            const dateRegex = /(?:\b(\d{4}[-\/.]\d{1,2}[-\/.]\d{1,2})\b|\b(\d{1,2}[-\/.]\d{1,2}[-\/.]\d{4})\b)/;

            let extractedAmount = null;
            let extractedDate = null;

            const amountMatch = text.match(amountRegex) || text.match(amountRegexAlt);
            if (amountMatch && amountMatch[1]) {
                extractedAmount = amountMatch[1];
            }

            const dateMatch = text.match(dateRegex);
            if (dateMatch) {
                extractedDate = dateMatch[1] || dateMatch[2] || null;
            }

            // Normalize amount: keep digits and decimal dot.
            if (extractedAmount) {
                const normalized = String(extractedAmount)
                    .replace(/\s/g, '')
                    .replace(/[\u0660-\u0669]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
                    .replace(/,/g, '')
                    .replace(/\u066b|\u066c/g, '.');
                const asNumber = parseFloat(normalized);
                if (!Number.isNaN(asNumber)) {
                    if (selectors.formAmount) selectors.formAmount.value = asNumber.toFixed(2);
                }
            }

            // Normalize date to yyyy-mm-dd
            if (extractedDate && selectors.formDate) {
                const raw = String(extractedDate).trim();
                let iso = raw;
                if (/^\d{4}[-\/.]\d{1,2}[-\/.]\d{1,2}$/.test(raw)) {
                    iso = raw.replaceAll('/', '-').replaceAll('.', '-');
                } else {
                    const parts = raw.replaceAll('/', '-').replaceAll('.', '-').split('-');
                    if (parts.length === 3) {
                        const [a,b,c] = parts;
                        // assume DD-MM-YYYY or DD-MM-YYYY
                        iso = `${c}-${b.padStart(2,'0')}-${a.padStart(2,'0')}`;
                    }
                }
                selectors.formDate.value = iso;
            }

            if (selectors.formAmount && (!selectors.formAmount.value || selectors.formAmount.value === '')) {
                // do nothing; already set if successful
            }

            // show completion / allow user to review
            showOcrMessage(isEn ? 'Done. Review extracted data.' : 'تم. راجع البيانات المستخرجة.');
        } catch (e) {
            console.error('processInvoice error:', e);
            alert((document.documentElement.getAttribute('lang') === 'en') ? 'OCR failed.' : 'فشل تحليل OCR.');
        }

        function imgBitmapFromFileFallback() {
            // If resize fails, attempt direct OCR using file
            (async () => {
                try {
                    showOcrMessage(isEn ? 'Processing invoice...' : 'جاري تحليل الفاتورة...');
                    const result = await Tesseract.recognize(file, 'eng');
                    const text = result?.data?.text || '';
                    const amountMatch = text.match(/([\d.,]+)(?!.*\1)/);
                    const dateMatch = text.match(/(\d{4}[-\/.]\d{1,2}[-\/.]\d{1,2})|(\d{1,2}[-\/.]\d{1,2}[-\/.]\d{4})/);
                    if (amountMatch && selectors.formAmount) selectors.formAmount.value = parseFloat(String(amountMatch[1]).replace(/,/g,'')).toFixed(2);
                    if (dateMatch && selectors.formDate) selectors.formDate.value = (dateMatch[1] || dateMatch[2]).replaceAll('/', '-').replaceAll('.', '-');
                    showOcrMessage(isEn ? 'Done. Review extracted data.' : 'تم. راجع البيانات المستخرجة.');
                } catch (err) {
                    console.error(err);
                    alert((document.documentElement.getAttribute('lang') === 'en') ? 'OCR failed.' : 'فشل تحليل OCR.');
                }
            })();
        }
    }

    // Bind scan invoice button + file input
    if (selectors.scanInvoiceBtn && selectors.scanInvoiceFileInput) {
        selectors.scanInvoiceBtn.addEventListener('click', () => {
            try {
                // Ensure element is not blocked by overlay/focus
                selectors.scanInvoiceFileInput.value = '';
                selectors.scanInvoiceFileInput.click();
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
        selectors.fastManualBtn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (isCurrentMonthLocked) return alert("تم قفل جدول الشهر الحالي تلقائياً.");
            openInvoiceModalForAdd();
        });
    }

    if (selectors.closeInvoiceModalBtn) {
        selectors.closeInvoiceModalBtn.addEventListener("click", () => {
            if(selectors.invoiceModal) selectors.invoiceModal.classList.remove("active");
        });
    }

    function openInvoiceModalForAdd() {
        if(!selectors.invoiceModal) return;
        const isEn = document.documentElement.getAttribute("lang") === "en";
        if(selectors.modalTitle) selectors.modalTitle.textContent = isEn ? "Add Invoice Manually" : "إضافة فاتورة يدوياً";
        if(selectors.formInvoiceId) selectors.formInvoiceId.value = "";
        if(selectors.invoiceForm) selectors.invoiceForm.reset();
        if(selectors.formDate) selectors.formDate.value = new Date().toISOString().split('T')[0];
        selectors.invoiceModal.classList.add("active");
    }

    function openInvoiceModalForEdit(invoice) {
        if(!selectors.invoiceModal) return;
        const isEn = document.documentElement.getAttribute("lang") === "en";
        if(selectors.modalTitle) selectors.modalTitle.textContent = isEn ? "Edit Invoice" : "تعديل بيانات الفاتورة";
        if(selectors.formInvoiceId) selectors.formInvoiceId.value = invoice.id;
        if(selectors.formName) selectors.formName.value = invoice.name;
        if(selectors.formAmount) selectors.formAmount.value = invoice.amount;
        if(selectors.formCurrency) selectors.formCurrency.value = invoice.currency;
        if(selectors.formCategory) selectors.formCategory.value = invoice.category;
        if(selectors.formDate) selectors.formDate.value = invoice.date;
        selectors.invoiceModal.classList.add("active");
    }

    // Save form (insert/update) using IndexedDB (primary) + localStorage (fallback)
    if(selectors.invoiceForm) {
        selectors.invoiceForm.addEventListener("submit", async (e) => {
            e.preventDefault();
            console.log('Button clicked, starting submission...');

            // Rollback strategy: DB failures must NOT break the app.
            try {
                const name = selectors.formName ? selectors.formName.value : '';
                const amount = selectors.formAmount ? parseFloat(selectors.formAmount.value) : NaN;
                const currency = selectors.formCurrency ? selectors.formCurrency.value : '';
                const category = selectors.formCategory ? selectors.formCategory.value : '';
                const date = selectors.formDate ? selectors.formDate.value : '';
                const editId = selectors.formInvoiceId ? selectors.formInvoiceId.value : '';

                const isEdit = !!editId;

                if (Number.isNaN(amount)) throw new Error('Invalid amount');

                // Keep UI model shape consistent with existing code:
                // invoicesDatabase items expect: {id,date,name,amount,currency,category,monthBucket}
                const invoiceToWrite = {
                    id: isEdit ? editId : 'inv_' + Date.now(),
                    date,
                    name,
                    amount: Number(amount),
                    currency,
                    category,
                    monthBucket: activeMonthBucket
                };

                // Save primary (IndexedDB) else rollback to localStorage.
                await saveInvoice(invoiceToWrite);

                if (selectors.invoiceModal) selectors.invoiceModal.classList.remove("active");

                // Refresh UI from latest hybrid source.
                // If IndexedDB fails inside loadInvoices(), it will fallback to localStorage.
                invoicesDatabase = await loadInvoices();
                persistInvoicesToLocalStorage(invoicesDatabase);

                console.log(isEdit ? 'Success: Data updated' : 'Success: Data inserted');
                renderDatabaseInInterfaces();
            } catch (error) {
                console.error('Error occurred:', error);
                alert(document.documentElement.getAttribute("lang") === "en" ? "Unexpected error occurred." : "حدث خطأ غير متوقع.");
            }
        });
    }



    // 4. Render
    // updateDashboard
    // - يحسب الإجمالي/الرصيد بناءً على سجلات الشهر الحالي فقط.
    // - يحدّث DOM بدون إعادة بناء الجدول (لتحسين الأداء).
    function updateDashboard() {
        const currentMonthData = invoicesDatabase.filter(inv => inv.monthBucket === activeMonthBucket);

        let totalUSD = 0;
        let totalSYP = 0;

        currentMonthData.forEach(inv => {
            if (inv.currency === "$") totalUSD += inv.amount;
            else if (inv.currency === "ل.س") totalSYP += inv.amount;
        });

        const isEn = document.documentElement.getAttribute("lang") === "en";
        if(selectors.mainBalance) selectors.mainBalance.textContent = `$${totalUSD.toFixed(2)} / ${totalSYP.toLocaleString()} ل.س`;
        if(selectors.mainFooterCount) selectors.mainFooterCount.textContent = isEn ? `${currentMonthData.length} receipts this month` : `${currentMonthData.length} إيصالات هذا الشهر`;
        if(selectors.dashboardTotalCount) selectors.dashboardTotalCount.textContent = isEn ? `total ${currentMonthData.length}` : `الإجمالي ${currentMonthData.length}`;
    }

    function renderDatabaseInInterfaces() {
        if (!selectors.tableBody || !selectors.recentReceiptsList) return;

        // تحسب/تحدث dashboard بدون تعديل إضافي في DOM هنا
        updateDashboard();

        const currentMonthData = invoicesDatabase.filter(inv => inv.monthBucket === activeMonthBucket);

        const isEn = document.documentElement.getAttribute("lang") === "en";
        selectors.tableBody.innerHTML = "";
        selectors.recentReceiptsList.innerHTML = "";



        if (currentMonthData.length === 0) {
            if (selectors.dashboardEmptyState) selectors.dashboardEmptyState.style.display = "flex";
            if (selectors.recentReceiptsList) selectors.recentReceiptsList.style.display = "none";

            selectors.tableBody.innerHTML = `
                <tr id="no-data-row">
                    <td colspan="6" style="text-align: center; color: var(--text-muted); padding: 40px;">
                        <span>${isEn ? "No data in this month yet" : "لا توجد بيانات لهذا الشهر حتى الآن"}</span>
                    </td>
                </tr>
            `;
        } else {
            if (selectors.dashboardEmptyState) selectors.dashboardEmptyState.style.display = "none";
            if (selectors.recentReceiptsList) selectors.recentReceiptsList.style.display = "flex";
        }

        let totalUSD = 0;
        let totalSYP = 0;

        currentMonthData.forEach(inv => {
            if (inv.currency === "$") totalUSD += inv.amount;
            else if (inv.currency === "ل.س") totalSYP += inv.amount;

            const tr = document.createElement("tr");
            tr.innerHTML = `
                <td style="white-space:nowrap;">${inv.date}</td>
                <td><strong>${inv.name}</strong></td>
                <td class="neon-text">${inv.amount.toFixed(2)}</td>
                <td>${inv.currency}</td>
                <td><span style="background:rgba(62,196,202,0.1); color:var(--primary-neon); padding:4px 8px; border-radius:8px; font-size:11px;">${inv.category}</span></td>
                <td>
                    <button class="action-btn edit-btn" ${isCurrentMonthLocked ? 'disabled' : ''} data-id="${inv.id}">
                        <span class="material-symbols-outlined" style="font-size:18px;">edit</span>
                    </button>
                    <button class="action-btn delete-btn" ${isCurrentMonthLocked ? 'disabled' : ''} data-id="${inv.id}">
                        <span class="material-symbols-outlined" style="font-size:18px;">delete</span>
                    </button>
                </td>
            `;
            selectors.tableBody.appendChild(tr);

            const card = document.createElement("div");
            card.className = "recent-item";
            card.innerHTML = `
                <div>
                    <div class="recent-store">${inv.name}</div>
                    <div class="recent-date">${inv.date} • ${inv.category}</div>
                </div>
                <div class="amount-accent">${inv.amount.toFixed(2)} ${inv.currency}</div>
            `;
            selectors.recentReceiptsList.appendChild(card);
        });

        // تحديثات الـ dashboard تمت داخل updateDashboard() لتجنب حساب/تحديث إضافي.

        addTableActionsEventListeners();

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
                if (!confirm(isEn ? 'Delete this invoice?' : 'هل تريد حذف هذه الفاتورة؟')) return;

                try {
                    await deleteInvoiceById(invId);

                    invoicesDatabase = await loadInvoices();
                    persistInvoicesToLocalStorage(invoicesDatabase);

                    renderDatabaseInInterfaces();
                } catch (err) {
                    // Rollback strategy: do not break app.
                    console.error('Delete failed:', err);
                    alert(isEn ? 'Unexpected error while deleting.' : 'حدث خطأ غير متوقع أثناء الحذف.');
                }

            });
        });

    }

    // 5. Month lock simulation
    if (selectors.simulateMonthChangeBtn) {
        selectors.simulateMonthChangeBtn.addEventListener("click", () => {
            isCurrentMonthLocked = !isCurrentMonthLocked;
            lockedMonths[activeMonthBucket] = isCurrentMonthLocked;
            localStorage.setItem(STORAGE_KEYS.lockedMonths, JSON.stringify(lockedMonths));
            updateMonthDisplayLabels();
            renderDatabaseInInterfaces();
            alert(isCurrentMonthLocked ? "تم قفل الجدول وحفظ الميزانية بنجاح!" : "تم إلغاء قفل الجدول بنشاط.");
        });
    }

    // 6. Theme + language
    if(selectors.themeToggle) {
        const savedTheme = localStorage.getItem(STORAGE_KEYS.theme);
        if(savedTheme === "light") {
            document.body.classList.remove("dark-mode");
            selectors.themeToggle.checked = false;
        }
        selectors.themeToggle.addEventListener("change", () => {
            if(selectors.themeToggle.checked) {
                document.body.classList.add("dark-mode");
                localStorage.setItem(STORAGE_KEYS.theme, "dark");
            } else {
                document.body.classList.remove("dark-mode");
                localStorage.setItem(STORAGE_KEYS.theme, "light");
            }
        });
    }

    function applyLocalization(lang) {
        document.documentElement.setAttribute("lang", lang);
        document.documentElement.setAttribute("dir", lang === "ar" ? "rtl" : "ltr");
        document.querySelectorAll(".lang-text").forEach(el => {
            const txt = el.getAttribute(`data-${lang}`);
            if(txt) el.textContent = txt;
        });
        renderDatabaseInInterfaces();
    }

    if(selectors.langRadios.length) {
        const savedLang = localStorage.getItem(STORAGE_KEYS.lang) || "ar";
        selectors.langRadios.forEach(radio => {
            if(radio.value === savedLang) radio.checked = true;
            radio.addEventListener("change", () => {
                localStorage.setItem(STORAGE_KEYS.lang, radio.value);
                applyLocalization(radio.value);
            });
        });
        applyLocalization(savedLang);
    }

    if(selectors.clearDataBtn) {
        selectors.clearDataBtn.addEventListener("click", () => {
            if(confirm("هل تريد مسح كافة السجلات نهائياً؟")) {
                localStorage.clear();
                invoicesDatabase = [];
                lockedMonths = {};
                isCurrentMonthLocked = false;
                updateMonthDisplayLabels();
                renderDatabaseInInterfaces();
            }
        });
    }

    // 7. Export/Import (JSON)
    async function exportAllInvoicesAsJSON() {
        // Try IndexedDB primary first
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
            // Fallback to in-memory/latest hybrid
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
            map.set(normalizeId(item.id), item); // overwrite duplicates by id
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

        // Accept either {invoices:[...]} or raw array
        const incoming = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.invoices) ? parsed.invoices : []);
        if (!Array.isArray(incoming) || incoming.length === 0) {
            alert(isEn ? 'No invoices found in the file.' : 'لا توجد فواتير داخل الملف.');
            return;
        }

        try {
            // Merge with current in-memory + persist into IndexedDB (no deletions)
            const merged = mergeById(invoicesDatabase, incoming);

            // Primary: put everything into IndexedDB (duplicates will be overwritten by id)
            const db = await openIdb();
            await new Promise((resolve, reject) => {
                const tx = db.transaction(IDB.storeName, 'readwrite');
                const store = tx.objectStore(IDB.storeName);

                // Put incoming only (faster) to satisfy "merge" without wiping old ones.
                // But duplicates are handled by put(id).
                incoming.forEach(inv => {
                    try { store.put(inv); } catch (e) { /* ignore per-row put */ }
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
            // Fallback: merge in-memory + localStorage only
            invoicesDatabase = mergeById(invoicesDatabase, incoming);
            persistInvoicesToLocalStorage(invoicesDatabase);
            renderDatabaseInInterfaces();
            alert(isEn ? 'Import completed using fallback storage.' : 'اكتمل الاستيراد باستخدام التخزين الاحتياطي.');
        }
    }

    // JSON Export button
    if (selectors.exportDataBtn) {
        selectors.exportDataBtn.addEventListener('click', () => {
            exportAllInvoicesAsJSON();
        });
    }

    // JSON Import button
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

    // 7. Export PNG (existing)
    if (selectors.exportPngBtn) {
        selectors.exportPngBtn.addEventListener("click", () => {
            const targetArea = document.getElementById("repaint-boundary-area");
            if (!targetArea || typeof html2canvas === "undefined") return alert("مكتبة التصدير غير جاهزة بعد");

            html2canvas(targetArea, {
                backgroundColor: document.body.classList.contains("dark-mode") ? "#161920" : "#ffffff",
                scale: 2
            }).then(canvas => {
                const link = document.createElement("a");
                link.download = `SparFuchs-Report.png`;
                link.href = canvas.toDataURL("image/png");
                link.click();
            });
        });
    }

    updateMonthDisplayLabels();


    // initDB
    // - يقوم بتحميل الفواتير من IndexedDB (Primary) مع rollback إلى localStorage.
    // - عند اكتمال القراءة يتم تحديث الواجهة مرة واحدة فقط.
    loadInvoices()
        .then(rows => {
            invoicesDatabase = rows;

            // Hybrid: حافظ على localStorage كـ recovery/backup.
            persistInvoicesToLocalStorage(invoicesDatabase);

            renderDatabaseInInterfaces();
        })
        .catch(() => {
            // loadInvoices لا يفترض أن يَفشل (يرجع Array دائماً)،
            // لكن في حال حدوث شيء غير متوقع: نتابع بدون تعطل.
            renderDatabaseInInterfaces();
        });


});

