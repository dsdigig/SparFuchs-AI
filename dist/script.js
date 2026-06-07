document.addEventListener("DOMContentLoaded", () => {
    
    // ربط عناصر الواجهة والتحكم بـ DOM
    const navItems = document.querySelectorAll(".bottom-nav .nav-item");
    const screens = document.querySelectorAll(".screen");
    const cameraOverlay = document.getElementById("screen-camera-view");
    const triggerOcrBtn = document.getElementById("trigger-ocr-btn");
    const closeCameraBtn = document.getElementById("close-camera-btn");
    
    const tableBody = document.getElementById("table-body");
    const noDataRow = document.getElementById("no-data-row");
    const mainBalance = document.getElementById("main-balance");
    const mainFooterCount = document.getElementById("main-footer-count");
    const dashboardTotalCount = document.getElementById("dashboard-total-count");
    const dashboardEmptyState = document.getElementById("dashboard-empty-state");
    const recentReceiptsList = document.getElementById("recent-receipts-list");
    const tableMonthTitle = document.getElementById("table-month-title");
    const dashboardMonthLabel = document.getElementById("dashboard-month-label");
    const tableLockBadge = document.getElementById("table-lock-badge");

    // عناصر النافذة المنبثقة للـ Manual Add & Edit
    const invoiceModal = document.getElementById("invoice-modal");
    const closeInvoiceModalBtn = document.getElementById("close-modal-btn");
    const invoiceForm = document.getElementById("invoice-form");
    const fastManualBtn = document.getElementById("fast-manual-btn");
    const modalTitle = document.getElementById("modal-title");
    
    // عناصر المدخلات داخل الفلو الخاص بالنموذج
    const formInvoiceId = document.getElementById("edit-invoice-id");
    const formName = document.getElementById("form-name");
    const formAmount = document.getElementById("form-amount");
    const formCurrency = document.getElementById("form-currency");
    const formCategory = document.getElementById("form-category");
    const formDate = document.getElementById("form-date");
    const simulateMonthChangeBtn = document.getElementById("simulate-month-change-btn");

    // قاعدة بيانات الفواتير وحالة الشهر المالي الحالي
    let invoicesDatabase = [];
    let isCurrentMonthLocked = false; // تصبح true عند انتهاء الشهر لقفل التعديل نهائياً

    // تعيين التاريخ والشهر الافتراضي
    let activeMonthBucket = getCurrentMonthBucket();
    updateMonthDisplayLabels();

    // ضبط التاريخ الافتراضي اليوم داخل حقل إدخال النموذج
    if(formDate) formDate.value = new Date().toISOString().split('T')[0];

    // 1. نظام التنقل والتبديل الحركي الناعم بين الشاشات والصفحات
    navItems.forEach(item => {
        item.addEventListener("click", () => {
            const targetScreen = item.getAttribute("data-screen");
            navItems.forEach(nav => nav.classList.remove("active"));
            item.classList.add("active");
            screens.forEach(screen => {
                screen.classList.toggle("active", screen.id === targetScreen);
            });
        });
    });

    // 2. نظام الكاميرا والـ OCR الحية
    triggerOcrBtn.addEventListener("click", () => {
        if (isCurrentMonthLocked) {
            alert("هذا الشهر انتهى وتم قفله تلقائياً، يرجى بدء شهر مالي جديد لإضافة فواتير.");
            return;
        }
        cameraOverlay.style.display = "flex";
        setTimeout(() => {
            cameraOverlay.style.display = "none";
            executeGoogleMLKitOCR();
        }, 2000); 
    });

    closeCameraBtn.addEventListener("click", () => { cameraOverlay.style.display = "none"; });

    function executeGoogleMLKitOCR() {
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
        renderDatabaseInInterfaces();
    }

    // 3. نظام الإضافة اليدوية والتعديل (Manual Entry System)
    fastManualBtn.addEventListener("click", () => {
        if (isCurrentMonthLocked) { return alert("تم قفل جدول الشهر الحالي تلقائياً."); }
        openInvoiceModalForAdd();
    });

    closeInvoiceModalBtn.addEventListener("click", () => { invoiceModal.classList.remove("active"); });

    function openInvoiceModalForAdd() {
        modalTitle.textContent = document.documentElement.getAttribute("lang") === "en" ? "Add Invoice Manually" : "إضافة فاتورة يدوياً";
        formInvoiceId.value = "";
        invoiceForm.reset();
        formDate.value = new Date().toISOString().split('T')[0];
        invoiceModal.classList.add("active");
    }

    function openInvoiceModalForEdit(invoice) {
        modalTitle.textContent = document.documentElement.getAttribute("lang") === "en" ? "Edit Invoice" : "تعديل بيانات الفاتورة";
        formInvoiceId.value = invoice.id;
        formName.value = invoice.name;
        formAmount.value = invoice.amount;
        formCurrency.value = invoice.currency;
        formCategory.value = invoice.category;
        formDate.value = invoice.date;
        invoiceModal.classList.add("active");
    }

    invoiceForm.addEventListener("submit", (e) => {
        e.preventDefault();
        const idValue = formInvoiceId.value;
        
        if (idValue) {
            // منطق التعديل على الفاتورة قبل قفل الشهر
            const targetInv = invoicesDatabase.find(inv => inv.id === idValue);
            if (targetInv) {
                targetInv.name = formName.value;
                targetInv.amount = parseFloat(formAmount.value);
                targetInv.currency = formCurrency.value;
                targetInv.category = formCategory.value;
                targetInv.date = formDate.value;
            }
        } else {
            // منطق حفظ فاتورة يدوية جديدة
            const newInvoice = {
                id: 'inv_' + Date.now(),
                date: formDate.value,
                name: formName.value,
                amount: parseFloat(formAmount.value),
                currency: formCurrency.value,
                category: formCategory.value,
                monthBucket: activeMonthBucket
            };
            invoicesDatabase.push(newInvoice);
        }
        
        invoiceModal.classList.remove("active");
        renderDatabaseInInterfaces();
    });

    // 4. رسم وبناء الجداول والقوائم وتحديثها بالتزامن (Excel Architecture)
    function renderDatabaseInInterfaces() {
        tableBody.innerHTML = "";
        recentReceiptsList.innerHTML = "";

        const currentMonthData = invoicesDatabase.filter(inv => inv.monthBucket === activeMonthBucket);

        if (currentMonthData.length === 0) {
            if (noDataRow) noDataRow.style.display = "table-row";
            tableBody.appendChild(noDataRow);
            if (dashboardEmptyState) dashboardEmptyState.style.display = "flex";
        } else {
            if (noDataRow) noDataRow.style.display = "none";
            if (dashboardEmptyState) dashboardEmptyState.style.display = "none";

            currentMonthData.forEach(invoice => {
                // إضافة السطر بجدول الشهر النشط
                const tr = document.createElement("tr");
                tr.innerHTML = `
                    <td>${invoice.date}</td>
                    <td>${invoice.name}</td>
                    <td style="font-weight:700; color:#3ec4ca;">${invoice.amount.toLocaleString()}</td>
                    <td>${invoice.currency}</td>
                    <td><span style="background:rgba(62, 196, 202, 0.1); color:#3ec4ca; padding:4px 10px; border-radius:8px; font-size:11px; font-weight:500;">${invoice.category}</span></td>
                    <td>
                        <button class="action-btn edit-btn" data-id="${invoice.id}" ${isCurrentMonthLocked ? 'disabled' : ''}>
                            <span class="material-symbols-rounded" style="font-size:18px;">edit</span>
                        </button>
                        <button class="action-btn delete-btn" data-id="${invoice.id}" ${isCurrentMonthLocked ? 'disabled' : ''}>
                            <span class="material-symbols-rounded" style="font-size:18px;">delete</span>
                        </button>
                    </td>
                `;
                tableBody.appendChild(tr);

                // إضافة السطر لكارت الرئيسية
                const recentBox = document.createElement("div");
                recentBox.className = "recent-item";
                recentBox.innerHTML = `
                    <div class="recent-meta">
                        <span class="recent-store">${invoice.name}</span>
                        <span class="recent-date">${invoice.date} - ${invoice.category}</span>
                    </div>
                    <span class="amount-accent">${invoice.currency} ${invoice.amount.toLocaleString()}</span>
                `;
                recentReceiptsList.appendChild(recentBox);
            });

            // ربط أحداث أزرار التعديل والحذف ديناميكياً
            document.querySelectorAll(".edit-btn").forEach(btn => {
                btn.addEventListener("click", () => {
                    const invId = btn.getAttribute("data-id");
                    const foundInv = invoicesDatabase.find(inv => inv.id === invId);
                    if(foundInv) openInvoiceModalForEdit(foundInv);
                });
            });

            document.querySelectorAll(".delete-btn").forEach(btn => {
                btn.addEventListener("click", () => {
                    const invId = btn.getAttribute("data-id");
                    invoicesDatabase = invoicesDatabase.filter(inv => inv.id !== invId);
                    renderDatabaseInInterfaces();
                });
            });
        }

        updateApplicationCounters(currentMonthData);
    }

    function updateApplicationCounters(currentMonthData) {
        let totalUSD = 0, totalSYP = 0;
        currentMonthData.forEach(item => {
            if (item.currency === "$") totalUSD += item.amount;
            else if (item.currency === "ل.س") totalSYP += item.amount;
        });

        if(mainBalance) mainBalance.textContent = `$${totalUSD.toFixed(2)} / ${totalSYP.toLocaleString()} ل.س`;
        const currentLang = document.documentElement.getAttribute("lang") || "ar";
        if(mainFooterCount) mainFooterCount.textContent = currentLang === "ar" ? `${currentMonthData.length} إيصالات هذا الشهر` : `${currentMonthData.length} receipts this month`;
        if(dashboardTotalCount) dashboardTotalCount.textContent = currentLang === "ar" ? `الإجمالي ${currentMonthData.length}` : `total ${currentMonthData.length}`;
    }

    function getCurrentMonthBucket() {
        return new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    }

    function updateMonthDisplayLabels() {
        if(tableMonthTitle) tableMonthTitle.textContent = activeMonthBucket;
        if(dashboardMonthLabel) dashboardMonthLabel.textContent = activeMonthBucket;
    }

    // 5. محاكي إنهاء الشهر وقفل الجداول لبدء صفحة جديدة تلقائياً
    simulateMonthChangeBtn.addEventListener("click", () => {
        if(confirm("هل تريد محاكاة نهاية الشهر الحالي، قفل الجدول (Read-only) وفتح صفحة شهر جديد؟")) {
            isCurrentMonthLocked = true;
            tableLockBadge.style.display = "inline-block";
            
            // قفل كافة عناصر الواجهة الحالية لمنع التعديل نهائياً
            document.querySelectorAll(".edit-btn, .delete-btn").forEach(b => b.disabled = true);
            fastManualBtn.style.opacity = "0.4";
            
            alert(`تم قفل جدول شهر ${activeMonthBucket} بنجاح وتحويله لنمط تصدير وقراءة فقط!`);

            // إنشاء صفحة الشهر الجديد تلقائياً بعد ثانيتين كالفلاتر تماماً
            setTimeout(() => {
                isCurrentMonthLocked = false;
                tableLockBadge.style.display = "none";
                fastManualBtn.style.opacity = "1";
                
                // الانتقال للشهر المالي القادم افتراضياً
                activeMonthBucket = "June 2026"; 
                updateMonthDisplayLabels();
                renderDatabaseInInterfaces();
                alert(`أهلاً بك في جدول الشهر المالي الجديد: ${activeMonthBucket}`);
            }, 2000);
        }
    });

    // 6. التصدير والمشاركة الفورية كصورة PNG بجودة عالية
    document.getElementById("export-png-btn").addEventListener("click", () => {
        const areaToCapture = document.getElementById("repaint-boundary-area");
        html2canvas(areaToCapture, { 
            backgroundColor: document.body.classList.contains("dark-mode") ? "#161920" : "#ffffff",
            scale: 2 
        }).then(canvas => {
            const link = document.createElement("a");
            link.href = canvas.toDataURL("image/png");
            link.download = `SparFuchs_Table_${activeMonthBucket}.png`;
            link.click();
        });
    });

    // 7. إدارة اللغات والثيم الداكن والفاتح
    const langRadios = document.querySelectorAll('input[name="language"]');
    langRadios.forEach(radio => {
        radio.addEventListener("change", (e) => {
            const selectedLang = e.target.value;
            document.documentElement.setAttribute("dir", selectedLang === "ar" ? "rtl" : "ltr");
            document.documentElement.setAttribute("lang", selectedLang);
            document.querySelectorAll(".lang-text").forEach(el => {
                el.textContent = el.getAttribute(`data-${selectedLang}`);
            });
            renderDatabaseInInterfaces();
        });
    });

    document.getElementById("theme-toggle").addEventListener("change", (e) => {
        document.body.classList.toggle("dark-mode", e.target.checked);
    });

    document.getElementById("clear-data-btn").addEventListener("click", () => {
        if(confirm("هل أنت متأكد من مسح جميع بيانات الفواتير؟")) {
            invoicesDatabase = [];
            isCurrentMonthLocked = false;
            tableLockBadge.style.display = "none";
            fastManualBtn.style.opacity = "1";
            activeMonthBucket = getCurrentMonthBucket();
            updateMonthDisplayLabels();
            renderDatabaseInInterfaces();
        }
    });
});