import os
import cv2
import base64
import requests
import json
import sys

# ==========================================
# إعدادات مفتاح الاتصال بـ OpenAI API
# سيقرأ المفتاح من متغير البيئة OPENAI_API_KEY إذا لم يتم تغييره هنا
# ==========================================
API_KEY = os.getenv('OPENAI_API_KEY', '').strip()

# إذا أردت تستطيع وضع المفتاح هنا مباشرة (غير موصى به):
# API_KEY = "sk-..."

# ==========================================
# وظائف مساعدة
# ==========================================

def encode_image_to_base64(image, quality=70, max_width=1024):
    """تحويل الصورة إلى JPEG مضغوط ثم إلى Base64 لتقليل حجم التحميل"""
    h, w = image.shape[:2]
    if w > max_width:
        scale = max_width / float(w)
        image = cv2.resize(image, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)

    encode_param = [int(cv2.IMWRITE_JPEG_QUALITY), quality]
    success, buffer = cv2.imencode('.jpg', image, encode_param)
    if not success:
        raise RuntimeError('Failed to encode image to JPEG')
    return base64.b64encode(buffer).decode('utf-8')


def get_bill_data_from_ocr_space_from_image(image, api_key=None, language='ara', is_table=True, timeout=30, retries=3):
    """
    إرسال صورة إلى خدمة OCR.Space وإرجاع النص المستخرج بشكل منظم.

    المعاملات:
    - image: مصفوفة numpy (BGR) كما يتم الحصول عليها من OpenCV.
    - api_key: مفتاح API اختياري، سيتم قراءته من متغير البيئة `OCR_SPACE_API_KEY` إذا لم يُمرر.
    - language: رمز اللغة (الافتراضي 'ara').
    - is_table: حاول استخراج جداول إن وُجدت.
    - timeout: زمن الانتظار للطلب بالثواني.
    - retries: عدد محاولات إعادة المحاولة عند أخطاء مؤقتة.

    تُعيد dict يحتوي على أحد المفاتيح: `text` أو `error`، و`full` للاستجابة الخام.
    """
    api_key = api_key or os.getenv('OCR_SPACE_API_KEY', '').strip()
    if not api_key:
        return {'error': 'OCR.Space API key not set. Set OCR_SPACE_API_KEY env var or pass api_key.'}

    # تحويل الصورة إلى JPEG bytes
    encode_param = [int(cv2.IMWRITE_JPEG_QUALITY), 70]
    success, buffer = cv2.imencode('.jpg', image, encode_param)
    if not success:
        return {'error': 'Failed to encode image to JPEG'}

    img_bytes = buffer.tobytes()

    files = {'file': ('bill.jpg', img_bytes, 'image/jpeg')}
    payload = {
        'apikey': api_key,
        'language': language,
    }
    if is_table:
        payload['isTable'] = True

    # جلسة مع سياسات إعادة المحاولة
    session = requests.Session()
    try:
        from requests.adapters import HTTPAdapter
        from urllib3.util.retry import Retry

        retry_strategy = Retry(
            total=retries,
            backoff_factor=1,
            status_forcelist=[429, 500, 502, 503, 504],
            allowed_methods=["POST"],
        )
        adapter = HTTPAdapter(max_retries=retry_strategy)
        session.mount("https://", adapter)
        session.mount("http://", adapter)
    except Exception:
        # إذا لم تتوفر urllib3 أو فشلت الإعدادات، نتابع بدون retries المخصصة
        pass

    api_url = "https://api.ocr.space/parse/image"
    try:
        resp = session.post(api_url, files=files, data=payload, timeout=timeout)
        resp.raise_for_status()
        result = resp.json()

        if result.get("IsErroredOnProcessing") == False:
            parsed = result.get('ParsedResults') or []
            text = parsed[0].get('ParsedText') if parsed else ''
            return {'text': text, 'full': result}
        else:
            return {'error': result.get('ErrorMessage') or 'OCR processing error', 'full': result}

    except Exception as e:
        return {'error': str(e)}


def process_bill_with_vision_ai(image):
    """إرسال الصورة مع الأمر إلى واجهة الـ OpenAI (Chat Completions).
    ملاحظة: هذه دالة عامة وتعمل مع واجهات الـ Chat التقليدية.
    إذا أردت استخدام واجهة رؤية متقدمة خاصة، استبدل endpoint وpayload وفق توثيق OpenAI الحالي.
    """
    if not API_KEY:
        print("[-] خطأ: يرجى وضع مفتاح الـ API في متغير البيئة OPENAI_API_KEY أولاً.")
        return None

    try:
        base64_image = encode_image_to_base64(image)
    except Exception as e:
        print(f"[-] فشل في تشفير الصورة: {e}")
        return None

    ai_prompt = (
        "أنت نظام رؤية حاسوبية متقدم مخصص لتطبيق إدارة المصاريف والمالية.\n\n"
        "المهمة: حلل صورة الفاتورة المرفقة واستخرج الحقول التالية في JSON نظيف:\n"
        "- bill_name: اسم المتجر أو الشركة\n"
        "- total_amount: المبلغ الإجمالي كعدد عشري (مثال: 673600.0)\n"
        "- currency: رمز العملة القياسي (مثال: SYP, USD)\n"
        "- category: تصنيف الفاتورة (مثال: مواد غذائية, مطاعم)\n"
        "- date: تاريخ الفاتورة بصيغة YYYY-MM-DD\n\n"
        "تعليمات إضافية: قم بتنظيف الأرقام من فواصل الآلاف، وحوّل العملة إلى رمز قياسي إذا أمكن.\n"
        "أعد النتيجة بصيغة JSON فقط بدون أي شرح نصي أو علامات ترميز."
    )

    # نبني رسالة واحدة كبيرة تحتوي على البرومبت وصورة Base64 (كمحتوى نصي).
    # ملاحظة: بعض نماذج OpenAI قد لا تتعامل مع Base64 داخل النص بكفاءة.
    # إن كانت لديك واجهة رؤية مخصصة (مثل "vision" أو endpoints أحدث)، فاخترها بدلاً من ذلك.
    payload = {
        "model": "gpt-4o",
        "messages": [
            {
                "role": "user",
                "content": ai_prompt + "\n\n[[BASE64_IMAGE_START]]\n" + base64_image + "\n[[BASE64_IMAGE_END]]"
            }
        ],
        "temperature": 0.1,
        "max_tokens": 800
    }

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {API_KEY}"
    }

    url = "https://api.openai.com/v1/chat/completions"

    try:
        resp = requests.post(url, headers=headers, json=payload, timeout=60)
    except Exception as e:
        print(f"[-] خطأ في الاتصال بالـ API: {e}")
        return None

    if resp.status_code != 200:
        print(f"[-] استجابة خطأ من الخادم: {resp.status_code} - {resp.text}")
        return None

    try:
        response_json = resp.json()
    except Exception as e:
        print(f"[-] فشل في قراءة استجابة JSON: {e}")
        return None

    # محاولة استخراج المحتوى بطرق آمنة
    try:
        choice = response_json.get('choices', [])[0]
        # بعض الواجهات تستخدم 'message'، وبعضها 'text'
        message = choice.get('message') or {}
        raw_result = message.get('content') or choice.get('text') or ''
        raw_result = raw_result.strip()

        # تنظيف محاولات وضع ```json أو أقواس أخرى
        clean_json_str = raw_result.replace('```json', '').replace('```', '').strip()

        parsed_data = json.loads(clean_json_str)

    except Exception as e:
        print(f"[-] فشل في تحليل ناتج الذكاء الاصطناعي إلى JSON: {e}")
        print("--- Raw response start ---")
        print(resp.text)
        print("--- Raw response end ---")
        return None

    print("\n================ تم استخراج البيانات بنجاح ================")
    print(json.dumps(parsed_data, indent=4, ensure_ascii=False))
    print("=============================================================")

    return parsed_data


# ==========================================
# تشغيل الكاميرا والتحكم بالتقاط الصور
# ==========================================

def main():
    cap = cv2.VideoCapture(0)

    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)

    if not cap.isOpened():
        print("[-] فشل في فتح الكاميرا. تأكد من توصيلها وبرامج التشغيل.")
        sys.exit(1)

    print("[+] الكاميرا تعمل الآن بنجاح...")
    print("[+] ضع الفاتورة أمام الكاميرا، ثم اضغط على زر (Space) للتحليل والتعرف التلقائي.")
    print("[+] للخروج من البرنامج، اضغط على زر (ESC).")

    while True:
        ret, frame = cap.read()
        if not ret:
            print("[-] فشل في قراءة الفريم من الكاميرا.")
            break

        display_frame = frame.copy()
        h, w = display_frame.shape[:2]
        cv2.rectangle(display_frame, (int(w*0.15), int(h*0.08)), (int(w*0.85), int(h*0.92)), (0, 255, 0), 1)
        cv2.putText(display_frame, "SparFuchs AI: Place bill here & Press Space", (30, 40), 
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)

        cv2.imshow('SparFuchs AI - Live Camera Scanner', display_frame)

        k = cv2.waitKey(1)
        if k % 256 == 32:  # Space
            print("[*] جاري التقاط الفاتورة وإرسالها للتحليل الذكي المتوافق...")
            captured_bill = frame.copy()
            bill_data = process_bill_with_vision_ai(captured_bill)

            if bill_data:
                # طباعة الحقول الأساسية إذا وُجدت
                print('\n--- ملخص الفاتورة ---')
                print('اسم المتجر:', bill_data.get('bill_name'))
                print('المبلغ الإجمالي:', bill_data.get('total_amount'))
                print('العملة:', bill_data.get('currency'))
                print('التاريخ:', bill_data.get('date'))
                print('التصنيف:', bill_data.get('category'))
                print('---------------------\n')

        elif k % 256 == 27:  # ESC
            print("[*] جاري إغلاق الكاميرا وإنهاء البرنامج...")
            break

    cap.release()
    cv2.destroyAllWindows()


if __name__ == '__main__':
    main()
