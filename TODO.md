# TODO

- [ ] تحديث src/script.js لتحويل CRUD من Supabase إلى IndexedDB.
- [ ] تطبيق نهج Rollback: عند فشل IndexedDB لا يتعطل التطبيق (console.error فقط) + fallback إلى localStorage.
- [ ] إنشاء دوال parallel داخل نفس الـ scope: `saveInvoice()` و `loadInvoices()`.
- [ ] الحفاظ على DOM IDs وعدم تعديل HTML/CSS.
- [ ] اختبار يدوي: إضافة/تعديل/حذف + محاكاة قفل الشهر + التصدير يجب أن يعمل.

